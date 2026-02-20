# Multi-Agent Demo (STEP 7)

This demo shows a minimal Supervisor orchestration flow with:

- Architect worker (planning + scope assignment),
- Builder worker (implementation in assigned scope),
- shared `AGENT.md`,
- scope enforcement + trace updates.

## 1) Preparation

From repo root:

```powershell
pnpm -C src check-types
```

Create/update intent file:

```yaml
# .orchestration/active_intents.yaml
active_intents:
    - id: "INT-001"
      owned_scope:
          - "src/auth/**"
      constraints:
          - "Must preserve auth backward compatibility"
      acceptance_criteria:
          - "Auth tests pass"
```

## 2) Supervisor bootstrapping (optional quick script)

Use this Node one-liner to initialize workers + shared brain:

```powershell
node -e "import('./src/supervisor/supervisor.ts').then(async m => { const r = await m.bootstrapArchitectBuilder(process.cwd()); console.log(JSON.stringify({architect:r.architect,builder:r.builder,agentMd:r.supervisor.getSharedBrainPath()}, null, 2)); })"
```

Expected output (shape):

```json
{
	"architect": { "role": "Architect", "intentId": "INT-ARCH-001", "ownedScope": ["docs/**", ".orchestration/**"] },
	"builder": { "role": "Builder", "intentId": "INT-001", "ownedScope": ["src/auth/**"] },
	"agentMd": ".../AGENT.md"
}
```

## 3) Parallel session walkthrough

Open two chat panels/sessions in extension host:

- Session A = Architect
- Session B = Builder

### Architect actions

1. Calls `select_active_intent("INT-001")`
2. Writes plan to `AGENT.md` / docs (inside its own scope in this demo setup)
3. Assigns Builder scope: `src/auth/**`

### Builder actions

1. Calls `select_active_intent("INT-001")`
2. Applies edit within scope (e.g., `src/auth/middleware.ts`)
3. Post-hooks run:
    - trace appender updates `.orchestration/agent_trace.jsonl`
    - postprocess checks run

Expected: ledger gets new JSONL row for the write.

## 4) Scope violation check

In Builder session, intentionally attempt out-of-scope write:

- target: `src/billing/charge.ts`

Expected:

- blocked with `SCOPE_VIOLATION` tool-error JSON,
- operation does not execute,
- agent proposes request scope expansion flow.

## 5) Write partitioning vs optimistic locking (what you should observe)

- Write partitioning: Architect and Builder have different owned scopes to avoid collisions by design.
- Optimistic locking: if Builder sends stale `observed_content_hash`, PreHook returns `STALE_FILE` and forces re-read/re-plan.
