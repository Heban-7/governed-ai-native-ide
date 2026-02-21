import crypto from "crypto"

import type { AskApproval, HandleError, PushToolResult } from "../shared/tools"
import { hitlPreHook } from "./preHooks/hitl"
import { classifyCommand } from "./commandClassifier"
import { traceAppenderPostHook } from "./postHooks/traceAppender"
import { scopeAndLockPreHook } from "./preHooks/scopeAndLock"
import { postprocessPostHook } from "./postHooks/postprocess"
import { curateContextPreHook } from "./preHooks/context-curation"

export type HookDecision = {
	allow: boolean
	reason?: string
	alreadyReported?: boolean
}

export type HookSession = {
	hasActiveIntentContext?: () => boolean
	getActiveIntentId?: () => string | undefined
	cwd?: string
	taskId?: string
	instanceId?: string
	modelIdentifier?: string
	modelVersion?: string
	agentRole?: string
	supervisorId?: string
	workerId?: string
}

export type HookContext = {
	invocationId: string
	toolName: string
	payload: unknown
	session: HookSession
	askApproval?: AskApproval
	pushToolResult?: PushToolResult
	handleError?: HandleError
}

export type PostHookContext = HookContext & {
	allowed: boolean
	result?: unknown
	error?: Error
}

export type PreHookFn = (context: HookContext) => Promise<HookDecision | void> | HookDecision | void
export type PostHookFn = (context: PostHookContext) => Promise<void> | void

const preHooks = new Map<string, PreHookFn>()
const postHooks = new Map<string, PostHookFn>()
const CRITICAL_PRE_HOOKS = new Set(["blockIfNoIntent", "scopeAndLockPreHook", "hitlPreHook"])

let defaultHooksRegistered = false

function log(stage: string, payload: Record<string, unknown>) {
	try {
		console.log(`[HookEngine:${stage}] ${JSON.stringify(payload)}`)
	} catch {
		console.log(`[HookEngine:${stage}]`, payload)
	}
}

export function registerPreHook(name: string, fn: PreHookFn): void {
	preHooks.set(name, fn)
}

export function registerPostHook(name: string, fn: PostHookFn): void {
	postHooks.set(name, fn)
}

export function unregisterPreHook(name: string): void {
	preHooks.delete(name)
}

export function unregisterPostHook(name: string): void {
	postHooks.delete(name)
}

export function clearHooks(): void {
	preHooks.clear()
	postHooks.clear()
	defaultHooksRegistered = false
}

export type ExecuteToolOptions<TResult> = {
	session: HookSession
	askApproval?: AskApproval
	pushToolResult?: PushToolResult
	handleError?: HandleError
	execute: () => Promise<TResult>
}

