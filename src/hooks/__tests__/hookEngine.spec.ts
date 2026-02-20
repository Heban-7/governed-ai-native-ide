import { describe, it, expect, beforeEach } from "vitest"

import { clearHooks, executeTool, registerPostHook, registerPreHook } from "../hookEngine"

describe("hookEngine", () => {
	beforeEach(() => {
		clearHooks()
	})

	it("runs pre hooks, execute, then post hooks in deterministic order", async () => {
		const events: string[] = []

		registerPreHook("preA", async () => {
			events.push("preA")
		})
		registerPreHook("preB", async () => {
			events.push("preB")
		})
		registerPostHook("postA", async () => {
			events.push("postA")
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
		expect(events).toEqual(["preA", "preB", "execute", "postA"])
	})

	it("cancels execution when a pre hook blocks", async () => {
		const events: string[] = []
		let didPushResult = false

		registerPreHook("blocker", async () => {
			events.push("pre:blocker")
			return { allow: false, reason: "blocked by test hook" }
		})
		registerPostHook("post", async () => {
			events.push("post")
		})

		const result = await executeTool(
			"write_to_file",
			{ path: "x.ts", content: "x" },
			{
				session: { hasActiveIntentContext: () => false },
				pushToolResult: () => {
					didPushResult = true
				},
				execute: async () => {
					events.push("execute")
					return "should-not-run"
				},
			},
		)

		expect(result.allowed).toBe(false)
		expect(didPushResult).toBe(true)
		expect(events).toEqual(["pre:blocker", "post"])
	})
})
