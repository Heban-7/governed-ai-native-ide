# Prioritized Test Plan (STEP 8)

Priority is ordered by submission risk and rubric impact.

## P0 (must not break)

1. **Handshake enforcement**: mutating tools blocked when `select_active_intent` has not been called.
2. **Hook interception order**: pre-hooks run before tool execution; post-hooks run after.
3. **Scope enforcement**: out-of-scope write returns `SCOPE_VIOLATION`.
4. **Optimistic locking**: stale `observed_content_hash` returns `STALE_FILE`.
5. **Trace writing**: destructive write creates valid JSONL entry in `.orchestration/agent_trace.jsonl`.

## P1 (high confidence)

6. **Content hash determinism**: equivalent AST forms (formatting/comments) yield same hash.
7. **Fallback hash determinism**: invalid syntax uses stable normalized-string hash.
8. **HITL reject serialization**: destructive rejection returns standardized `tool_error` JSON.

## P2 (demo robustness)

9. **Postprocess failure artifact**: failing check-types/tests inject correction artifact and set failure flag.
10. **Supervisor scope assignment**: Architect/Builder workers are blocked outside assigned scopes.
