# Vaultclaw MCP Approval Handoff Plugin

OpenClaw plugin that auto-handles Vaultclaw MCP approval handoff during agent tool runs.

Primary supported backend path: OpenClaw Gateway `POST /tools/invoke` against direct `vaultclaw_*`
tools exposed by plugin id `vaultclaw-openclaw-bridge`.

When a tool returns `MCP_APPROVAL_REQUIRED`, the plugin:

- extracts `error.details.approval.next_action.arguments.handle`
- notifies the user to approve/deny in Vaultclaw UI
- asynchronously invokes `vaultclaw_approval_wait`
- posts a single terminal update for `ALLOW`, `DENY`, or timeout
- on `ALLOW`, first runs a fast `vaultclaw_job_get` completion probe and posts an immediate
  final success callback when the job is already terminal; if inconclusive, falls back to one
  follow-up `agent` run for the same `sessionKey`

No second manual CLI command is required.

## Responsibility Split

| Component | Responsibility |
| --- | --- |
| `vaultclaw-openclaw-bridge` | Exposes direct `vaultclaw_*` tools inside OpenClaw. |
| `vaultclaw-mcp-approval-handoff` | Handles `MCP_APPROVAL_REQUIRED`, waits, posts terminal outcome, and auto-resumes on `ALLOW`. |

## Install

### Option A: npm package

```bash
openclaw plugins install @vaultclaw/vaultclaw-mcp-approval-handoff
```

### Option B: one-shot installer script (local checkout)

```bash
./scripts/install.sh
```

This installer also applies OpenClaw core hotfixes (Telegram slash-command reload + plugin command session context passthrough for async follow-ups) and restarts the gateway automatically.

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
          "allowMcporterFallback": false,
          "reconcileOnValidationError": true,
          "reconcileOnUnknownTerminal": true,
          "reconcileOnWaitError": true,
          "reconcileTimeoutMs": 15000,
          "vaultCommand": {
            "enabled": true,
            "defaultEnabled": true,
            "defaultMode": "hybrid",
            "autoDisableTelegramNativeCommands": true,
            "sessionModeTtlMs": 604800000,
            "maxConcurrentRuns": 5,
            "enableCoreFallback": true,
            "coreFallbackTimeoutMs": 30000,
            "resolverTool": "vaultclaw_route_resolve",
            "resolverTimeoutMs": 8000,
            "enrichmentGlobalTimeoutMs": 10000,
            "enrichmentTaskTimeoutMs": 6000,
            "deterministicDomains": [
              "google.gmail",
              "generic.http"
            ]
          }
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
- `vaultCommand.enrichmentGlobalTimeoutMs`: `1000..60000`
- `vaultCommand.enrichmentTaskTimeoutMs`: `1000..60000` and `<= enrichmentGlobalTimeoutMs`

Legacy note:

- `allowMcporterFallback` is a deprecated escape hatch for older stacks and is not recommended.
- Keep `allowMcporterFallback=false` for the standard bridge-based runtime path.

## Deterministic `/vault` Command

When enabled, the plugin registers `/vault`:

- `/vault on [hybrid|strict]`
- `/vault off`
- `/vault status`
- `/vault <natural language request>`

Mode semantics:

- `HYBRID` (default): vault-eligible requests use deterministic route/execute; non-eligible requests auto-fallback to normal OpenClaw flow.
- `STRICT`: vault-eligible requests only; non-eligible requests are rejected with guidance.

Resolver requirement:

- `/vault` deterministic path requires MCP tool `vaultclaw_route_resolve` (from updated `accords-mcp`).
- During missing-input enrichment flows, the plugin shows a short progress update based on MCP `progress_hint` before auto-enrichment tasks begin.
- For Telegram deployments, the plugin can auto-set `channels.telegram.commands.native=false` at startup (`vaultCommand.autoDisableTelegramNativeCommands=true`) to avoid intermittent native slash-command misses that can surface as `Command not found.` before plugin routing.

## Behavior

- Scope: MCP tool results in OpenClaw agent runs.
- Non-blocking: wait worker runs async from `after_tool_call`.
- Supported handles: `JOB` and `PLAN_RUN`.
- Dedupe key: `(session_id, challenge_id, pending_id, run_id/job_id)`.
- Session lifecycle: pending waits are canceled on `before_reset` and `session_end`.
- Retries: transient transport failures retry with backoff (`1s, 2s, 4s, 8s, 16s`, max 5 attempts).
- No-retry terminal categories: validation/auth/timeouts.
- Reconciliation: when wait payloads are malformed or terminal status is unknown, plugin attempts read-only reconciliation through `vaultclaw_approvals_pending_get` and `vaultclaw_job_get`.
- Reconciliation on wait failure: transient wait transport failures can trigger a read-only reconciliation check before surfacing terminal error guidance.
- ALLOW completion callback: after ALLOW, plugin probes `vaultclaw_job_get` with a short timeout to post deterministic completion updates without waiting for an extra model turn.
- Legacy mcporter fallback remains opt-in (`allowMcporterFallback=true`) but is deprecated; standard behavior uses Gateway `/tools/invoke` only.
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
- `completion_probe_succeeded`
- `completion_probe_inconclusive`
- `completion_probe_failed`
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
