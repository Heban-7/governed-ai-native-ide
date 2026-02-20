import * as fs from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"
import * as vscode from "vscode"
import * as diff from "diff"

import type { HookDecision, PreHookFn } from "../hookEngine"
import { classifyCommand } from "../commandClassifier"
import { computeContentHash } from "../../utils/computeContentHash"

type ScopeExpansionRequest = {
	additional_globs: string[]
	reason?: string
}

type ActiveIntentDoc = {
	active_intents?: Array<{
		id?: string
		owned_scope?: string[]
	}>
}

type IntentScopeCache = {
	filePath: string
	mtimeMs: number
	ownedScopeById: Map<string, string[]>
}

const approvedScopeExpansions = new Map<string, string[]>()
let intentScopeCache: IntentScopeCache | undefined

function toPosix(input: string): string {
	return input.replace(/\\/g, "/")
}

function globToRegex(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "§§DOUBLESTAR§§")
		.replace(/\*/g, "[^/]*")
		.replace(/§§DOUBLESTAR§§/g, ".*")
	return new RegExp(`^${escaped}$`)
}

function matchesAnyGlob(relativePath: string, globs: string[]): boolean {
	const p = toPosix(relativePath)
	return globs.some((glob) => globToRegex(toPosix(glob)).test(p))
}

async function readIntentScopes(cwd: string): Promise<Map<string, string[]>> {
	const candidates = [
		path.resolve(cwd, ".orchestration", "active_intents.yaml"),
		path.resolve(cwd, ".orchestration", "active_intents.yml"),
	]

	let target: string | undefined
	let stat: { mtimeMs: number } | undefined
	for (const candidate of candidates) {
		try {
			const s = await fs.stat(candidate)
			target = candidate
			stat = s
			break
		} catch {
			// continue
		}
	}

	if (!target || !stat) {
		return new Map()
	}

	if (intentScopeCache && intentScopeCache.filePath === target && intentScopeCache.mtimeMs === stat.mtimeMs) {
		return intentScopeCache.ownedScopeById
	}

	const raw = await fs.readFile(target, "utf8")
	const parsed = (yaml.parse(raw) as ActiveIntentDoc | undefined) ?? {}
	const ownedScopeById = new Map<string, string[]>()
	for (const entry of parsed.active_intents ?? []) {
		if (!entry?.id) continue
		const globs = Array.isArray(entry.owned_scope) ? entry.owned_scope.filter((g) => typeof g === "string") : []
		ownedScopeById.set(entry.id, globs)
	}

	intentScopeCache = {
		filePath: target,
		mtimeMs: stat.mtimeMs,
		ownedScopeById,
	}

	return ownedScopeById
}

function parseScopeExpansionRequest(payload: Record<string, unknown>): ScopeExpansionRequest | undefined {
	const raw = payload.request_scope_expansion
	if (!raw) return undefined
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw)
			if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).additional_globs)) {
				return {
					additional_globs: (parsed as any).additional_globs.filter((x: unknown) => typeof x === "string"),
					reason: typeof (parsed as any).reason === "string" ? (parsed as any).reason : undefined,
				}
			}
		} catch {
			return undefined
		}
	}
	if (typeof raw === "object" && raw !== null && Array.isArray((raw as any).additional_globs)) {
		return {
			additional_globs: (raw as any).additional_globs.filter((x: unknown) => typeof x === "string"),
			reason: typeof (raw as any).reason === "string" ? (raw as any).reason : undefined,
		}
	}
	return undefined
}

function buildScopeViolationError(params: {
	invocationId: string
	intentId?: string
	toolName: string
	filePath: string
	ownedScope: string[]
}): string {
	return JSON.stringify({
		type: "tool_error",
		code: "SCOPE_VIOLATION",
		message: `Scope violation: intent '${params.intentId ?? "UNKNOWN"}' is not authorized to edit '${params.filePath}'. Request scope expansion.`,
		meta: {
			invocation_id: params.invocationId,
			intent_id: params.intentId,
			tool_name: params.toolName,
			file_path: params.filePath,
			owned_scope: params.ownedScope,
			request_scope_expansion: {
				type: "request_scope_expansion",
				required: true,
				schema: {
					additional_globs: ["string"],
					reason: "string",
				},
				example: {
					type: "request_scope_expansion",
					intent_id: params.intentId ?? "INT-001",
					additional_globs: [path.dirname(params.filePath).replace(/\\/g, "/") + "/**"],
					reason: "Need to edit related middleware and tests for this intent.",
				},
			},
		},
	})
}

