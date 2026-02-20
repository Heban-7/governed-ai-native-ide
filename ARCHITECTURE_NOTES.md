# ARCHITECTURE_NOTES (STEP 0)

This note maps the real Roo Code extension execution path for:

- `execute_command`
- `write_to_file`
- system prompt construction

It also marks the best hook insertion points for the TRP1 governed-agent architecture.

## 1) Extension host startup path

- Extension manifest: `src/package.json`
    - `"main": "./dist/extension.js"`
- Activation entrypoint: `src/extension.ts` (`activate(context)`)
- Debug launch config: `.vscode/launch.json`
    - Launch type: `extensionHost`
    - `--extensionDevelopmentPath=${workspaceFolder}/src`
- Dev watch/build tasks: `.vscode/tasks.json`
    - default build task = `watch` (depends on `watch:webview`, `watch:bundle`, `watch:tsc`)

## 2) Tool execution loop (where execute/write are really handled)

### Dispatcher (central routing point)

- File: `src/core/assistant-message/presentAssistantMessage.ts`
- Function: `presentAssistantMessage(cline: Task)`
- Key routing branches:
    - `case "write_to_file"` -> `writeToFileTool.handle(...)`
    - `case "execute_command"` -> `executeCommandTool.handle(...)`

This is the best place for a **global PreToolUse middleware** because every tool call passes here first.

### execute_command implementation

- Schema definition (LLM-visible JSON schema):
    - `src/core/prompts/tools/native-tools/execute_command.ts`
- Runtime implementation:
    - `src/core/tools/ExecuteCommandTool.ts`
    - Class: `ExecuteCommandTool`
    - Methods:
        - `execute(params, task, callbacks)`
        - `executeCommandInTerminal(task, options)`

### write_to_file implementation

- Schema definition (LLM-visible JSON schema):
    - `src/core/prompts/tools/native-tools/write_to_file.ts`
- Runtime implementation:
    - `src/core/tools/WriteToFileTool.ts`
    - Class: `WriteToFileTool`
    - Methods:
        - `execute(params, task, callbacks)`
        - `handlePartial(...)`

### Tool schema registry

- File: `src/core/prompts/tools/native-tools/index.ts`
- Function: `getNativeTools()`

This is where a new tool like `select_active_intent` must be registered.

## 3) System prompt / prompt builder locations

- Primary builder:
    - File: `src/core/prompts/system.ts`
    - Export: `SYSTEM_PROMPT(...)`
    - Internal: `generatePrompt(...)`
- Task-time system prompt generation:
    - File: `src/core/task/Task.ts`
    - Method: `private async getSystemPrompt(): Promise<string>`
    - Called before API requests.
- Preview path from webview settings UI:
    - File: `src/core/webview/generateSystemPrompt.ts`
    - Function: `generateSystemPrompt(provider, message)`

## 4) Recommended hook insertion points (TRP1 mapping)

### A. PreToolUse global hook (best first insertion)

- File: `src/core/assistant-message/presentAssistantMessage.ts`
- Insert in `case "tool_use"` flow before dispatch `switch (block.name)`.
- Responsibilities:
    - Validate active intent is selected before mutating tools run.
    - Command risk classification before `execute_command`.
    - Scope checks before `write_to_file`.
    - Block with structured error tool_result if policy fails.

### B. execute_command hook specifics

- File: `src/core/tools/ExecuteCommandTool.ts`
- Inside `ExecuteCommandTool.execute(...)`:
    - Pre-exec gate: right before `executeCommandInTerminal(...)` call.
    - Rejection path already exists via `askApproval("command", ...)`.
- Post-exec logging:
    - Right after terminal result is returned and before `pushToolResult(...)`.
    - Append trace record for command action into `.orchestration/agent_trace.jsonl`.

### C. write_to_file hook specifics

- File: `src/core/tools/WriteToFileTool.ts`
- Inside `WriteToFileTool.execute(...)`:
    - Pre-write scope validation: before `askApproval(...)`.
    - Post-write trace/hash logging: immediately after successful save (`saveDirectly` / `saveChanges`) and before final `pushToolResult(...)`.

### D. Intent handshake tool insertion

- Add schema file:
    - `src/core/prompts/tools/native-tools/select_active_intent.ts` (new)
- Register schema:
    - `src/core/prompts/tools/native-tools/index.ts`
- Add runtime tool:
    - `src/core/tools/SelectActiveIntentTool.ts` (new)
- Dispatch route:
    - Add `case "select_active_intent"` in `src/core/assistant-message/presentAssistantMessage.ts`

### E. System prompt protocol enforcement

- File: `src/core/prompts/system.ts`
- Add mandatory protocol text near role/objective section:
    - "First action must call `select_active_intent(intent_id)` before any mutating tool."
- Ensure this appears in both normal task path and preview path (`generateSystemPrompt.ts` already calls `SYSTEM_PROMPT`).

## 5) Ambiguous paths (top candidates)

If searching by concept rather than exact symbol, these are the top candidates:

1. Tool dispatch loop:
    - `src/core/assistant-message/presentAssistantMessage.ts`
    - Why: contains explicit switch cases for `execute_command` and `write_to_file`.
2. Task request construction:
    - `src/core/task/Task.ts`
    - Why: builds tools array + gets system prompt + sends API requests.
3. Tool schema registry:
    - `src/core/prompts/tools/native-tools/index.ts`
    - Why: source of truth for what callable tools the model sees.

## 6) Step 0 sanity outputs to capture

When running dev host successfully, you should observe:

