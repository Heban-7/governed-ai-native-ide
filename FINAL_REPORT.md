# Final Report: Governed AI-Native IDE with Intent-Code Traceability

## 1) Executive Summary

This report documents a engineering project to transform a baseline AI coding extension into a governed AI-native IDE workflow. The implementation introduces deterministic hook middleware, intent-first execution, traceability ledgers, and guardrails for destructive actions and concurrent edits.

Core outcomes:

- Mandatory intent handshake before mutating operations.
- Deterministic PreToolUse/PostToolUse interception layer.
- Human-in-the-Loop authorization for destructive actions.
- Scope enforcement using `owned_scope` and optimistic locking via content hash comparison.
- Agent Trace ledger (`.orchestration/agent_trace.jsonl`) with intent linkage.
- Post-edit automation (formatter, typecheck/tests) and correction artifact loop.
- Baseline supervisor orchestration with Architect/Builder worker separation.

This report is written as a standalone project description and can be used directly for PDF conversion.

---

## 2) Problem Statement and Technical Debt Framing

The primary issue addressed is governance debt in autonomous coding workflows:

- **Trust debt**: generated edits are hard to verify and attribute.
- **Coordination debt**: multi-agent editing can collide without clear ownership.
- **Operational debt**: safety-critical policies are often prompt-only and non-deterministic.
- **Quality debt**: formatting/lint/type/test regressions can accumulate after rapid edits.

Project objective:

1. Bind code mutations to explicit intent IDs.
2. Enforce deterministic controls around tool execution.
3. Persist auditable trace records resilient to file movement.
4. Provide safe multi-agent execution boundaries.

---

## 3) Architecture Overview

## 3.1 Component topology

```text
[User]
  |
  v
[Webview UI]
  |
  | postMessage
  v
[Extension Host: Task + Tool Dispatch]
  |
  | executeTool(toolName, payload)
  v
[Hook Engine]
  |-- PreHooks:
  |    - logHook
  |    - blockIfNoIntent
  |    - scopeAndLockPreHook
  |    - hitlPreHook
  |
  |-- Tool Runtime:
  |    - select_active_intent
  |    - write/edit/apply/exec/etc.
  |
  |-- PostHooks:
       - traceAppenderPostHook
       - postprocessPostHook
```

## 3.2 Chronological flow with payloads and failure branches

```text
T0 User request
   payload: { text: "Refactor auth middleware" }
   |
T1 Model emits tool call
   payload: { tool: "select_active_intent", intent_id: "INT-001" }
   |
T2 PreHooks (deterministic chain)
   - blockIfNoIntent (allows handshake tool)
   - scopeAndLockPreHook (not mutating yet -> pass)
   - hitlPreHook (SAFE -> pass)
   |
T3 Tool executes
   result: <intent_context>...</intent_context>
   |
T4 Model emits mutating tool call
   payload: { path, content/diff, observed_content_hash?, request_scope_expansion? }
   |
T5 PreHooks
   a) no intent -> NO_ACTIVE_INTENT (block)
   b) out of scope -> SCOPE_VIOLATION (block or expansion request)
   c) destructive + reject in modal -> HITL_REJECT (block)
   d) stale observed hash -> STALE_FILE (block)
   e) pass all checks -> continue
   |
T6 Tool writes file
   |
T7 PostHooks
   - traceAppenderPostHook -> append JSONL record with content_hash
   - postprocessPostHook -> format + check-types + tests
   |
T8 Failure branch
   if postprocess fails:
   emit <postprocess_failure_artifact> ... next_action=REPLAN_AND_FIX
```

---

## 4) Implementation Breakdown (by module)

- Dispatch integration:
    - `src/core/assistant-message/presentAssistantMessage.ts`
- Hook engine:
    - `src/hooks/hookEngine.ts`
- Handshake tool:
    - `src/core/tools/SelectActiveIntentTool.ts`
    - `src/core/prompts/tools/native-tools/select_active_intent.ts`
    - `select_active_intent.schema.json`
- Classification and guardrails:
    - `src/hooks/commandClassifier.ts`
    - `src/hooks/preHooks/hitl.ts`
    - `src/hooks/preHooks/scopeAndLock.ts`
- Hashing and trace:
    - `src/utils/computeContentHash.ts`
    - `src/hooks/postHooks/traceAppender.ts`
- Post-edit automation:
    - `src/hooks/postHooks/postprocess.ts`
- Supervisor baseline:
    - `src/supervisor/supervisor.ts`

---

## 5) Complete Field-Level Schemas

## 5.1 `active_intents.yaml` schema (field-level)

```yaml
active_intents: # required: list
    - id: "INT-001" # required: string, unique
      name: "JWT Authentication Migration" # optional: string
      status: "IN_PROGRESS" # optional enum: TODO | IN_PROGRESS | BLOCKED | DONE
      owned_scope: # required: list<string glob>
          - "src/auth/**"
          - "src/middleware/jwt.ts"
      constraints: # optional: list<string>
          - "Must preserve backward compatibility with Basic Auth."
      acceptance_criteria: # optional: list<string>
          - "Unit tests in tests/auth pass."
```

Field semantics:

- `id`: canonical intent identity used in handshake and ledger linkage.
- `owned_scope`: authorization boundary for mutating tools.
- `constraints`: must be injected as guardrail context.
- `acceptance_criteria`: used for completion checks and re-planning.

## 5.2 `intent_map.md` schema (structured markdown contract)

```md
# Intent Map

## <INTENT_ID> — <Intent Name> # required section

- **Business intent:** <text> # required
- **Owned scope:** # required list
    - <glob>
- **Key AST anchors:** # optional list
    - <function/class/symbol>
- **Depends on:** # optional list
    - <INTENT_ID>
```

