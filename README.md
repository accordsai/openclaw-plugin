# Vaultclaw MCP Approval Handoff Plugin

OpenClaw plugin that auto-handles Vaultclaw MCP approval handoff during agent tool runs.

When a tool returns `MCP_APPROVAL_REQUIRED`, the plugin:

- extracts `error.details.approval.next_action.arguments.handle`
- notifies the user to approve/deny in Vaultclaw UI
- asynchronously invokes `vaultclaw_approval_wait`
- posts a single terminal update for `ALLOW`, `DENY`, or timeout
- on `ALLOW`, auto-triggers one follow-up `agent` run for the same `sessionKey` so
  compound flows continue without a manual "approved" message

No second manual CLI command is required.

## Install

### Option A: npm package

```bash
openclaw plugins install @vaultclaw/vaultclaw-mcp-approval-handoff
```

### Option B: one-shot installer script (local checkout)

```bash
./scripts/install.sh
```

Optional npm/package override:

```bash
./scripts/install.sh @vaultclaw/vaultclaw-mcp-approval-handoff
```

## Config

Plugin id: `vaultclaw-mcp-approval-handoff`

```json
{
  "plugins": {
    "entries": {
      "vaultclaw-mcp-approval-handoff": {
        "enabled": true,
        "config": {
          "enabled": true,
          "pollIntervalMs": 1500,
          "maxWaitMs": 600000,
          "commandTimeoutMs": 720000,
          "maxConcurrentWaits": 10,
          "reconcileOnValidationError": true,
          "reconcileOnUnknownTerminal": true,
          "reconcileTimeoutMs": 15000
        }
      }
    }
  }
}
```

Validation rules:

- `pollIntervalMs`: `250..10000`
- `maxWaitMs`: `1000..3600000`
- `commandTimeoutMs > maxWaitMs`
- `maxConcurrentWaits >= 1`
- `reconcileTimeoutMs`: `1000..60000`

## Behavior

- Scope: MCP tool results in OpenClaw agent runs.
- Non-blocking: wait worker runs async from `after_tool_call`.
- Supported handles: `JOB` and `PLAN_RUN`.
- Dedupe key: `(session_id, challenge_id, pending_id, run_id/job_id)`.
- Session lifecycle: pending waits are canceled on `before_reset` and `session_end`.
- Retries: transient transport failures retry with backoff (`1s, 2s, 4s, 8s, 16s`, max 5 attempts).
- No-retry terminal categories: validation/auth/timeouts.
- Reconciliation: when wait payloads are malformed or terminal status is unknown, plugin attempts read-only reconciliation through `vaultclaw_approvals_pending_get` and `vaultclaw_job_get`.
- Unknown terminal outcomes are surfaced explicitly (not as timeout) with retry guidance.
- If `ALLOW` is confirmed but auto-resume fails, plugin posts a manual fallback instruction (`reply approved` or rerun request).

## Operational Limits

- Wait calls are executed through the local Gateway HTTP route: `POST /tools/invoke`.
- Gateway auth must allow that route (`token`/`password` via config or env, or `none`/`trusted-proxy` mode).
- Status updates are posted through system events + heartbeat wake and require a valid `sessionKey`.
- At most `maxConcurrentWaits` approval workers run in parallel.

## Observability

Structured plugin logs include:

- `approval_detected`
- `wait_started`
- `wait_completed`
- `wait_failed`
- `wait_canceled`
- `wait_retry`
- `terminal_outcome`
- `resume_started`
- `resume_completed`
- `resume_failed`
- `cleanup`

Each log includes correlation keys when available:

- `session_id`
- `challenge_id`
- `pending_id`
- `run_id` / `job_id`

## Example Transcript

1. User: "Trash the newsletter in Gmail from yesterday."
2. Tool result: approval challenge returned (`MCP_APPROVAL_REQUIRED`).
3. Plugin post: "Approval required in Vaultclaw UI. Waiting up to 10 minutes... (challenge_id=..., pending_id=..., run_id=...)"
4. User approves in Vaultclaw UI.
5. Plugin post: "Approval allowed in Vaultclaw UI. Continuing automatically. (...ids...)"

## Development

```bash
npm install
npm test
```