- extension host window opens with Roo Code extension loaded.
- Roo activity bar icon appears.
- no fatal startup errors in Extension Host logs.
- on a test prompt, tool approval UI appears for mutating operations.

# STEP 0 Architecture Notes (Roo Code)

## Scope

This note identifies where `execute_command`, `write_to_file`, and system prompt construction are implemented, plus practical hook insertion points for intent/code traceability instrumentation.

## 1) `execute_command` path

- Tool schema (LLM-facing contract):

    - `src/core/prompts/tools/native-tools/execute_command.ts`
    - Defines tool name, parameters (`command`, `cwd`, `timeout`), and description.

- Runtime implementation:

    - `src/core/tools/ExecuteCommandTool.ts`
    - Main entry: `ExecuteCommandTool.execute(...)`
    - Terminal execution path: `executeCommandInTerminal(...)`

- Tool dispatch (where tool block is routed):
    - `src/core/assistant-message/presentAssistantMessage.ts`
    - `case "execute_command": ... executeCommandTool.handle(...)`

### Recommended hook points for traceability

1. **Pre-approval intent capture**

    - File: `src/core/tools/ExecuteCommandTool.ts`
    - Area: just before/after `askApproval("command", canonicalCommand)` in `execute(...)`
    - Why: capture "model intent" before execution.

2. **Post-execution result capture**

    - File: `src/core/tools/ExecuteCommandTool.ts`
    - Area: inside `executeCommandInTerminal(...)` near result return blocks (completed, timed out, background).
    - Why: capture command outcome (`exitCode`, timeout, truncated output artifact).

3. **Dispatch-level correlation ID**
    - File: `src/core/assistant-message/presentAssistantMessage.ts`
    - Area: `case "execute_command"` branch before `handle(...)`
    - Why: correlate assistant tool-call ID with downstream runtime events.

## 2) `write_to_file` path

- Tool schema (LLM-facing contract):

    - `src/core/prompts/tools/native-tools/write_to_file.ts`
    - Defines tool name, parameters (`path`, `content`), and behavior constraints.

- Runtime implementation:

    - `src/core/tools/WriteToFileTool.ts`
    - Main entry: `WriteToFileTool.execute(...)`
    - Streams/partial handling: `handlePartial(...)`

- Tool dispatch:
    - `src/core/assistant-message/presentAssistantMessage.ts`
    - `case "write_to_file": ... writeToFileTool.handle(...)`

### Recommended hook points for traceability

1. **Pre-write intent capture**

    - File: `src/core/tools/WriteToFileTool.ts`
    - Area: after path/content validation and before `askApproval(...)`.
    - Why: capture intended file target and edit summary before user approval.

2. **Post-write persistence capture**

    - File: `src/core/tools/WriteToFileTool.ts`
    - Area: after `saveDirectly(...)` / `saveChanges(...)` and before `pushToolResult(...)`.
    - Why: capture write outcome and diff metadata at commit point.

3. **File-context linkage**
    - File: `src/core/tools/WriteToFileTool.ts`
    - Area: near `task.fileContextTracker.trackFileContext(...)`.
    - Why: reuse existing context tracking to attach provenance metadata.

## 3) System prompt / prompt-builder path

- Preview entrypoint (webview action):

    - `src/core/webview/generateSystemPrompt.ts`
    - Calls `SYSTEM_PROMPT(...)` with mode/settings/context.

- Core builder:

    - `src/core/prompts/system.ts`
    - Main API: `SYSTEM_PROMPT(...)`
    - Internal composition: `generatePrompt(...)`
    - Assembles sections (rules, capabilities, tools guidance, system info, objective, custom instructions).

- Tool list assembly/filtering (affects what prompt/tooling the model receives):
    - `src/core/prompts/tools/native-tools/index.ts` (`getNativeTools(...)`)
    - `src/core/prompts/tools/filter-tools-for-mode.ts` (`filterNativeToolsForMode(...)`)
    - `src/core/task/build-tools.ts` (`buildNativeToolsArrayWithRestrictions(...)`)

### Recommended hook points for traceability

1. **Prompt snapshot + hash**

    - File: `src/core/webview/generateSystemPrompt.ts`
    - Area: immediately after `const systemPrompt = await SYSTEM_PROMPT(...)`
    - Why: record exact prompt variant shown/generated for audit.

2. **Section-level provenance**

    - File: `src/core/prompts/system.ts`
    - Area: around base prompt assembly in `generatePrompt(...)`.
    - Why: capture which sections/rules/mode settings were included.

3. **Allowed-tools snapshot**
    - File: `src/core/task/build-tools.ts`
    - Area: after `filteredTools` and `allowedFunctionNames` are built.
    - Why: tie prompt/tool constraints to later tool-call behavior.

## Ambiguous-but-important candidates (top 3) for prompt-builder ownership

1. `src/core/prompts/system.ts`
    - Most likely canonical prompt composition source (`SYSTEM_PROMPT`, `generatePrompt`).
2. `src/core/webview/generateSystemPrompt.ts`
    - UI/preview path where prompt generation is invoked with live provider state.
3. `src/core/task/Task.ts`
    - Runtime conversation path imports and uses `SYSTEM_PROMPT` during task execution.

## Suggested event schema (minimal)

- `trace_id`
- `task_id`
- `tool_call_id`
- `event_type` (`intent`, `approval`, `execution_start`, `execution_end`, `write_start`, `write_end`, `prompt_generated`)
- `tool_name`
- `payload_json` (sanitized)
- `timestamp`