Operational interpretation:

- `Owned scope` here should match or refine `active_intents.yaml`.
- `Key AST anchors` improves targeted patching and review clarity.

## 5.3 `agent_trace.jsonl` schema (field-level)

Per line (one record):

```json
{
	"id": "uuid-or-hook-invocation-id",
	"timestamp": "RFC3339",
	"vcs": { "revision_id": "git_sha" },
	"files": [
		{
			"relative_path": "src/auth/middleware.ts",
			"conversations": [
				{
					"url": "roo://task/<task>/instance/<id>",
					"contributor": {
						"entity_type": "AI",
						"model_identifier": "roo-code"
					},
					"ranges": [
						{
							"start_line": 15,
							"end_line": 45,
							"content_hash": "sha256:..."
						}
					],
					"related": [{ "type": "specification", "value": "INT-001" }],
					"meta": {
						"mutation_class": "AST_REFACTOR|INTENT_EVOLUTION|UNKNOWN",
						"hook_invocation_id": "..."
					}
				}
			]
		}
	]
}
```

---

## 6) Agent Flow and Hook Behavior Details

## 6.1 PreHook guarantees

- Intent handshake required for mutating tools.
- Command classification into SAFE/DESTRUCTIVE.
- Scope boundary enforcement by `owned_scope`.
- Optional scope expansion request with explicit human approval.
- HITL reject branch emits standardized JSON tool error.
- Stale-file detection via `observed_content_hash`.

## 6.2 PostHook guarantees

- Trace persistence for successful destructive writes.
- Deterministic post-edit processing:
    - formatting on modified files,
    - type/lint/test verification commands,
    - failure artifact injection with `REPLAN_AND_FIX`.

---

## 7) Design Decisions and Trade-offs

1. **Deterministic middleware vs prompt-only policy**

    - Benefit: enforceability and auditability.
    - Cost: additional engineering complexity and state handling.

2. **AST-first hash with normalized fallback**

    - Benefit: improved stability under formatting changes.
    - Cost: not a full semantic equivalence proof.

3. **JSONL append ledger**

    - Benefit: simple and transparent append-only history.
    - Cost: no built-in indexing; querying requires additional tooling.

4. **Modal approvals for destructive/scope-expansion paths**

    - Benefit: explicit human consent boundary.
    - Cost: can slow automation when frequent.

5. **Post-edit check pipeline in hook path**
    - Benefit: immediate quality feedback loop.
    - Cost: increased execution time per mutating turn.

---

## 8) Reproduction Guide (Clean Clone)

## 8.1 Setup

```bash
git clone <your-fork-url>
cd governed-ai-native-ide
pnpm install
```

## 8.2 Run extension host

```bash
# Preferred
# Open workspace in VS Code/Cursor and press F5

# CLI alternative
code --extensionDevelopmentPath ./src
```

## 8.3 Prepare orchestration sidecar

Create:

- `.orchestration/active_intents.yaml`
- `.orchestration/intent_map.md`
- `.orchestration/agent_trace.jsonl` (auto-appended during writes)

## 8.4 Validate core guarantees

```bash
pnpm -C src check-types
pnpm -C src test -- ../tests/hook_enforcement.spec.ts ../tests/trace_and_hash.spec.ts
```

Manual:

1. `select_active_intent("INT-001")`
2. run in-scope write (should pass)
3. run out-of-scope write (expect `SCOPE_VIOLATION`)
4. run stale hash write (expect `STALE_FILE`)
5. inspect `.orchestration/agent_trace.jsonl` append

---

## 9) Rubric Evaluation Mapping

## 9.1 Intent-AST Correlation

- Handshake binds turns to intent ID.
- Trace records include `related.specification = <INT-ID>`.
- Range-level `content_hash` improves spatially robust attribution.

## 9.2 Hook Architecture

- Central `executeTool(...)` gateway.
- Composable PreHooks and PostHooks.
- Deterministic allow/block semantics with structured tool errors.

## 9.3 Orchestration

- Supervisor provides Architect/Builder worker model.
- Write partitioning through scope assignments.
- Collision detection through optimistic locking.

---

## 10) Achievement Summary: Fully vs Partially Implemented

## 10.1 Fully implemented components

- **Intent handshake (`select_active_intent`)**  
  Addresses trust debt by requiring explicit intent before mutation.

- **Hook Engine with Pre/Post chaining**  
  Addresses operational debt by enforcing deterministic control points.

- **HITL destructive authorization**  
  Addresses safety debt by adding explicit user approvals.

- **Scope enforcement + optimistic locking**  
  Addresses coordination debt by blocking out-of-scope and stale writes.

- **Trace ledger with content hashing**  
  Addresses attribution debt by linking intent, ranges, and durable hashes.

- **Post-edit automation + failure artifacts**  
  Addresses quality debt by ensuring checks run and failures feed correction loops.

- **Critical tests + CI workflow + demo scripts**  
  Addresses validation debt by formalizing reproducible verification.

## 10.2 Partially implemented components

- **Semantic mutation classification**

    - Implemented heuristic (`AST_REFACTOR` vs `INTENT_EVOLUTION`) using diff structure.
    - Not yet a full AST semantic classifier.

- **Supervisor orchestration runtime integration**

    - Implemented baseline module and demo flow.
    - Not yet fully wired to live concurrent task scheduler for automatic worker spawning.

- **Ledger query/index layer**
    - JSONL append is implemented.
    - Advanced indexed analytics/search over ledger is not yet implemented.

## 10.3 Net project impact

The project significantly reduces trust, coordination, operational, and quality debt by moving critical governance from probabilistic prompt behavior into deterministic extension-host middleware, while preserving practical developer usability through explicit artifacts and guided recovery loops.
