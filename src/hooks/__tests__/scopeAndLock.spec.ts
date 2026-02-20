import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it } from "vitest"

import { clearHooks, executeTool, registerPreHook } from "../hookEngine"
import { scopeAndLockPreHook } from "../preHooks/scopeAndLock"
import { computeContentHash } from "../../utils/computeContentHash"

async function makeTempWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-scope-lock-"))
	await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true })
	return dir
}

describe("scopeAndLockPreHook", () => {
	beforeEach(() => {
		clearHooks()
		registerPreHook("scopeAndLockPreHook", scopeAndLockPreHook)
	})

	it("blocks write outside owned_scope with SCOPE_VIOLATION", async () => {
		const cwd = await makeTempWorkspace()
		await fs.writeFile(
			path.join(cwd, ".orchestration", "active_intents.yaml"),
			["active_intents:", '  - id: "INT-001"', "    owned_scope:", '      - "src/auth/**"'].join("\n"),
			"utf8",
		)

		let toolResult = ""
		const response = await executeTool(
			"write_to_file",
			{ path: "src/other/file.ts", content: "export const x = 1" },
			{
				session: {
					cwd,
					getActiveIntentId: () => "INT-001",
					hasActiveIntentContext: () => true,
				},
				pushToolResult: (msg) => {
					toolResult = String(msg)
				},
				execute: async () => "should-not-run",
			},
		)

		expect(response.allowed).toBe(false)
		expect(toolResult).toContain('"code":"SCOPE_VIOLATION"')
	})

	it("blocks stale write when observed_content_hash mismatches current hash", async () => {
		const cwd = await makeTempWorkspace()
		await fs.writeFile(
			path.join(cwd, ".orchestration", "active_intents.yaml"),
			["active_intents:", '  - id: "INT-001"', "    owned_scope:", '      - "src/auth/**"'].join("\n"),
			"utf8",
		)

		const targetFile = path.join(cwd, "src", "auth", "middleware.ts")
		await fs.mkdir(path.dirname(targetFile), { recursive: true })
		await fs.writeFile(targetFile, "export const current = true\n", "utf8")

		const staleHash = computeContentHash({
			filePath: targetFile,
			fileContent: "export const stale = true\n",
		}).contentHash

		let toolResult = ""
		const response = await executeTool(
			"write_to_file",
			{
				path: "src/auth/middleware.ts",
				content: "export const next = true\n",
				observed_content_hash: staleHash,
			},
			{
				session: {
					cwd,
					getActiveIntentId: () => "INT-001",
					hasActiveIntentContext: () => true,
				},
				pushToolResult: (msg) => {
					toolResult = String(msg)
				},
				execute: async () => "should-not-run",
			},
		)

		expect(response.allowed).toBe(false)
		expect(toolResult).toContain('"code":"STALE_FILE"')
	})
})
