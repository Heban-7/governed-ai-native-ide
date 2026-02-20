import * as fs from "fs/promises"
import * as path from "path"
import { execFileSync } from "child_process"

import type { PostHookFn, HookSession } from "../hookEngine"
import { classifyCommand } from "../commandClassifier"
import { computeContentHash, type ModifiedRange } from "../../utils/computeContentHash"

type TraceRange = {
	start_line: number
	end_line: number
	content_hash: string
}

type TraceRecord = {
	id: string
	timestamp: string
	vcs: { revision_id: string }
	files: Array<{
		relative_path: string
		conversations: Array<{
			url: string
			contributor: {
				entity_type: "AI"
				model_identifier: string
			}
			ranges: TraceRange[]
			related: Array<{
				type: "specification"
				value: string
			}>
			meta: {
				mutation_class: "AST_REFACTOR" | "INTENT_EVOLUTION" | "UNKNOWN"
				hook_invocation_id: string
			}
		}>
	}>
}

function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/")
}

function getSessionPath(session: HookSession, key: "cwd" | "taskId" | "instanceId"): string | undefined {
	const anySession = session as Record<string, unknown>
	const value = anySession[key]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function countLines(content: string): number {
	if (!content) return 1
	return content.split("\n").length
}

function parseUnifiedDiffRanges(diffText: string): ModifiedRange[] {
	const ranges: ModifiedRange[] = []
	const hunkRegex = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm
	let match: RegExpExecArray | null
	while ((match = hunkRegex.exec(diffText)) !== null) {
		const start = Number(match[1])
		const count = match[2] ? Number(match[2]) : 1
		const end = Math.max(start, start + Math.max(1, count) - 1)
		ranges.push({ startLine: start, endLine: end })
	}
	return ranges
}

function rangeFromNewString(fileContent: string, newString: string): ModifiedRange | undefined {
	if (!newString || !newString.trim()) {
		return undefined
	}
	const index = fileContent.indexOf(newString)
	if (index < 0) {
		return undefined
	}
	const before = fileContent.slice(0, index)
	const snippet = fileContent.slice(index, index + newString.length)
	const startLine = before.split("\n").length
	const endLine = startLine + snippet.split("\n").length - 1
	return { startLine, endLine }
}

function getRevisionId(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()
	} catch {
		return "UNKNOWN"
	}
}

function buildConversationUrl(session: HookSession): string {
	const taskId = getSessionPath(session, "taskId")
	const instanceId = getSessionPath(session, "instanceId")
	if (taskId && instanceId) {
		return `roo://task/${taskId}/instance/${instanceId}`
	}
	if (taskId) {
		return `roo://task/${taskId}`
	}
	return "roo://task/unknown"
}

async function deriveRanges(
	toolName: string,
	payload: Record<string, unknown>,
	fileContent: string,
): Promise<ModifiedRange[]> {
	if (toolName === "write_to_file") {
		return [{ startLine: 1, endLine: countLines(fileContent) }]
	}

	if (toolName === "apply_diff" && typeof payload.diff === "string") {
		const parsed = parseUnifiedDiffRanges(payload.diff)
		if (parsed.length > 0) {
			return parsed
		}
	}

	if (toolName === "apply_patch" && typeof payload.patch === "string") {
		const parsed = parseUnifiedDiffRanges(payload.patch)
		if (parsed.length > 0) {
			return parsed
		}
	}

	const newString = typeof payload.new_string === "string" ? payload.new_string : ""
	const fromNewString = rangeFromNewString(fileContent, newString)
	if (fromNewString) {
		return [fromNewString]
	}

	return [{ startLine: 1, endLine: countLines(fileContent) }]
}

export const traceAppenderPostHook: PostHookFn = async (context) => {
	// Only trace successful tool executions.
	if (!context.allowed || context.error) {
		return
	}

	const classification = classifyCommand(context.toolName, context.payload)
	if (classification.risk !== "DESTRUCTIVE") {
		return
	}

	const cwd = getSessionPath(context.session, "cwd")
	if (!cwd) {
		return
	}

	const payload = (
		context.payload && typeof context.payload === "object" ? (context.payload as Record<string, unknown>) : {}
	) as Record<string, unknown>

	const affectedFiles = classification.affectedFiles
	if (affectedFiles.length === 0) {
		return
	}

	const revisionId = getRevisionId(cwd)
	const conversationUrl = buildConversationUrl(context.session)
	const intentId = context.session.getActiveIntentId?.() ?? "UNKNOWN"

	const fileRecords: TraceRecord["files"] = []

	for (const relativePath of affectedFiles) {
		const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.resolve(cwd, relativePath)
		let fileContent: string
		try {
			fileContent = await fs.readFile(absolutePath, "utf8")
		} catch {
			// Skip files that do not exist after execution.
			continue
		}

		const ranges = await deriveRanges(classification.normalizedToolName, payload, fileContent)
		const traceRanges: TraceRange[] = ranges.map((range) => {
			const insertedContent = typeof payload.content === "string" ? payload.content : undefined
			const hash = computeContentHash({
				filePath: absolutePath,
				fileContent,
				modifiedRange: range,
				insertedContent,
			})
			return {
				start_line: range.startLine,
				end_line: range.endLine,
				content_hash: hash.contentHash,
			}
		})

		fileRecords.push({
			relative_path: path.isAbsolute(relativePath)
				? toPosixPath(path.relative(cwd, relativePath))
				: toPosixPath(relativePath),
			conversations: [
				{
					url: conversationUrl,
					contributor: {
						entity_type: "AI",
						model_identifier: "roo-code",
					},
					ranges: traceRanges,
					related: [{ type: "specification", value: intentId }],
					meta: {
						mutation_class: classification.mutationClass,
						hook_invocation_id: context.invocationId,
					},
				},
			],
		})
	}

	if (fileRecords.length === 0) {
		return
	}

	const traceRecord: TraceRecord = {
		id: context.invocationId,
		timestamp: new Date().toISOString(),
		vcs: { revision_id: revisionId },
		files: fileRecords,
	}

	const orchestrationDir = path.resolve(cwd, ".orchestration")
	const ledgerPath = path.join(orchestrationDir, "agent_trace.jsonl")
	await fs.mkdir(orchestrationDir, { recursive: true })

	// Append strategy for JSONL: one atomic append call per record line.
	await fs.appendFile(ledgerPath, `${JSON.stringify(traceRecord)}\n`, "utf8")
}