function buildStaleFileError(params: {
	invocationId: string
	intentId?: string
	toolName: string
	filePath: string
	observedHash: string
	currentHash: string
	currentDiff?: string
}): string {
	return JSON.stringify({
		type: "tool_error",
		code: "STALE_FILE",
		message:
			"Stale file detected: current file content hash does not match observed_content_hash. Re-read the file and recalculate your patch.",
		meta: {
			invocation_id: params.invocationId,
			intent_id: params.intentId,
			tool_name: params.toolName,
			file_path: params.filePath,
			observed_content_hash: params.observedHash,
			current_content_hash: params.currentHash,
			current_diff: params.currentDiff ?? "",
		},
	})
}

function buildCurrentDiffPreview(filePath: string, currentContent: string, proposed?: string): string {
	if (typeof proposed !== "string" || proposed.length === 0) {
		return "No proposed content provided."
	}
	const patch = diff.createPatch(toPosix(filePath), currentContent, proposed, undefined, undefined, { context: 2 })
	return patch.split("\n").slice(0, 80).join("\n")
}

function getPayloadObject(payload: unknown): Record<string, unknown> {
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

export const scopeAndLockPreHook: PreHookFn = async (context): Promise<HookDecision> => {
	const classification = classifyCommand(context.toolName, context.payload)
	const payload = getPayloadObject(context.payload)

	if (!isMutatingTool(classification.normalizedToolName)) {
		return { allow: true }
	}

	const cwd = context.session.cwd
	if (!cwd) {
		return { allow: true }
	}

	const intentId = context.session.getActiveIntentId?.()
	const affectedFiles = classification.affectedFiles
	if (!intentId || affectedFiles.length === 0) {
		return { allow: true }
	}

	const ownedScopeById = await readIntentScopes(cwd)
	const baseOwnedScope = ownedScopeById.get(intentId) ?? []
	const expansions = approvedScopeExpansions.get(intentId) ?? []
	const effectiveScope = [...baseOwnedScope, ...expansions]

	for (const affectedFile of affectedFiles) {
		const relativePath = path.isAbsolute(affectedFile)
			? toPosix(path.relative(cwd, affectedFile))
			: toPosix(affectedFile)
		const inScope = effectiveScope.length > 0 && matchesAnyGlob(relativePath, effectiveScope)
		if (!inScope) {
			const expansionRequest = parseScopeExpansionRequest(payload)
			if (expansionRequest && expansionRequest.additional_globs.length > 0) {
				const detail =
					`Intent: ${intentId}\n` +
					`Target: ${relativePath}\n` +
					`Current scope: ${effectiveScope.join(", ") || "(none)"}\n` +
					`Requested expansion: ${expansionRequest.additional_globs.join(", ")}\n` +
					`Reason: ${expansionRequest.reason ?? "(none)"}`
				const decision = await vscode.window.showWarningMessage(
					"Scope expansion requested for out-of-scope write. Approve?",
					{ modal: true, detail },
					"Approve Expansion",
					"Reject",
				)
				if (decision === "Approve Expansion") {
					const merged = [
						...new Set([
							...(approvedScopeExpansions.get(intentId) ?? []),
							...expansionRequest.additional_globs,
						]),
					]
					approvedScopeExpansions.set(intentId, merged)
					return { allow: true }
				}
			}

			context.pushToolResult?.(
				buildScopeViolationError({
					invocationId: context.invocationId,
					intentId,
					toolName: classification.normalizedToolName,
					filePath: relativePath,
					ownedScope: effectiveScope,
				}),
			)
			return { allow: false, alreadyReported: true }
		}
	}

	// Optimistic locking: agent must provide observed_content_hash for mutating writes.
	const observedHash =
		typeof payload.observed_content_hash === "string" ? payload.observed_content_hash.trim() : undefined

	if (!observedHash) {
		return { allow: true }
	}

	// Compare against current file hash before execution.
	for (const affectedFile of affectedFiles) {
		const absolutePath = path.isAbsolute(affectedFile) ? affectedFile : path.resolve(cwd, affectedFile)
		let currentContent: string
		try {
			currentContent = await fs.readFile(absolutePath, "utf8")
		} catch {
			continue
		}

		const currentHash = computeContentHash({
			filePath: absolutePath,
			fileContent: currentContent,
		}).contentHash

		if (currentHash !== observedHash) {
			const proposedContent = typeof payload.content === "string" ? payload.content : undefined
			const diffPreview = buildCurrentDiffPreview(affectedFile, currentContent, proposedContent)
			context.pushToolResult?.(
				buildStaleFileError({
					invocationId: context.invocationId,
					intentId,
					toolName: classification.normalizedToolName,
					filePath: toPosix(path.isAbsolute(affectedFile) ? path.relative(cwd, affectedFile) : affectedFile),
					observedHash,
					currentHash,
					currentDiff: diffPreview,
				}),
			)
			return { allow: false, alreadyReported: true }
		}
	}

	return { allow: true }
}
