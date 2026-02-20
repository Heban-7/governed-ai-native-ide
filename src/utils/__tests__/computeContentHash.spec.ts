import { describe, expect, it } from "vitest"

import { computeContentHash } from "../computeContentHash"

describe("computeContentHash", () => {
	it("produces same hash for equivalent function with whitespace/comment differences", () => {
		const contentA = `
export function add(a: number, b: number) {
	// comment
	return a + b
}
`.trim()

		const contentB = `
export function add( a:number , b:number ){
	return a + b
}
`.trim()

		const a = computeContentHash({
			filePath: "src/add.ts",
			fileContent: contentA,
			modifiedRange: { startLine: 1, endLine: 4 },
		})

		const b = computeContentHash({
			filePath: "src/add.ts",
			fileContent: contentB,
			modifiedRange: { startLine: 1, endLine: 3 },
		})

		expect(a.strategy).toBe("ast_canonical")
		expect(b.strategy).toBe("ast_canonical")
		expect(a.contentHash).toBe(b.contentHash)
	})

	it("falls back to normalized string hashing for invalid syntax", () => {
		const invalidA = "function broken( {"
		const invalidB = "function broken({"

		const a = computeContentHash({
			filePath: "src/broken.ts",
			fileContent: invalidA,
			insertedContent: invalidA,
		})
		const b = computeContentHash({
			filePath: "src/broken.ts",
			fileContent: invalidB,
			insertedContent: invalidB,
		})

		expect(a.strategy).toBe("normalized_string")
		expect(b.strategy).toBe("normalized_string")
		expect(typeof a.contentHash).toBe("string")
		expect(typeof b.contentHash).toBe("string")
	})
})
