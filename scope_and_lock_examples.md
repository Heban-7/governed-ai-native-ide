# Scope and Lock Error JSON Examples

## SCOPE_VIOLATION

```json
{
	"type": "tool_error",
	"code": "SCOPE_VIOLATION",
	"message": "Scope violation: intent 'INT-001' is not authorized to edit 'src/billing/charge.ts'. Request scope expansion.",
	"meta": {
		"invocation_id": "1f8a2d1a-2d5a-49bf-a305-57f9f462d8af",
		"intent_id": "INT-001",
		"tool_name": "write_to_file",
		"file_path": "src/billing/charge.ts",
		"owned_scope": ["src/auth/**", "src/middleware/jwt.ts"],
		"request_scope_expansion": {
			"type": "request_scope_expansion",
			"required": true,
			"schema": { "additional_globs": ["string"], "reason": "string" },
			"example": {
				"type": "request_scope_expansion",
				"intent_id": "INT-001",
				"additional_globs": ["src/billing/**"],
				"reason": "Need to update billing authorization checks for this intent."
			}
		}
	}
}
```

## STALE_FILE

```json
{
	"type": "tool_error",
	"code": "STALE_FILE",
	"message": "Stale file detected: current file content hash does not match observed_content_hash. Re-read the file and recalculate your patch.",
	"meta": {
		"invocation_id": "7f8f2f57-3216-46d6-b7fc-f56e7482a42f",
		"intent_id": "INT-001",
		"tool_name": "write_to_file",
		"file_path": "src/auth/middleware.ts",
		"observed_content_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
		"current_content_hash": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
		"current_diff": "--- src/auth/middleware.ts\n+++ src/auth/middleware.ts\n@@ ..."
	}
}
```
