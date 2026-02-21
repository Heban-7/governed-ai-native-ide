import * as fs from "fs/promises"
import * as path from "path"
import { spawn } from "child_process"

import type { PostHookFn } from "../hookEngine"
import { classifyCommand } from "../commandClassifier"

type CommandResult = {
	command: string
	args: string[]
	exitCode: number
	stdout: string
	stderr: string
	durationMs: number
}

type FailureArtifact = {
	type: "postprocess_failure_artifact"
	timestamp: string
	invocation_id: string
	intent_id?: string
	tool_name: string
	mutation_class: "AST_REFACTOR" | "INTENT_EVOLUTION" | "UNKNOWN"
	modified_files: string[]
	checks: CommandResult[]
	next_action: "REPLAN_AND_FIX"
}

async function appendFailureLedger(cwd: string, artifact: FailureArtifact): Promise<void> {
	const orchestrationDir = path.resolve(cwd, ".orchestration")
	await fs.mkdir(orchestrationDir, { recursive: true })
	const failureLedgerPath = path.join(orchestrationDir, "postprocess_failures.jsonl")
	await fs.appendFile(
		failureLedgerPath,
		`${JSON.stringify({
			...artifact,
			unresolved: true,
		})}\n`,
		"utf8",
	)
}

async function appendSharedBrainLesson(cwd: string, artifact: FailureArtifact): Promise<void> {
	const sharedBrainPath = path.resolve(cwd, "AGENT.md")
	const summary = artifact.checks
		.filter((check) => check.exitCode !== 0)
		.map((check) => `${check.command} ${check.args.join(" ")} (exit ${check.exitCode})`)
		.join("; ")
	const lesson =
		`\n## Lesson ${artifact.timestamp}\n` +
		`- Intent: ${artifact.intent_id ?? "UNKNOWN"}\n` +
		`- Tool: ${artifact.tool_name}\n` +
		`- Mutation: ${artifact.mutation_class}\n` +
		`- Failed checks: ${summary || "unknown"}\n` +
		`- Guidance: Re-plan with smaller patch scope and rerun validation before completion.\n`

	try {
		await fs.stat(sharedBrainPath)
		await fs.appendFile(sharedBrainPath, lesson, "utf8")
	} catch {
		const initial =
			"# AGENT Shared Brain\n\n" +
			"This file stores cross-session lessons learned, guardrails, and style rules.\n" +
			lesson
		await fs.writeFile(sharedBrainPath, initial, "utf8")
	}
}

function isMutatingTool(toolName: string): boolean {
	return new Set([
		"write_to_file",
		"apply_diff",
		"apply_patch",
		"edit",
		"search_and_replace",
		"search_replace",
		"edit_file",
	]).has(toolName)
}

function getSessionCwd(session: unknown): string | undefined {
	const s = session as Record<string, unknown>
	const cwd = s.cwd
	return typeof cwd === "string" ? cwd : undefined
}

async function runCommand(cwd: string, command: string, args: string[]): Promise<CommandResult> {
	const startedAt = Date.now()
	return await new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			shell: process.platform === "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		})

		let stdout = ""
		let stderr = ""

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString()
		})
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString()
		})

		child.on("close", (code) => {
			resolve({
				command,
				args,
				exitCode: code ?? 1,
				stdout,
				stderr,
				durationMs: Date.now() - startedAt,
			})
		})

		child.on("error", (error) => {
			resolve({
				command,
				args,
				exitCode: 1,
				stdout,
				stderr: `${stderr}\n${String(error)}`,
				durationMs: Date.now() - startedAt,
			})
		})
	})
}

async function runFormatterOnFiles(cwd: string, files: string[]): Promise<CommandResult | undefined> {
	if (files.length === 0) {
		return undefined
	}
	const existingFiles: string[] = []
	for (const file of files) {
		const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file)
		try {
			await fs.stat(absolute)
			existingFiles.push(path.isAbsolute(file) ? path.relative(cwd, file).replace(/\\/g, "/") : file)
		} catch {
			// ignore non-existing files
		}
	}
	if (existingFiles.length === 0) {
		return undefined
	}

	return await runCommand(cwd, "pnpm", ["exec", "prettier", "--write", ...existingFiles])
}

function pushArtifactToSessionContext(session: unknown, artifact: FailureArtifact): void {
	const s = session as Record<string, unknown>
	if ("didToolFailInCurrentTurn" in s) {
		s.didToolFailInCurrentTurn = true
	}

	const artifactJson = JSON.stringify(artifact, null, 2)
	const guidance =
		"<postprocess_failure_artifact>\n" +
		artifactJson +
		"\n</postprocess_failure_artifact>\n" +
		"PostToolUseFailure detected. Re-plan and fix the failures before attempting completion."

	const userMessageContent = s.userMessageContent
	if (Array.isArray(userMessageContent)) {
		userMessageContent.push({
			type: "text",
			text: guidance,
		})
	}
}

export const postprocessPostHook: PostHookFn = async (context) => {
	if (!context.allowed || context.error) {
		return
	}

	const classification = classifyCommand(context.toolName, context.payload)
	if (!isMutatingTool(classification.normalizedToolName)) {
		return
	}

	const cwd = getSessionCwd(context.session)
	if (!cwd) {
		return
	}

	const checks: CommandResult[] = []
	const formatter = await runFormatterOnFiles(cwd, classification.affectedFiles)
	if (formatter) {
		checks.push(formatter)
	}

	// Read-only verification commands after formatting.
	checks.push(await runCommand(cwd, "pnpm", ["-C", "src", "check-types"]))
	checks.push(await runCommand(cwd, "pnpm", ["-C", "src", "test", "--", "--runInBand"]))

	const failed = checks.some((c) => c.exitCode !== 0)
	if (!failed) {
		return
	}

	const artifact: FailureArtifact = {
		type: "postprocess_failure_artifact",
		timestamp: new Date().toISOString(),
		invocation_id: context.invocationId,
		intent_id: context.session.getActiveIntentId?.(),
		tool_name: classification.normalizedToolName,
		mutation_class: classification.mutationClass,
		modified_files: classification.affectedFiles,
		checks,
		next_action: "REPLAN_AND_FIX",
	}

	await appendFailureLedger(cwd, artifact)
	await appendSharedBrainLesson(cwd, artifact)
	pushArtifactToSessionContext(context.session, artifact)
}
