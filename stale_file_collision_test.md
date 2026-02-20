# Stale-File Collision Test (STEP 5)

## 1) Run unit test

From repo root:

```powershell
pnpm -C src test -- src/hooks/__tests__/scopeAndLock.spec.ts
```

Expected:

- `blocks write outside owned_scope with SCOPE_VIOLATION`
- `blocks stale write when observed_content_hash mismatches current hash`

## 2) Manual collision simulation in extension

1. Create `.orchestration/active_intents.yaml`:

```yaml
active_intents:
    - id: "INT-001"
      owned_scope:
          - "src/auth/**"
```

2. Ensure `src/auth/middleware.ts` exists and note its current hash (from logs or a helper script).
3. In one terminal/editor, modify `src/auth/middleware.ts` and save.
4. Ask the agent to run a mutating tool on `src/auth/middleware.ts` using the **old** `observed_content_hash`.

Expected:

- Pre-hook blocks the write.
- Agent receives a `tool_error` with `code: "STALE_FILE"`.
- Payload includes both `observed_content_hash` and `current_content_hash`, plus diff preview.
