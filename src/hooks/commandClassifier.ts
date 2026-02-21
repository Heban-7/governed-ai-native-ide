export type CommandRisk = "SAFE" | "DESTRUCTIVE"
export type MutationClass = "AST_REFACTOR" | "INTENT_EVOLUTION" | "UNKNOWN"

export type CommandClassification = {
	normalizedToolName: string
	risk: CommandRisk
	mutationClass: MutationClass
	mutationConfidence: "HIGH" | "MEDIUM" | "LOW"
	mutationSignals: string[]
	affectedFiles: string[]
	diffPreview?: string
	reason: string
}

type AnyPayload = Record<string, unknown>

const SAFE_TOOLS = new Set(["read_file", "stat", "list", "list_files", "read_command_output"])
const DESTRUCTIVE_TOOLS = new Set([
	"write_file",
	"write_to_file",
	"delete",
	"exec_bash",
	"execute_command",
	"apply_diff",
	"apply_patch",
	"edit",
	"search_and_replace",
	"search_replace",
	"edit_file",
])

function normalizeToolName(toolName: string): string {
	if (toolName === "write_file") return "write_to_file"
	if (toolName === "exec_bash") return "execute_command"
	return toolName
}

function asPayload(payload: unknown): AnyPayload {
	return payload && typeof payload === "object" ? (payload as AnyPayload) : {}
}

function extractAffectedFiles(toolName: string, payload: AnyPayload): string[] {
	const files = new Set<string>()
	const singlePathKeys = ["path", "file_path"]

	for (const key of singlePathKeys) {
		const value = payload[key]
		if (typeof value === "string" && value.trim().length > 0) {
			files.add(value.trim())
		}
	}

	if (toolName === "apply_patch" && typeof payload.patch === "string") {
		for (const line of payload.patch.split("\n")) {
			for (const marker of ["*** Add File: ", "*** Update File: ", "*** Delete File: "]) {
				if (line.startsWith(marker)) {
					files.add(line.slice(marker.length).trim())
				}
			}
		}
	}

	return [...files]
}

function previewDiff(payload: AnyPayload): string | undefined {
	const candidate =
		typeof payload.diff === "string" ? payload.diff : typeof payload.patch === "string" ? payload.patch : undefined
	if (!candidate) {
		return undefined
	}
	return candidate.split("\n").slice(0, 20).join("\n")
}

function structuralLineCount(lines: string[]): number {
	const structuralRegex =
		/\b(class|interface|type|enum|function|def|public|private|protected|export\s+(const|function|class|type|interface)|module|namespace)\b/
	return lines.filter((line) => structuralRegex.test(line)).length
}

type MutationInference = {
	mutationClass: MutationClass
	mutationConfidence: "HIGH" | "MEDIUM" | "LOW"
	mutationSignals: string[]
}

function inferMutationClass(toolName: string, payload: AnyPayload): MutationInference {
	// Staged heuristic:
	// 1) Diff-shape signals (balanced add/remove, structural balance)
	// 2) AST-ish structural keyword density
	// 3) Intent-evolution language signals in added lines
	const diffText =
		typeof payload.diff === "string" ? payload.diff : typeof payload.patch === "string" ? payload.patch : undefined

	if (diffText) {
		const signals: string[] = []
		const added = diffText
			.split("\n")
			.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
			.map((line) => line.slice(1))
		const removed = diffText
			.split("\n")
			.filter((line) => line.startsWith("-") && !line.startsWith("---"))
			.map((line) => line.slice(1))

		const addedStructural = structuralLineCount(added)
		const removedStructural = structuralLineCount(removed)
		const addRemoveBalanced =
			added.length > 0 && removed.length > 0 && Math.abs(added.length - removed.length) <= 10
		const structuralBalanced =
			addedStructural > 0 &&
			removedStructural > 0 &&
			Math.abs(addedStructural - removedStructural) <=
				Math.max(2, Math.ceil(Math.max(addedStructural, removedStructural) * 0.4))

		if (addRemoveBalanced) {
			signals.push("balanced_diff_shape")
		}
		if (structuralBalanced) {
			signals.push("balanced_structural_lines")
		}

		const addedLower = added.join("\n").toLowerCase()
		const evolutionKeywords = [
			"new feature",
			"add endpoint",
			"introduce",
			"support ",
			"migration",
			"breaking",
			"deprecate",
		]
		const hasEvolutionKeyword = evolutionKeywords.some((keyword) => addedLower.includes(keyword))
		if (hasEvolutionKeyword) {
			signals.push("intent_evolution_language")
		}

		if (typeof payload.patch === "string" && payload.patch.includes("*** Add File: ")) {
			signals.push("adds_new_file")
		}
		if (typeof payload.patch === "string" && payload.patch.includes("*** Delete File: ")) {
			signals.push("deletes_file")
		}

		if (addRemoveBalanced && structuralBalanced) {
			return {
				mutationClass: "AST_REFACTOR",
				mutationConfidence: hasEvolutionKeyword ? "MEDIUM" : "HIGH",
				mutationSignals: signals,
			}
		}

		return {
			mutationClass: "INTENT_EVOLUTION",
			mutationConfidence: hasEvolutionKeyword ? "HIGH" : "MEDIUM",
			mutationSignals: signals,
		}
	}

	if (toolName === "write_to_file") {
		// We only have final content in this tool, not a granular diff, so treat as evolution by default.
		return {
			mutationClass: "INTENT_EVOLUTION",
			mutationConfidence: "LOW",
			mutationSignals: ["full_write_without_diff"],
		}
	}

	return {
		mutationClass: "UNKNOWN",
		mutationConfidence: "LOW",
		mutationSignals: [],
	}
}

export function classifyCommand(toolName: string, payload: unknown): CommandClassification {
	const normalizedToolName = normalizeToolName(toolName)
	const parsedPayload = asPayload(payload)
	const affectedFiles = extractAffectedFiles(normalizedToolName, parsedPayload)
	const diffPreview = previewDiff(parsedPayload)

	let risk: CommandRisk = "SAFE"
	let reason = "Default safe classification."

	if (
		SAFE_TOOLS.has(normalizedToolName) ||
		normalizedToolName.startsWith("read_") ||
		normalizedToolName.startsWith("list")
	) {
		risk = "SAFE"
		reason = "Read/list/stat operation."
	} else if (
		DESTRUCTIVE_TOOLS.has(normalizedToolName) ||
		normalizedToolName.startsWith("write") ||
		normalizedToolName.startsWith("delete")
	) {
		risk = "DESTRUCTIVE"
		reason = "Mutating or shell-execution operation."
	}

	const inference =
		risk === "DESTRUCTIVE"
			? inferMutationClass(normalizedToolName, parsedPayload)
			: { mutationClass: "UNKNOWN" as MutationClass, mutationConfidence: "LOW" as const, mutationSignals: [] }

	return {
		normalizedToolName,
		risk,
		mutationClass: inference.mutationClass,
		mutationConfidence: inference.mutationConfidence,
		mutationSignals: inference.mutationSignals,
		affectedFiles,
		diffPreview,
		reason:
			inference.mutationSignals.length > 0
				? `${reason} Signals: ${inference.mutationSignals.join(", ")}`
				: reason,
	}
}
