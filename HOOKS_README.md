# Hook Engine (STEP 2)

This project now includes a minimal deterministic Hook Engine in:

- `src/hooks/hookEngine.ts`

## Why

Hooks run in code (deterministic), not model interpretation (probabilistic).  
This gives a hard middleware boundary before/after tool execution.

## API

```ts
registerPreHook(name, fn)
registerPostHook(name, fn)
executeTool(toolName, payload, { session, askApproval, pushToolResult, handleError, execute })
```

- `registerPreHook`: add a pre-execution hook
- `registerPostHook`: add a post-execution hook
- `executeTool`: wrapper that:
    1. creates invocation UUID
    2. runs pre-hooks in registration order
    3. executes tool (if allowed)
    4. runs post-hooks
    5. logs each phase with invocation id

## Hook signatures

### Pre-hook

```ts
type PreHookFn = (context) => Promise<{ allow: boolean; reason?: string } | void>
```

If `allow: false`, execution is cancelled and the reason is returned as tool result.

### Post-hook

```ts
type PostHookFn = (context) => Promise<void>
```

Post hooks always run, including blocked/error outcomes.

## Built-in demo hooks

Registered via `registerDefaultHooks()`:

- `logHook`: logs incoming payload + UUID.
- `blockIfNoIntent`: blocks mutating tools when no active intent is selected in session.
- `hitlPreHook`: classifies destructive operations and opens a native VS Code modal for Approve/Reject.

## Integration point

Tool dispatch in:

- `src/core/assistant-message/presentAssistantMessage.ts`

All tool invocations are routed through `executeTool(...)`.  
Dynamic MCP calls (`mcp_tool_use`) and `use_mcp_tool` both pass through Hook Engine.

## HITL pause example

Because hooks are async, a pre-hook can pause execution and wait for UI approval:

```ts
registerPreHook("hitlApproval", async ({ askApproval }) => {
	const approved = await askApproval?.("tool", JSON.stringify({ tool: "execute_command" }))
	return approved ? { allow: true } : { allow: false, reason: "User rejected tool via HITL pre-hook." }
})
```

This pauses the Promise chain until the user responds.

## Command classification (STEP 3)

Implemented in:

- `src/hooks/commandClassifier.ts`

Policy:

- SAFE: `read_file`, `stat`, `list`, `list_files`
- DESTRUCTIVE: `write_file`/`write_to_file`, `delete`, `exec_bash`/`execute_command`, edit/apply tools

Mutation class heuristic:

- `AST_REFACTOR` vs `INTENT_EVOLUTION` inferred from simple unified-diff structural patterns when available.

## Native modal flow (STEP 3)

Implemented in:

- `src/hooks/preHooks/hitl.ts`

For destructive tools, pre-hook shows:

- active intent id
- affected files
- mutation class
- diff preview (first 20 lines when available)

Then:

- Approve -> continue
- Reject -> serialize standardized JSON error into tool result and cancel execution

Sample reject JSON:

```json
{
	"type": "tool_error",
	"code": "HITL_REJECT",
	"message": "Destructive operation rejected by user via HITL pre-hook.",
	"meta": {
		"invocation_id": "uuid-v4",
		"intent_id": "INT-001",
		"tool_name": "write_to_file",
		"normalized_tool_name": "write_to_file",
		"risk": "DESTRUCTIVE",
		"mutation_class": "INTENT_EVOLUTION",
		"affected_files": ["src/auth/middleware.ts"]
	}
}
```

## Scope enforcement + optimistic locking (STEP 5)

Implemented in:

- `src/hooks/preHooks/scopeAndLock.ts`

Behavior for mutating tools:

1. Load active intent `owned_scope` globs from `.orchestration/active_intents.yaml`.
2. Block out-of-scope writes with standardized `SCOPE_VIOLATION` error.
3. Support `request_scope_expansion` payload with human approval modal (`Approve Expansion`/`Reject`).
4. If `observed_content_hash` is provided, compare with current file hash before write.
5. On mismatch, block with standardized `STALE_FILE` error and current diff preview.

References:

- Error JSON examples: `scope_and_lock_examples.md`
- Collision test steps: `stale_file_collision_test.md`

## Validation

- Unit tests: `src/hooks/__tests__/hookEngine.spec.ts`
- Unit tests: `src/hooks/__tests__/commandClassifier.spec.ts`
- Manual flow: `test_select_active_intent.md`

# Hook Engine (STEP 2)

This project now includes a minimal deterministic Hook Engine in:

- `src/hooks/hookEngine.ts`

## Why

Hooks run in code (deterministic), not model interpretation (probabilistic).  
This gives a hard middleware boundary before/after tool execution.

## API

```ts
registerPreHook(name, fn)
registerPostHook(name, fn)
executeTool(toolName, payload, { session, askApproval, pushToolResult, handleError, execute })
```

- `registerPreHook`: add a pre-execution hook
- `registerPostHook`: add a post-execution hook
- `executeTool`: wrapper that:
    1. creates invocation UUID
    2. runs pre-hooks in registration order
    3. executes tool (if allowed)
    4. runs post-hooks
    5. logs each phase with invocation id

## Hook signatures

### Pre-hook

```ts
type PreHookFn = (context) => Promise<{ allow: boolean; reason?: string } | void>
```

If `allow: false`, execution is cancelled and the reason is returned as tool result.

### Post-hook

```ts
type PostHookFn = (context) => Promise<void>
```

Post hooks always run, including blocked/error outcomes.

## Built-in demo hooks

Registered via `registerDefaultHooks()`:

- `logHook`: logs incoming payload + UUID.
- `blockIfNoIntent`: blocks mutating tools when no active intent is selected in session.

## Integration point

Tool dispatch in:

- `src/core/assistant-message/presentAssistantMessage.ts`

All tool invocations are routed through `executeTool(...)`.  
Dynamic MCP calls (`mcp_tool_use`) and `use_mcp_tool` both pass through Hook Engine.

## HITL pause example

Because hooks are async, a pre-hook can pause execution and wait for UI approval:

```ts
registerPreHook("hitlApproval", async ({ askApproval }) => {
	const approved = await askApproval?.("tool", JSON.stringify({ tool: "execute_command" }))
	return approved ? { allow: true } : { allow: false, reason: "User rejected tool via HITL pre-hook." }
})
```

This pauses the Promise chain until the user responds.

## Validation

- Unit tests: `src/hooks/__tests__/hookEngine.spec.ts`
- Manual flow: `test_select_active_intent.md`
