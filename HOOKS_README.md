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
