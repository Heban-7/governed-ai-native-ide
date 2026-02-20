import crypto from "crypto"
import * as ts from "typescript"

export type ModifiedRange = {
	startLine: number
	endLine: number
}

export type ComputeContentHashInput = {
	filePath: string
	fileContent: string
	modifiedRange?: ModifiedRange
	insertedContent?: string
}

export type ComputeContentHashResult = {
	contentHash: string
	strategy: "ast_canonical" | "normalized_string"
	canonicalContent: string
}

function sha256Hex(value: string): string {
	return crypto.createHash("sha256").update(value, "utf8").digest("hex")
}

function normalizeStringForHash(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim()
}

function lineToOffset(content: string, lineNumber: number): number {
	if (lineNumber <= 1) {
		return 0
	}
	let currentLine = 1
	for (let i = 0; i < content.length; i++) {
		if (currentLine === lineNumber) {
			return i
		}
		if (content[i] === "\n") {
			currentLine++
		}
	}
	return content.length
}

function findSmallestContainingNode(
	sourceFile: ts.SourceFile,
	startOffset: number,
	endOffset: number,
): ts.Node | undefined {
	let best: ts.Node | undefined

	const visit = (node: ts.Node) => {
		const nodeStart = node.getFullStart()
		const nodeEnd = node.getEnd()
		const contains = nodeStart <= startOffset && nodeEnd >= endOffset

		if (contains) {
			if (!best || nodeEnd - nodeStart < best.getEnd() - best.getFullStart()) {
				best = node
			}
			node.forEachChild(visit)
		}
	}

	visit(sourceFile)
	return best
}

function canonicalizeAstNode(node: ts.Node, sourceFile: ts.SourceFile): string {
	const printer = ts.createPrinter({
		removeComments: true,
		newLine: ts.NewLineKind.LineFeed,
	})

	if (ts.isSourceFile(node)) {
		return printer.printFile(node)
	}

	// printNode with SourceFile hint produces deterministic formatting for most nodes.
	return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile)
}

export function computeContentHash(input: ComputeContentHashInput): ComputeContentHashResult {
	const { filePath, fileContent, modifiedRange, insertedContent } = input

	try {
		const sourceFile = ts.createSourceFile(filePath, fileContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		let targetNode: ts.Node | undefined

		if (modifiedRange) {
			const startOffset = lineToOffset(fileContent, modifiedRange.startLine)
			const endOffset = lineToOffset(fileContent, modifiedRange.endLine + 1)
			targetNode = findSmallestContainingNode(sourceFile, startOffset, endOffset)
		}

		if (!targetNode && insertedContent) {
			const needle = normalizeStringForHash(insertedContent)
			const haystack = normalizeStringForHash(fileContent)
			if (needle.length > 0 && haystack.includes(needle)) {
				// If inserted content appears in the file, hash its normalized canonical content.
				const canonicalInserted = normalizeStringForHash(insertedContent)
				return {
					contentHash: `sha256:${sha256Hex(canonicalInserted)}`,
					strategy: "normalized_string",
					canonicalContent: canonicalInserted,
				}
			}
		}

		const canonicalAst = canonicalizeAstNode(targetNode ?? sourceFile, sourceFile)
		const canonicalNormalized = normalizeStringForHash(canonicalAst)

		return {
			contentHash: `sha256:${sha256Hex(canonicalNormalized)}`,
			strategy: "ast_canonical",
			canonicalContent: canonicalNormalized,
		}
	} catch {
		// Fall through to normalized-string hashing below.
	}

	const fallback = normalizeStringForHash(
		insertedContent && insertedContent.trim().length > 0 ? insertedContent : fileContent,
	)
	return {
		contentHash: `sha256:${sha256Hex(fallback)}`,
		strategy: "normalized_string",
		canonicalContent: fallback,
	}
}
