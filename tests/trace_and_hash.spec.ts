import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { describe, expect, it } from "vitest"

import { computeContentHash } from "../src/utils/computeContentHash"
import { traceAppenderPostHook } from "../src/hooks/postHooks/traceAppender"

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-step8-trace-"))
	await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true })
	return dir
}

describe("trace + hash critical guarantees", () => {
	it("hash is stable across whitespace/comment-only variations", () => {
		const a = `export function add(a:number,b:number){\n// comment\nreturn a+b\n}`
		const b = `export function add( a: number, b: number ) {\nreturn a + b\n}`

		const ah = computeContentHash({
			filePath: "src/add.ts",
			fileContent: a,
			modifiedRange: { startLine: 1, endLine: 4 },
		}).contentHash
		const bh = computeContentHash({
			filePath: "src/add.ts",
			fileContent: b,
			modifiedRange: { startLine: 1, endLine: 3 },
		}).contentHash

		expect(ah).toBe(bh)
	})

	it("falls back deterministically for invalid syntax", () => {
		const r1 = computeContentHash({
			filePath: "src/broken.ts",
			fileContent: "function x( {",
		})
		const r2 = computeContentHash({
			filePath: "src/broken.ts",
			fileContent: "function x( {",
		})
		expect(r1.strategy).toBe("normalized_string")
		expect(r1.contentHash).toBe(r2.contentHash)
	})

	it("trace appender writes one valid jsonl entry for destructive write", async () => {
		const cwd = await makeWorkspace()
		const filePath = path.join(cwd, "src", "auth", "middleware.ts")
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, "export const a = 1\n", "utf8")

		await traceAppenderPostHook({
			invocationId: "inv-step8-001",
			toolName: "write_to_file",
			payload: {
				path: "src/auth/middleware.ts",
				content: "export const b = 2\n",
			},
			session: {
				cwd,
				taskId: "task-1",
				instanceId: "inst-1",
				getActiveIntentId: () => "INT-001",
			},
			allowed: true,
			result: undefined,
			error: undefined,
		})

		const ledgerPath = path.join(cwd, ".orchestration", "agent_trace.jsonl")
		const ledger = await fs.readFile(ledgerPath, "utf8")
		const line = ledger.trim().split("\n")[0]
		const parsed = JSON.parse(line)

		expect(parsed.id).toBe("inv-step8-001")
		expect(parsed.files[0].relative_path).toBe("src/auth/middleware.ts")
		expect(parsed.files[0].conversations[0].related[0].value).toBe("INT-001")
		expect(parsed.files[0].conversations[0].ranges[0].content_hash).toContain("sha256:")
	})
})
