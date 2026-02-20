# Test: select_active_intent Handshake

## Preconditions

1. Start Roo extension in dev host (F5).
2. In your workspace root, create `.orchestration/active_intents.yaml`:

```yaml
active_intents:
    - id: "INT-001"
      owned_scope:
          - "src/auth/**"
          - "src/middleware/jwt.ts"
      constraints:
          - "Must keep backward compatibility with Basic Auth"
          - "Do not introduce external auth provider"
      acceptance_criteria:
          - "Unit tests in tests/auth pass"
          - "Existing login flow still works"
```

## Test A — Successful handshake

Prompt in Roo chat:

`Call select_active_intent with intent_id INT-001.`

Expected output:

- Tool call succeeds.
- Tool result returns an XML block:
    - `<intent_context>`
    - `<id>INT-001</id>`
    - `<owned_scope>...</owned_scope>`
    - `<constraints>...</constraints>`
    - `<acceptance_criteria>...</acceptance_criteria>`

## Test B — Missing handshake is blocked

Start a fresh task/conversation (no prior intent selected), then prompt:

`Write a file named test.txt with content hello`

Expected output:

- Attempted mutating tool (`write_to_file`, `apply_diff`, `edit_file`, etc.) is blocked in pre-hook.
- Tool result includes deterministic error text:
    - `Handshake required: you must call select_active_intent(intent_id) first.`

## Test C — Handshake then write is allowed

1. First prompt:
    - `Call select_active_intent with intent_id INT-001`
2. Then prompt:
    - `Create src/auth/intent-check.txt and write: ok`

Expected output:

- Handshake succeeds.
- Mutating tool now proceeds normally (subject to existing approval UI).

## Optional quick terminal checks

From repository root:

```powershell
pnpm -C src check-types
pnpm -C src test -- --runInBand
```
