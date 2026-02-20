import type OpenAI from "openai"

const SELECT_ACTIVE_INTENT_DESCRIPTION = `Select the active intent before any mutating operation. This tool reads .orchestration/active_intents.yaml and returns a compact <intent_context> payload for the selected intent.

Use this tool as the first action for each new user request.`

const INTENT_ID_PARAMETER_DESCRIPTION = `Intent ID to activate (for example: INT-001)`

export default {
	type: "function",
	function: {
		name: "select_active_intent",
		description: SELECT_ACTIVE_INTENT_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				intent_id: {
					type: "string",
					description: INTENT_ID_PARAMETER_DESCRIPTION,
					minLength: 1,
					maxLength: 128,
					pattern: "^[A-Za-z0-9._:-]+$",
				},
			},
			required: ["intent_id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
