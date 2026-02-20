import * as vscode from "vscode"

import type { HookDecision, PreHookFn } from "../hookEngine"
import { classifyCommand } from "../commandClassifier"

type ToolErrorPayload = {
	type: "tool_error"
	code: "HITL_REJECT"
	message: string
	meta: {
		invocation_id: string
		intent_id?: string
		tool_name: string
		normalized_tool_name: string
		risk: "SAFE" | "DESTRUCTIVE"
		mutation_class: "AST_REFACTOR" | "INTENT_EVOLUTION" | "UNKNOWN"
		affected_files: string[]
	}
}

function buildHitlRejectError(
	invocationId: string,
	toolName: string,
	normalizedToolName: string,
	intentId: string | undefined,
	mutationClass: "AST_REFACTOR" | "INTENT_EVOLUTION" | "UNKNOWN",
	affectedFiles: string[],
): ToolErrorPayload {
	return {
		type: "tool_error",
		code: "HITL_REJECT",
		message: "Destructive operation rejected by user via HITL pre-hook.",
		meta: {
			invocation_id: invocationId,
			intent_id: intentId,
			tool_name: toolName,
			normalized_tool_name: normalizedToolName,
			risk: "DESTRUCTIVE",
			mutation_class: mutationClass,
			affected_files: affectedFiles,
		},
	}
}

export const hitlPreHook: PreHookFn = async (context): Promise<HookDecision> => {
	const classification = classifyCommand(context.toolName, context.payload)

	if (classification.risk !== "DESTRUCTIVE") {
		return { allow: true }
	}

	const intentId = context.session.getActiveIntentId?.()
	const affected =
		classification.affectedFiles.length > 0 ? classification.affectedFiles.join(", ") : "(none detected)"
	const diffPreview = classification.diffPreview ? `\n\nDiff preview:\n${classification.diffPreview}` : ""

	const detail =
		`Intent ID: ${intentId ?? "(none)"}\n` +
		`Tool: ${classification.normalizedToolName}\n` +
		`Mutation class: ${classification.mutationClass}\n` +
		`Affected file(s): ${affected}${diffPreview}`

	const approve = "Approve"
	const reject = "Reject"

	const response = await vscode.window.showWarningMessage(
		"Destructive operation detected. Approve execution?",
		{ modal: true, detail },
		approve,
		reject,
	)

	if (response === approve) {
		return { allow: true }
	}

	const rejectPayload = buildHitlRejectError(
		context.invocationId,
		context.toolName,
		classification.normalizedToolName,
		intentId,
		classification.mutationClass,
		classification.affectedFiles,
	)

	// Serialize standardized error into tool result so the agent can re-plan.
	context.pushToolResult?.(JSON.stringify(rejectPayload))

	return { allow: false, alreadyReported: true }
}
