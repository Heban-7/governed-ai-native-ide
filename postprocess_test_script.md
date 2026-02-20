# Postprocess Hook Test Script (STEP 6)

## What this validates

- Formatter runs automatically after mutating tools.
- Type/lint/test failures are captured as a structured failure artifact.
- Agent receives artifact context and is asked to re-plan (`REPLAN_AND_FIX`).

## Local commands

From repo root:

```powershell
pnpm -C src check-types
pnpm -C src test -- src/hooks/__tests__/hookEngine.spec.ts src/hooks/__tests__/commandClassifier.spec.ts src/hooks/__tests__/scopeAndLock.spec.ts src/utils/__tests__/computeContentHash.spec.ts
```

## Manual correction-loop simulation

1. Start extension host.
2. Create an intentional type failure in a file under active intent scope.
3. Ask the agent to perform a mutating edit (`write_to_file` / `apply_diff`).
4. Observe post-hook behavior:
    - Prettier runs on modified files.
    - `pnpm -C src check-types` and `pnpm -C src test -- --runInBand` run.
    - If any command fails, an artifact block is appended to agent context:

```xml
<postprocess_failure_artifact>
{ ...json... }
</postprocess_failure_artifact>
PostToolUseFailure detected. Re-plan and fix the failures before attempting completion.
```

5. Agent should propose a fix plan and execute correction steps.

## Sample interaction (abridged)

- **Tool result after write:** success message for file edit.
- **Post-hook injected artifact:** contains failing command stderr and `next_action: "REPLAN_AND_FIX"`.
- **Next assistant action:** reads failure artifact, updates plan, fixes type/test issue, re-runs checks.