export async function executeTool<TResult = unknown>(
	toolName: string,
	payload: unknown,
	options: ExecuteToolOptions<TResult>,
): Promise<{ invocationId: string; allowed: boolean; result?: TResult; error?: Error }> {
	const invocationId = crypto.randomUUID()
	const baseContext: HookContext = {
		invocationId,
		toolName,
		payload,
		session: options.session,
		askApproval: options.askApproval,
		pushToolResult: options.pushToolResult,
		handleError: options.handleError,
	}

	log("start", { invocationId, toolName })

	let allowed = true
	let blockedReason: string | undefined
	let alreadyReported = false
	let result: TResult | undefined
	let error: Error | undefined

	for (const [hookName, hookFn] of preHooks.entries()) {
		log("pre", { invocationId, hookName, toolName })
		let decision: HookDecision | void
		try {
			decision = await hookFn(baseContext)
		} catch (hookError) {
			const err = hookError instanceof Error ? hookError : new Error(String(hookError))
			log("pre_hook_error", {
				invocationId,
				toolName,
				hookName,
				error: err.message,
			})
			await options.handleError?.(`pre-hook:${hookName}`, err)
			if (CRITICAL_PRE_HOOKS.has(hookName)) {
				decision = {
					allow: false,
					alreadyReported: true,
				}
				options.pushToolResult?.(
					JSON.stringify({
						type: "tool_error",
						code: "HOOK_INTERNAL_ERROR",
						message:
							"A critical governance hook failed before tool execution. The operation was blocked to preserve safety.",
						meta: {
							invocation_id: invocationId,
							tool_name: toolName,
							hook_name: hookName,
							error: err.message,
							is_critical_hook: true,
						},
					}),
				)
			} else {
				continue
			}
		}
		if (decision && decision.allow === false) {
			allowed = false
			blockedReason = decision.reason ?? `Blocked by pre-hook '${hookName}'.`
			alreadyReported = decision.alreadyReported ?? false
			break
		}
	}

	if (allowed) {
		try {
			result = await options.execute()
		} catch (err) {
			error = err instanceof Error ? err : new Error(String(err))
		}
	} else if (blockedReason && options.pushToolResult && !alreadyReported) {
		options.pushToolResult(blockedReason)
	}

	const postContext: PostHookContext = {
		...baseContext,
		allowed,
		result,
		error,
	}

	for (const [hookName, hookFn] of postHooks.entries()) {
		log("post", { invocationId, hookName, toolName, allowed })
		try {
			await hookFn(postContext)
		} catch (hookError) {
			const err = hookError instanceof Error ? hookError : new Error(String(hookError))
			log("post_hook_error", {
				invocationId,
				toolName,
				hookName,
				error: err.message,
			})
			await options.handleError?.(`post-hook:${hookName}`, err)
			options.pushToolResult?.(
				JSON.stringify({
					type: "hook_warning",
					code: "HOOK_INTERNAL_ERROR",
					message: "A post-hook failed, but tool execution already completed.",
					meta: {
						invocation_id: invocationId,
						tool_name: toolName,
						hook_name: hookName,
						error: err.message,
						is_critical_hook: false,
					},
				}),
			)
		}
	}

	log("end", { invocationId, toolName, allowed, hasError: !!error })

	if (error) {
		throw error
	}

	return { invocationId, allowed, result, error }
}

/**
 * Demo hook: logs incoming payload with invocation UUID.
 */
export const logHook: PreHookFn = async (context) => {
	const classification = classifyCommand(context.toolName, context.payload)
	log("logHook", {
		invocationId: context.invocationId,
		toolName: context.toolName,
		normalizedToolName: classification.normalizedToolName,
		risk: classification.risk,
		mutationClass: classification.mutationClass,
		affectedFiles: classification.affectedFiles,
		payload: context.payload,
	})
}

/**
 * Demo hook: blocks mutating tools if the handshake has not selected an active intent.
 */
export const blockIfNoIntent: PreHookFn = async (context) => {
	const requiresIntent = new Set([
		"write_to_file",
		"apply_diff",
		"edit",
		"search_and_replace",
		"search_replace",
		"edit_file",
		"apply_patch",
	])

	if (!requiresIntent.has(context.toolName)) {
		return { allow: true }
	}

	const hasIntent = context.session.hasActiveIntentContext?.() ?? false
	if (hasIntent) {
		return { allow: true }
	}

	return {
		allow: false,
		reason: JSON.stringify({
			type: "tool_error",
			code: "NO_ACTIVE_INTENT",
			message:
				"Handshake required: you must call select_active_intent(intent_id) first. Mutating tools are blocked until a valid active intent is selected.",
			meta: {
				invocation_id: context.invocationId,
				tool_name: context.toolName,
			},
		}),
	}
}

/**
 * Register default demo hooks once per extension host process.
 */
export function registerDefaultHooks(): void {
	if (defaultHooksRegistered) {
		return
	}

	registerPreHook("logHook", logHook)
	registerPreHook("curateContextPreHook", curateContextPreHook)
	registerPreHook("blockIfNoIntent", blockIfNoIntent)
	registerPreHook("scopeAndLockPreHook", scopeAndLockPreHook)
	registerPreHook("hitlPreHook", hitlPreHook)
	registerPostHook("traceAppender", traceAppenderPostHook)
	registerPostHook("postprocessPostHook", postprocessPostHook)
	defaultHooksRegistered = true
}
