import * as fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"

export type WorkerRole = "Architect" | "Builder"

export type WorkerSession = {
	id: string
	role: WorkerRole
	intentId?: string
	ownedScope: string[]
}

export type OperationCheckResult =
	| { allow: true }
	| {
			allow: false
			code: "SCOPE_VIOLATION" | "MISSING_INTENT"
			message: string
			meta: Record<string, unknown>
	  }

function toPosix(input: string): string {
	return input.replace(/\\/g, "/")
}

function globToRegex(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "§§DOUBLESTAR§§")
		.replace(/\*/g, "[^/]*")
		.replace(/§§DOUBLESTAR§§/g, ".*")
	return new RegExp(`^${escaped}$`)
}

function inScope(relativePath: string, globs: string[]): boolean {
	const p = toPosix(relativePath)
	return globs.some((glob) => globToRegex(toPosix(glob)).test(p))
}

export class Supervisor {
	private readonly workers = new Map<string, WorkerSession>()
	private readonly workspacePath: string
	private readonly sharedBrainPath: string

	constructor(workspacePath: string, sharedBrainFileName: "AGENT.md" | "CLAUDE.md" = "AGENT.md") {
		this.workspacePath = workspacePath
		this.sharedBrainPath = path.resolve(workspacePath, sharedBrainFileName)
	}

	getSharedBrainPath(): string {
		return this.sharedBrainPath
	}

	async ensureSharedBrain(): Promise<void> {
		try {
			await fs.access(this.sharedBrainPath)
		} catch {
			const initial = [
				"# Shared Brain",
				"",
				"## Lessons Learned",
				"- Keep changes scoped to assigned intent-owned files.",
				"",
				"## Stylistic Rules",
				"- Prefer targeted diffs over full-file rewrites.",
				"- Re-run checks after each mutating step.",
				"",
			].join("\n")
			await fs.writeFile(this.sharedBrainPath, initial, "utf8")
		}
	}

	createWorker(role: WorkerRole, options?: { intentId?: string; ownedScope?: string[] }): WorkerSession {
		const worker: WorkerSession = {
			id: crypto.randomUUID(),
			role,
			intentId: options?.intentId,
			ownedScope: options?.ownedScope ?? [],
		}
		this.workers.set(worker.id, worker)
		return worker
	}

	getWorker(workerId: string): WorkerSession | undefined {
		return this.workers.get(workerId)
	}

	assignOwnedScope(workerId: string, ownedScope: string[]): WorkerSession {
		const worker = this.workers.get(workerId)
		if (!worker) {
			throw new Error(`Worker ${workerId} not found`)
		}
		worker.ownedScope = [...new Set(ownedScope.map((s) => toPosix(s.trim())).filter(Boolean))]
		return worker
	}

	declareIntent(workerId: string, intentId: string): WorkerSession {
		const worker = this.workers.get(workerId)
		if (!worker) {
			throw new Error(`Worker ${workerId} not found`)
		}
		worker.intentId = intentId
		return worker
	}

	checkOperation(workerId: string, targetPath: string): OperationCheckResult {
		const worker = this.workers.get(workerId)
		if (!worker) {
			return {
				allow: false,
				code: "MISSING_INTENT",
				message: "Worker session does not exist.",
				meta: { worker_id: workerId },
			}
		}

		if (!worker.intentId) {
			return {
				allow: false,
				code: "MISSING_INTENT",
				message: "Worker must declare intent_id before mutating operations.",
				meta: { worker_id: workerId, role: worker.role },
			}
		}

		const relative = path.isAbsolute(targetPath)
			? toPosix(path.relative(this.workspacePath, targetPath))
			: toPosix(targetPath)
		if (!inScope(relative, worker.ownedScope)) {
			return {
				allow: false,
				code: "SCOPE_VIOLATION",
				message: `Worker '${worker.role}' is not authorized to edit '${relative}'.`,
				meta: {
					worker_id: worker.id,
					role: worker.role,
					intent_id: worker.intentId,
					owned_scope: worker.ownedScope,
					target_path: relative,
				},
			}
		}

		return { allow: true }
	}

	async appendLesson(authorRole: WorkerRole, lesson: string): Promise<void> {
		await this.ensureSharedBrain()
		const line = `- [${new Date().toISOString()}] [${authorRole}] ${lesson}\n`
		await fs.appendFile(this.sharedBrainPath, line, "utf8")
	}
}

/**
 * Convenience helper for STEP 7 demo bootstrapping.
 */
export async function bootstrapArchitectBuilder(workspacePath: string): Promise<{
	supervisor: Supervisor
	architect: WorkerSession
	builder: WorkerSession
}> {
	const supervisor = new Supervisor(workspacePath, "AGENT.md")
	await supervisor.ensureSharedBrain()

	const architect = supervisor.createWorker("Architect", {
		intentId: "INT-ARCH-001",
		ownedScope: ["docs/**", ".orchestration/**"],
	})

	const builder = supervisor.createWorker("Builder", {
		intentId: "INT-001",
		ownedScope: ["src/auth/**"],
	})

	return { supervisor, architect, builder }
}
