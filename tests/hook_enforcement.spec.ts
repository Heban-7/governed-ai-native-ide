import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { beforeEach, describe, expect, it } from "vitest"

import { clearHooks, executeTool, registerPreHook, registerPostHook } from "../src/hooks/hookEngine"
import { blockIfNoIntent } from "../src/hooks/hookEngine"
import { scopeAndLockPreHook } from "../src/hooks/preHooks/scopeAndLock"
import { computeContentHash } from "../src/utils/computeContentHash"

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-step8-hooks-"))
	await fs.mkdir(path.join(dir, ".orchestration"), { recursive: true })
	return dir
}

describe("critical hook enforcement", () => {
	beforeEach(() => {
		clearHooks()
	})

	it("executes hooks in deterministic pre->execute->post order", async () => {
		const events: string[] = []
		registerPreHook("pre-1", async () => {
			events.push("pre-1")
		})
		registerPreHook("pre-2", async () => {
			events.push("pre-2")
		})
		registerPostHook("post-1", async () => {
			events.push("post-1")
		})

		const result = await executeTool(
			"read_file",
			{ path: "a.ts" },
			{
				session: {},
				execute: async () => {
					events.push("execute")
					return "ok"
				},
			},
		)

		expect(result.allowed).toBe(true)
		expect(events).toEqual(["pre-1", "pre-2", "execute", "post-1"])
	})

	it("blocks mutating tools without active intent handshake", async () => {
		registerPreHook("blockIfNoIntent", blockIfNoIntent)
		let toolResult = ""
		const result = await executeTool(
			"write_to_file",
			{ path: "src/a.ts", content: "x" },
			{
				session: { hasActiveIntentContext: () => false },
				pushToolResult: (msg) => {
					toolResult = String(msg)
				},
				execute: async () => "should-not-run",
			},
		)

		expect(result.allowed).toBe(false)
		expect(toolResult).toContain("NO_ACTIVE_INTENT")
	})

	it("returns SCOPE_VIOLATION when write is outside owned_scope", async () => {
		const cwd = await makeWorkspace()
		await fs.writeFile(
			path.join(cwd, ".orchestration", "active_intents.yaml"),
			["active_intents:", '  - id: "INT-001"', "    owned_scope:", '      - "src/auth/**"'].join("\n"),
			"utf8",
		)

		registerPreHook("scopeAndLock", scopeAndLockPreHook)
		let toolResult = ""
		const result = await executeTool(
			"write_to_file",
			{ path: "src/billing/charge.ts", content: "export const c = 1" },
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

		expect(result.allowed).toBe(false)
		expect(toolResult).toContain("SCOPE_VIOLATION")
	})

	it("returns STALE_FILE when observed hash mismatches current file", async () => {
		const cwd = await makeWorkspace()
		await fs.writeFile(
			path.join(cwd, ".orchestration", "active_intents.yaml"),
			["active_intents:", '  - id: "INT-001"', "    owned_scope:", '      - "src/auth/**"'].join("\n"),
			"utf8",
		)
		const target = path.join(cwd, "src", "auth", "middleware.ts")
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, "export const current = true\n", "utf8")
		const staleHash = computeContentHash({
			filePath: target,
			fileContent: "export const stale = true\n",
		}).contentHash

		registerPreHook("scopeAndLock", scopeAndLockPreHook)
		let toolResult = ""
		const result = await executeTool(
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

		expect(result.allowed).toBe(false)
		expect(toolResult).toContain("STALE_FILE")
	})
})
