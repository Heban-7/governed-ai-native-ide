import { describe, it, expect } from "vitest"

import { classifyCommand } from "../commandClassifier"

describe("commandClassifier", () => {
	it("classifies read/list/stat as SAFE", () => {
		expect(classifyCommand("read_file", { path: "a.ts" }).risk).toBe("SAFE")
		expect(classifyCommand("list_files", { path: "." }).risk).toBe("SAFE")
		expect(classifyCommand("stat", { path: "x" }).risk).toBe("SAFE")
	})

	it("classifies write/delete/exec as DESTRUCTIVE", () => {
		expect(classifyCommand("write_file", { path: "a.ts", content: "x" }).risk).toBe("DESTRUCTIVE")
		expect(classifyCommand("delete", { path: "a.ts" }).risk).toBe("DESTRUCTIVE")
		expect(classifyCommand("exec_bash", { command: "rm -rf ." }).risk).toBe("DESTRUCTIVE")
	})

	it("infers mutation class from diff heuristics", () => {
		const refactorDiff = [
			"@@",
			"-export function oldName() {",
			"+export function newName() {",
			"-  return 1",
			"+  return 1",
			"}",
		].join("\n")

		const classification = classifyCommand("apply_diff", { path: "src/a.ts", diff: refactorDiff })
		expect(classification.risk).toBe("DESTRUCTIVE")
		expect(["AST_REFACTOR", "INTENT_EVOLUTION"]).toContain(classification.mutationClass)
		expect(["HIGH", "MEDIUM", "LOW"]).toContain(classification.mutationConfidence)
		expect(Array.isArray(classification.mutationSignals)).toBe(true)
		expect(classification.affectedFiles).toEqual(["src/a.ts"])
	})
})
