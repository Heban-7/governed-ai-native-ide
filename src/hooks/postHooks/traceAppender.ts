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
				model_version?: string
				agent_role?: string
				worker_id?: string
				supervisor_id?: string
			}
			ranges: TraceRange[]
			related: Array<{
				type: "specification" | "requirement" | "ticket" | "document"
				value: string
			}>
			meta: {
				mutation_class: "AST_REFACTOR" | "INTENT_EVOLUTION" | "UNKNOWN"
				mutation_confidence: "HIGH" | "MEDIUM" | "LOW"
				mutation_signals: string[]
				hook_invocation_id: string
			}
		}>
	}>
}

type RelatedReference = {
	type: "specification" | "requirement" | "ticket" | "document"
	value: string
}

function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/")
}

function getSessionPath(session: HookSession, key: "cwd" | "taskId" | "instanceId"): string | undefined {
	const anySession = session as Record<string, unknown>
	const value = anySession[key]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function getSessionField(
	session: HookSession,
	key: "modelIdentifier" | "modelVersion" | "agentRole" | "workerId" | "supervisorId",
): string | undefined {
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

function splitCsvOrArray(value: unknown): string[] {
	if (typeof value === "string") {
		return value
			.split(",")
			.map((v) => v.trim())
			.filter((v) => v.length > 0)
	}
	if (Array.isArray(value)) {
		return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
	}
	return []
}

function parseRelatedFromPayload(payload: Record<string, unknown>): RelatedReference[] {
	const related: RelatedReference[] = []

	const specIds = splitCsvOrArray(payload.related_specifications ?? payload.intent_ids)
	const requirementIds = splitCsvOrArray(payload.requirement_ids)
	const ticketIds = splitCsvOrArray(payload.ticket_ids)
	const docLinks = splitCsvOrArray(payload.requirement_links ?? payload.related_links)

	for (const id of specIds) {
		related.push({ type: "specification", value: id })
	}
	for (const id of requirementIds) {
		related.push({ type: "requirement", value: id })
	}
	for (const id of ticketIds) {
		related.push({ type: "ticket", value: id })
	}
	for (const link of docLinks) {
		related.push({ type: "document", value: link })
	}

	return related
}

function uniqRelated(items: RelatedReference[]): RelatedReference[] {
	const seen = new Set<string>()
	const out: RelatedReference[] = []
	for (const item of items) {
		const key = `${item.type}:${item.value}`
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		out.push(item)
	}
	return out
}

let intentMapCache:
	| {
			filePath: string
			mtimeMs: number
			intentDeps: Map<string, string[]>
	  }
	| undefined

async function readIntentDependencies(cwd: string): Promise<Map<string, string[]>> {
	const filePath = path.resolve(cwd, ".orchestration", "intent_map.md")
	let stat
	try {
		stat = await fs.stat(filePath)
	} catch {
		return new Map()
	}

	if (intentMapCache && intentMapCache.filePath === filePath && intentMapCache.mtimeMs === stat.mtimeMs) {
		return intentMapCache.intentDeps
	}

	const raw = await fs.readFile(filePath, "utf8")
	const lines = raw.split("\n")
	const intentDeps = new Map<string, string[]>()
	let currentIntentId: string | undefined
	let inDependsSection = false
	for (const line of lines) {
		const headingMatch = /^##\s+([A-Z]+-\d+)/.exec(line.trim())
		if (headingMatch) {
			currentIntentId = headingMatch[1]
			inDependsSection = false
			continue
		}
		if (!currentIntentId) {
			continue
		}
		if (line.toLowerCase().includes("**depends on:**")) {
			inDependsSection = true
			continue
		}
		if (inDependsSection && line.trim().startsWith("-")) {
			const ref = line.replace(/^-/, "").trim().replace(/`/g, "")
			if (ref.length > 0) {
				const existing = intentDeps.get(currentIntentId) ?? []
				existing.push(ref)
				intentDeps.set(currentIntentId, existing)
			}
			continue
		}
		if (inDependsSection && line.trim().length === 0) {
			inDependsSection = false
		}
	}

	intentMapCache = { filePath, mtimeMs: stat.mtimeMs, intentDeps }
	return intentDeps
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
	const payloadRelated = parseRelatedFromPayload(payload)
	const intentDeps = await readIntentDependencies(cwd)
	const dependencyRelated = (intentDeps.get(intentId) ?? []).map((id) => ({
		type: "specification" as const,
		value: id,
	}))
	const related = uniqRelated([{ type: "specification", value: intentId }, ...dependencyRelated, ...payloadRelated])
	const contributor = {
		entity_type: "AI" as const,
		model_identifier: getSessionField(context.session, "modelIdentifier") ?? "roo-code",
		model_version: getSessionField(context.session, "modelVersion"),
		agent_role: getSessionField(context.session, "agentRole"),
		worker_id: getSessionField(context.session, "workerId"),
		supervisor_id: getSessionField(context.session, "supervisorId"),
	}

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
					contributor,
					ranges: traceRanges,
					related,
					meta: {
						mutation_class: classification.mutationClass,
						mutation_confidence: classification.mutationConfidence,
						mutation_signals: classification.mutationSignals,
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
