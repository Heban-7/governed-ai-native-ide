import * as fs from "fs/promises"
import * as path from "path"

import type { PreHookFn } from "../hookEngine"
import { classifyCommand } from "../commandClassifier"

type CuratedContextSession = {
	cwd?: string
	getActiveIntentId?: () => string | undefined
	userMessageContent?: Array<{ type: "text"; text: string }>
}

type TraceSlice = {
	timestamp?: string
	file?: string
	mutation_class?: string
	related_values?: string[]
}

const contextCache = new Map<string, { mtimeMs: number; content: string }>()

function getPayloadAsRecord(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
}

function isMutatingTool(toolName: string): boolean {
	return new Set([
		"write_to_file",
		"apply_diff",
		"apply_patch",
		"edit",
		"search_and_replace",
		"search_replace",
		"edit_file",
	]).has(toolName)
}

async function readCachedFile(filePath: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(filePath)
		const cached = contextCache.get(filePath)
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			return cached.content
		}
		const content = await fs.readFile(filePath, "utf8")
		contextCache.set(filePath, { mtimeMs: stat.mtimeMs, content })
		return content
	} catch {
		return undefined
	}
}

function compactLines(lines: string[], maxLines: number): string {
	return lines
		.slice(-maxLines)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join("\n")
}

function parseRecentTrace(traceContent: string, intentId: string, maxEntries = 3): TraceSlice[] {
	const lines = traceContent
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
	const out: TraceSlice[] = []
	for (let i = lines.length - 1; i >= 0 && out.length < maxEntries; i--) {
		try {
			const parsed = JSON.parse(lines[i]) as {
				timestamp?: string
				files?: Array<{
					relative_path?: string
					conversations?: Array<{
						meta?: { mutation_class?: string }
						related?: Array<{ value?: string }>
					}>
				}>
			}
			for (const file of parsed.files ?? []) {
				const conversation = file.conversations?.[0]
				const relatedValues = (conversation?.related ?? []).map((r) => r.value).filter(Boolean) as string[]
				if (!relatedValues.includes(intentId)) {
					continue
				}
				out.push({
					timestamp: parsed.timestamp,
					file: file.relative_path,
					mutation_class: conversation?.meta?.mutation_class,
					related_values: relatedValues,
				})
				if (out.length >= maxEntries) {
					break
				}
			}
		} catch {
			// Skip malformed JSONL lines.
		}
	}
	return out
}

export const curateContextPreHook: PreHookFn = async (context) => {
	const classification = classifyCommand(context.toolName, context.payload)
	if (!isMutatingTool(classification.normalizedToolName)) {
		return { allow: true }
	}

	const session = context.session as CuratedContextSession
	if (!session.cwd || !session.userMessageContent) {
		return { allow: true }
	}

	// Prevent repeated curation spam for identical invocation/tool phase.
	const payloadRecord = getPayloadAsRecord(context.payload)
	const curationKey = `${context.invocationId}:${classification.normalizedToolName}`
	if ((payloadRecord._curated_context_key as string | undefined) === curationKey) {
		return { allow: true }
	}

	const intentId = session.getActiveIntentId?.() ?? "UNKNOWN"
	const orchestrationDir = path.resolve(session.cwd, ".orchestration")
	const intentMapPath = path.join(orchestrationDir, "intent_map.md")
	const tracePath = path.join(orchestrationDir, "agent_trace.jsonl")
	const failuresPath = path.join(orchestrationDir, "postprocess_failures.jsonl")

	const [intentMapRaw, traceRaw, failuresRaw] = await Promise.all([
		readCachedFile(intentMapPath),
		readCachedFile(tracePath),
		readCachedFile(failuresPath),
	])

	const intentSection =
		intentMapRaw && intentId !== "UNKNOWN"
			? (() => {
					const marker = `## ${intentId}`
					const lines = intentMapRaw.split("\n")
					const start = lines.findIndex((line) => line.startsWith(marker))
					if (start < 0) return undefined
					let end = lines.length
					for (let i = start + 1; i < lines.length; i++) {
						if (lines[i].startsWith("## ")) {
							end = i
							break
						}
					}
					return compactLines(lines.slice(start, end), 12)
				})()
			: undefined

	const recentTrace = traceRaw && intentId !== "UNKNOWN" ? parseRecentTrace(traceRaw, intentId, 3) : []
	const recentFailures = failuresRaw
		? failuresRaw
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.slice(-2)
		: []

	const curatedPayload = {
		intent_id: intentId,
		active_files: classification.affectedFiles.slice(0, 5),
		intent_map_slice: intentSection ?? "No matching intent_map section.",
		recent_trace: recentTrace,
		recent_failures: recentFailures,
	}

	session.userMessageContent.push({
		type: "text",
		text:
			"<curated_execution_context>\n" +
			JSON.stringify(curatedPayload, null, 2) +
			"\n</curated_execution_context>\n" +
			"Use this curated context for decision-making; avoid broad re-scans unless required.",
	})

	payloadRecord._curated_context_key = curationKey
	return { allow: true }
}
