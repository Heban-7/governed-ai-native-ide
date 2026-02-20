import * as fs from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"

import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"

type SelectActiveIntentParams = {
	intent_id: string
}

type ActiveIntent = {
	id: string
	owned_scope?: string[]
	constraints?: string[]
	acceptance_criteria?: string[]
}

type ActiveIntentCache = {
	filePath: string
	mtimeMs: number
	intentsById: Map<string, ActiveIntent>
}

function normalizeShortList(input: unknown, maxItems = 5, maxChars = 180): string[] {
	if (!Array.isArray(input)) {
		return []
	}

	return input
		.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
		.map((v) => v.trim().replace(/\s+/g, " "))
		.slice(0, maxItems)
		.map((v) => (v.length > maxChars ? `${v.slice(0, maxChars - 3)}...` : v))
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;")
}

function renderIntentContext(intent: ActiveIntent): string {
	const ownedScope = normalizeShortList(intent.owned_scope, 15, 260)
	const constraints = normalizeShortList(intent.constraints, 5, 180)
	const acceptanceCriteria = normalizeShortList(intent.acceptance_criteria, 5, 180)

	const ownedScopeXml = ownedScope.length
		? ownedScope.map((scope) => `    <glob>${xmlEscape(scope)}</glob>`).join("\n")
		: "    <glob></glob>"

	const constraintsXml = constraints.length
		? constraints.map((item) => `    <item>${xmlEscape(item)}</item>`).join("\n")
		: "    <item></item>"

	const acceptanceXml = acceptanceCriteria.length
		? acceptanceCriteria.map((item) => `    <item>${xmlEscape(item)}</item>`).join("\n")
		: "    <item></item>"

	return [
		"<intent_context>",
		`  <id>${xmlEscape(intent.id)}</id>`,
		"  <owned_scope>",
		ownedScopeXml,
		"  </owned_scope>",
		"  <constraints>",
		constraintsXml,
		"  </constraints>",
		"  <acceptance_criteria>",
		acceptanceXml,
		"  </acceptance_criteria>",
		"</intent_context>",
	].join("\n")
}

export class SelectActiveIntentTool extends BaseTool<"select_active_intent"> {
	readonly name = "select_active_intent" as const

	private static cache: ActiveIntentCache | undefined

	private async loadActiveIntents(filePath: string): Promise<Map<string, ActiveIntent>> {
		const stat = await fs.stat(filePath)
		const cached = SelectActiveIntentTool.cache

		// Minimal cache: re-read only when file mtime changes.
		if (cached && cached.filePath === filePath && cached.mtimeMs === stat.mtimeMs) {
			return cached.intentsById
		}

		const rawYaml = await fs.readFile(filePath, "utf8")
		const parsed = yaml.parse(rawYaml) as { active_intents?: unknown } | undefined
		const activeIntents = Array.isArray(parsed?.active_intents) ? parsed!.active_intents : []

		const intentsById = new Map<string, ActiveIntent>()
		for (const rawIntent of activeIntents) {
			if (!rawIntent || typeof rawIntent !== "object") {
				continue
			}
			const candidate = rawIntent as Record<string, unknown>
			const id = typeof candidate.id === "string" ? candidate.id.trim() : ""
			if (!id) {
				continue
			}
			intentsById.set(id, {
				id,
				owned_scope: normalizeShortList(candidate.owned_scope, 25, 260),
				constraints: normalizeShortList(candidate.constraints, 10, 220),
				acceptance_criteria: normalizeShortList(candidate.acceptance_criteria, 10, 220),
			})
		}

		SelectActiveIntentTool.cache = {
			filePath,
			mtimeMs: stat.mtimeMs,
			intentsById,
		}

		return intentsById
	}

	async execute(params: SelectActiveIntentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { intent_id } = params
		const { pushToolResult } = callbacks

		if (!intent_id?.trim()) {
			task.consecutiveMistakeCount++
			task.recordToolError("select_active_intent")
			pushToolResult(await task.sayAndCreateMissingParamError("select_active_intent", "intent_id"))
			return
		}

		const orchestrationDir = path.resolve(task.cwd, ".orchestration")
		const candidates = [
			path.join(orchestrationDir, "active_intents.yaml"),
			path.join(orchestrationDir, "active_intents.yml"),
		]

		let targetFile: string | undefined
		for (const candidate of candidates) {
			try {
				await fs.access(candidate)
				targetFile = candidate
				break
			} catch {
				// Keep scanning fallback paths.
			}
		}

		if (!targetFile) {
			task.consecutiveMistakeCount++
			task.recordToolError("select_active_intent")
			pushToolResult(
				`Handshake failed: .orchestration/active_intents.yaml was not found in '${task.cwd}'. ` +
					`Create it before calling select_active_intent.`,
			)
			return
		}

		const intentsById = await this.loadActiveIntents(targetFile)
		const selectedIntent = intentsById.get(intent_id)

		if (!selectedIntent) {
			task.consecutiveMistakeCount++
			task.recordToolError("select_active_intent")
			pushToolResult(
				`Handshake failed: intent_id '${intent_id}' does not exist in ${path.basename(targetFile)}. ` +
					`Use a valid active intent ID.`,
			)
			return
		}

		const intentContext = renderIntentContext(selectedIntent)
		task.setActiveIntentContext(selectedIntent.id, intentContext)
		task.consecutiveMistakeCount = 0

		pushToolResult(intentContext)
	}
}

export const selectActiveIntentTool = new SelectActiveIntentTool()
