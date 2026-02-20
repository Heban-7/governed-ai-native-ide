# Intent Map

This file maps business intent IDs to physical code areas and semantic responsibilities.

## INT-001 — JWT Authentication Migration

- **Business intent:** migrate auth flow to JWT while preserving compatibility.
- **Owned scope:**
    - `src/auth/**`
    - `src/middleware/jwt.ts`
    - `tests/auth/**`
- **Key AST anchors:**
    - `authenticateUser()`
    - `issueJwtToken()`
    - `validateJwt()`
- **Depends on:**
    - `INT-002` traceability updates for audit trails.

## INT-002 — Agent Trace Ledger Hardening

- **Business intent:** ensure generated edits are attributable and auditable.
- **Owned scope:**
    - `src/hooks/**`
    - `src/utils/computeContentHash.ts`
    - `.orchestration/**`
- **Key AST anchors:**
    - `executeTool()`
    - `traceAppenderPostHook()`
    - `computeContentHash()`

## Notes

- Scope expansion requires human approval and must be recorded in tool error/meta flow.
- Out-of-scope writes should return `SCOPE_VIOLATION`.
