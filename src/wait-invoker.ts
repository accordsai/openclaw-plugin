import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ApprovalHandle, WaitInvoker, WaitSuccess } from "./types.js";
import { WaitCallError } from "./types.js";

const execFileAsync = promisify(execFile);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = readString(value)?.toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function normalizeUpper(value: unknown): string | undefined {
  return readString(value)?.toUpperCase();
}

function parseJsonValue(value: unknown): unknown {
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Fall through to best-effort extraction for streamed/concatenated JSON.
  }

  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  let lastParsed: unknown;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!char) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      escaped = false;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = raw.slice(start, index + 1);
        try {
          lastParsed = JSON.parse(candidate) as unknown;
        } catch {
          // Ignore malformed candidate and continue scanning.
        }
        start = -1;
      }
    }
  }

  return lastParsed;
}

function isWaitPayloadRecord(value: Record<string, unknown>): boolean {
  return (
    typeof value.done === "boolean" ||
    typeof value.done === "string" ||
    typeof value.terminal_status === "string" ||
    typeof value.terminalStatus === "string" ||
    typeof value.status === "string" ||
    typeof value.state === "string" ||
    typeof value.decision_outcome === "string" ||
    typeof value.decisionOutcome === "string" ||
    typeof value.outcome === "string"
  );
}

const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "DENIED",
  "EXPIRED",
  "FAILED",
  "CANCELED",
  "CANCELLED",
  "REJECTED",
  "ERROR",
  "COMPLETED",
]);

const TERMINAL_DECISION_OUTCOMES = new Set(["ALLOW", "DENY", "UNKNOWN"]);

function inferDone(
  doneValue: boolean | undefined,
  terminalStatus: string | undefined,
  decisionOutcome: string | undefined,
): boolean {
  if (doneValue !== undefined) {
    return doneValue;
  }
  if (terminalStatus && TERMINAL_STATUSES.has(terminalStatus)) {
    return true;
  }
  if (decisionOutcome && TERMINAL_DECISION_OUTCOMES.has(decisionOutcome)) {
    return true;
  }
  return false;
}

function toWaitSuccess(data: Record<string, unknown>): WaitSuccess {
  const terminalStatus =
    normalizeUpper(data.terminal_status) ??
    normalizeUpper(data.terminalStatus) ??
    normalizeUpper(data.status) ??
    normalizeUpper(data.state);
  const decisionOutcome =
    normalizeUpper(data.decision_outcome) ??
    normalizeUpper(data.decisionOutcome) ??
    normalizeUpper(data.outcome);

  return {
    done: inferDone(readBoolean(data.done), terminalStatus, decisionOutcome),
    terminalStatus,
    decisionOutcome,
    raw: data,
  };
}

function findWaitPayload(
  value: unknown,
  depth = 0,
  seen = new Set<Record<string, unknown>>(),
): Record<string, unknown> | undefined {
  if (depth > 8) {
    return undefined;
  }

  const parsedFromString = parseJsonValue(value);
  if (parsedFromString !== undefined && parsedFromString !== value) {
    const fromString = findWaitPayload(parsedFromString, depth + 1, seen);
    if (fromString) {
      return fromString;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findWaitPayload(item, depth + 1, seen);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record || seen.has(record)) {
    return undefined;
  }
  seen.add(record);

  if (isWaitPayloadRecord(record)) {
    return record;
  }

  const prioritized = [
    record.data,
    record.result,
    record.output,
    record.payload,
    record.response,
    record.value,
    record.body,
    record.details,
  ];
  for (const candidate of prioritized) {
    const nested = findWaitPayload(candidate, depth + 1, seen);
    if (nested) {
      return nested;
    }
  }

  const content = Array.isArray(record.content) ? record.content : undefined;
  if (content) {
    for (const item of content) {
      const nested =
        findWaitPayload(asRecord(item)?.text, depth + 1, seen) ??
        findWaitPayload(item, depth + 1, seen);
      if (nested) {
        return nested;
      }
    }
  }

  for (const candidate of Object.values(record)) {
    const nested = findWaitPayload(candidate, depth + 1, seen);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function createCombinedSignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const defined = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (defined.length === 0) {
    return undefined;
  }
  if (defined.length === 1) {
    return defined[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(defined);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of defined) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

function resolveGatewayBaseUrl(config: OpenClawConfig): string {
  const override =
    process.env.OPENCLAW_GATEWAY_HTTP_URL?.trim() || process.env.CLAWDBOT_GATEWAY_HTTP_URL?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }

  const gateway = (config as Record<string, unknown>).gateway as Record<string, unknown> | undefined;
  const tls = asRecord(gateway?.tls);
  const scheme = tls?.enabled === true ? "https" : "http";
  const bind = readString(gateway?.bind) ?? "loopback";
  const customBindHost = readString(gateway?.customBindHost);

  let host = "127.0.0.1";
  if (bind === "custom" && customBindHost) {
    host = customBindHost;
  }

  const port = readNumber(gateway?.port) ?? 18789;
  return `${scheme}://${host}:${port}`;
}

function resolveAuthHeader(config: OpenClawConfig): string | undefined {
  const gateway = (config as Record<string, unknown>).gateway as Record<string, unknown> | undefined;
  const auth = asRecord(gateway?.auth);
  const mode = (readString(auth?.mode) ?? "").toLowerCase();

  const token =
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
    readString(auth?.token) ||
    process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    readString(auth?.password);

  if ((mode === "token" || mode === "password") && !token) {
    throw new WaitCallError({
      message: "gateway auth token/password is required for /tools/invoke",
      code: "MCP_AUTH_ERROR",
      retryable: false,
      category: "auth",
    });
  }

  return token ? `Bearer ${token}` : undefined;
}

function normalizeMcpFailure(errorObj: Record<string, unknown>): WaitCallError {
  const code = normalizeUpper(errorObj.code) ?? normalizeUpper(asRecord(errorObj.error)?.code);
  const message =
    readString(errorObj.message) ??
    readString(asRecord(errorObj.error)?.message) ??
    "vaultclaw_approval_wait returned an error";

  if (code === "MCP_WAIT_TIMEOUT") {
    return new WaitCallError({
      message,
      code,
      retryable: false,
      category: "timeout",
      details: errorObj,
    });
  }

  if (code?.includes("VALIDATION")) {
    return new WaitCallError({
      message,
      code,
      retryable: false,
      category: "validation",
      details: errorObj,
    });
  }

  if (code?.includes("AUTH") || code === "INSUFFICIENT_SCOPE") {
    return new WaitCallError({
      message,
      code,
      retryable: false,
      category: "auth",
      details: errorObj,
    });
  }

  return new WaitCallError({
    message,
    code,
    retryable: true,
    category: "transport",
    details: errorObj,
  });
}

function shouldFallbackToMcporter(params: {
  statusCode: number;
  code?: string;
  message: string;
}): boolean {
  const message = params.message.toLowerCase();
  const code = (params.code ?? "").toUpperCase();
  const isToolUnavailable =
    message.includes("tool not available") && message.includes("vaultclaw_approval_wait");
  if (!isToolUnavailable) {
    return false;
  }
  if (params.statusCode === 404) {
    return true;
  }
  if (params.statusCode >= 400 && params.statusCode < 500) {
    return true;
  }
  return code.includes("VALIDATION");
}

function resolveMcporterConfigPath(config: OpenClawConfig): string | undefined {
  const envOverride =
    process.env.OPENCLAW_MCPORTER_CONFIG?.trim() || process.env.MCPORTER_CONFIG?.trim();
  if (envOverride) {
    return envOverride;
  }

  const root = config as Record<string, unknown>;
  const skills = asRecord(root.skills);
  const entries = asRecord(skills?.entries);
  for (const entry of Object.values(entries ?? {})) {
    const env = asRecord(asRecord(entry)?.env);
    const candidate = readString(env?.MCPORTER_CONFIG);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function resolveMcporterServer(config: OpenClawConfig): string {
  const envOverride =
    process.env.OPENCLAW_MCPORTER_SERVER?.trim() || process.env.MCPORTER_SERVER?.trim();
  if (envOverride) {
    return envOverride;
  }

  const root = config as Record<string, unknown>;
  const skills = asRecord(root.skills);
  const entries = asRecord(skills?.entries);
  for (const entry of Object.values(entries ?? {})) {
    const env = asRecord(asRecord(entry)?.env);
    const candidate = readString(env?.MCPORTER_SERVER);
    if (candidate) {
      return candidate;
    }
  }

  return "accords-vaultclaw";
}

function parseMcporterEnvelope(stdout: string): Record<string, unknown> {
  const parsed = parseJsonValue(stdout);
  const record = asRecord(parsed);
  if (!record) {
    throw new WaitCallError({
      message: "mcporter returned malformed JSON",
      code: "MCP_VALIDATION_ERROR",
      retryable: false,
      category: "validation",
      details: stdout,
    });
  }
  return record;
}

export function parseMcporterWaitSuccess(envelope: Record<string, unknown>): WaitSuccess {
  if (envelope.ok !== true) {
    if (envelope.ok === false) {
      const errorObj = asRecord(envelope.error);
      if (errorObj) {
        throw normalizeMcpFailure(errorObj);
      }
      throw new WaitCallError({
        message: "mcporter wait call failed with malformed error envelope",
        code: "MCP_VALIDATION_ERROR",
        retryable: false,
        category: "validation",
        details: envelope,
      });
    }
  }

  const data = findWaitPayload(envelope);
  if (!data) {
    throw new WaitCallError({
      message: "mcporter wait call returned malformed success payload",
      code: "MCP_VALIDATION_ERROR",
      retryable: false,
      category: "validation",
      details: envelope,
    });
  }

  return toWaitSuccess(data);
}

async function invokeMcporterWait(params: {
  config: OpenClawConfig;
  handle: ApprovalHandle;
  maxWaitMs: number;
  pollIntervalMs: number;
  commandTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<WaitSuccess> {
  const configPath = resolveMcporterConfigPath(params.config);
  if (!configPath) {
    throw new WaitCallError({
      message:
        "Tool not available: vaultclaw_approval_wait (no MCPORTER_CONFIG found for fallback invocation)",
      code: "MCP_VALIDATION_ERROR",
      retryable: false,
      category: "validation",
    });
  }

  const server = resolveMcporterServer(params.config);
  const selector = `${server}.vaultclaw_approval_wait`;
  const argsPayload = JSON.stringify({
    handle: params.handle,
    timeout_ms: params.maxWaitMs,
    poll_interval_ms: params.pollIntervalMs,
  });
  const args = [
    "--config",
    configPath,
    "call",
    selector,
    "--args",
    argsPayload,
    "--output",
    "json",
  ];

  try {
    const { stdout } = await execFileAsync("mcporter", args, {
      timeout: params.commandTimeoutMs,
      signal: params.signal,
      maxBuffer: 10 * 1024 * 1024,
    });
    const envelope = parseMcporterEnvelope(stdout);
    return parseMcporterWaitSuccess(envelope);
  } catch (error) {
    if (params.signal?.aborted) {
      throw new WaitCallError({
        message: "approval wait canceled",
        code: "ABORTED",
        retryable: false,
        category: "unknown",
      });
    }

    if (error && typeof error === "object" && (error as { name?: string }).name === "WaitCallError") {
      throw error;
    }

    const execError = error as {
      code?: string;
      message?: string;
      stdout?: string;
      stderr?: string;
    };

    const stdout = readString(execError.stdout);
    if (stdout) {
      try {
        const envelope = parseMcporterEnvelope(stdout);
        if (envelope.ok === false) {
          const errorObj = asRecord(envelope.error);
          if (errorObj) {
            throw normalizeMcpFailure(errorObj);
          }
        }
      } catch (nested) {
        if (
          nested &&
          typeof nested === "object" &&
          (nested as { name?: string }).name === "WaitCallError"
        ) {
          throw nested;
        }
      }
    }

    if (execError.code === "ENOENT") {
      throw new WaitCallError({
        message: "mcporter executable not found for vaultclaw_approval_wait fallback",
        code: "MCP_VALIDATION_ERROR",
        retryable: false,
        category: "validation",
        details: error,
      });
    }

    throw new WaitCallError({
      message: `mcporter wait fallback failed: ${execError.message ?? String(error)}`,
      code: execError.code ?? "TRANSPORT_ERROR",
      retryable: true,
      category: "transport",
      details: error,
    });
  }
}

function parseWaitSuccess(result: unknown): WaitSuccess {
  const envelope = asRecord(result);
  if (!envelope || envelope.ok !== true) {
    throw new WaitCallError({
      message: "tools.invoke returned malformed MCP success envelope",
      code: "MCP_VALIDATION_ERROR",
      retryable: false,
      category: "validation",
      details: result,
    });
  }

  const data = findWaitPayload(envelope.result);
  if (!data) {
    throw new WaitCallError({
      message: "vaultclaw_approval_wait returned malformed payload",
      code: "MCP_VALIDATION_ERROR",
      retryable: false,
      category: "validation",
      details: result,
    });
  }

  return toWaitSuccess(data);
}

function isWaitCallError(error: unknown): error is WaitCallError {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { name?: string }).name === "WaitCallError",
  );
}

function withWaitSource(wait: WaitSuccess, source: string, reconciled: boolean): WaitSuccess {
  const rawRecord = asRecord(wait.raw);
  const raw = rawRecord
    ? { ...rawRecord, source, reconciled }
    : { source, reconciled, payload: wait.raw };
  return {
    ...wait,
    raw,
  };
}

async function invokeGatewayTool(params: {
  config: OpenClawConfig;
  tool: string;
  args: Record<string, unknown>;
  sessionKey?: string;
  commandTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ invokeResult: Record<string, unknown>; statusCode: number }> {
  const timeoutSignal = AbortSignal.timeout(params.commandTimeoutMs);
  const signal = createCombinedSignal([params.signal, timeoutSignal]);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const authHeader = resolveAuthHeader(params.config);
  if (authHeader) {
    headers.authorization = authHeader;
  }

  const baseUrl = resolveGatewayBaseUrl(params.config);
  const responseBody: Record<string, unknown> = {
    tool: params.tool,
    args: params.args,
  };
  if (params.sessionKey) {
    responseBody.sessionKey = params.sessionKey;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify(responseBody),
      signal,
    });
  } catch (error) {
    if (params.signal?.aborted) {
      throw new WaitCallError({
        message: "approval wait canceled",
        code: "ABORTED",
        retryable: false,
        category: "unknown",
      });
    }
    const timedOut = timeoutSignal.aborted;
    throw new WaitCallError({
      message: timedOut
        ? `tools.invoke timed out after ${params.commandTimeoutMs}ms`
        : `tools.invoke transport failure: ${String(error)}`,
      code: timedOut ? "COMMAND_TIMEOUT" : "TRANSPORT_ERROR",
      retryable: true,
      category: "transport",
      details: error,
    });
  }

  const bodyUnknown = await response
    .json()
    .catch(() => ({ ok: false, error: { message: "invalid JSON from /tools/invoke" } }));
  const body = asRecord(bodyUnknown) ?? {};

  if (!response.ok || body.ok !== true) {
    const errObj = asRecord(body.error) ?? {};
    const message =
      readString(errObj.message) ?? `tools.invoke failed with status ${response.status}`;
    const code = normalizeUpper(errObj.code);

    if (response.status === 401 || response.status === 403 || code === "INSUFFICIENT_SCOPE") {
      throw new WaitCallError({
        message,
        code: code ?? "MCP_AUTH_ERROR",
        retryable: false,
        category: "auth",
        details: { status_code: response.status, body: bodyUnknown },
      });
    }

    if (response.status >= 400 && response.status < 500) {
      throw new WaitCallError({
        message,
        code: code ?? "MCP_VALIDATION_ERROR",
        retryable: false,
        category: "validation",
        details: { status_code: response.status, body: bodyUnknown },
      });
    }

    throw new WaitCallError({
      message,
      code: code ?? "TRANSPORT_ERROR",
      retryable: true,
      category: "transport",
      details: { status_code: response.status, body: bodyUnknown },
    });
  }

  const invokeResult = asRecord(body.result);
  if (!invokeResult) {
    throw new WaitCallError({
      message: "tools.invoke returned empty result",
      code: "MCP_VALIDATION_ERROR",
      retryable: false,
      category: "validation",
      details: { status_code: response.status, body: bodyUnknown },
    });
  }

  if (invokeResult.ok === false) {
    const invokeError = asRecord(invokeResult.error) ?? {};
    const normalized = normalizeMcpFailure(invokeError);
    throw new WaitCallError({
      message: normalized.message,
      code: normalized.code,
      retryable: normalized.retryable,
      category: normalized.category,
      details: { status_code: response.status, body: invokeResult },
    });
  }

  return { invokeResult, statusCode: response.status };
}

function shouldFallbackToMcporterFromError(error: WaitCallError): boolean {
  const details = asRecord(error.details);
  const statusCode = readNumber(details?.status_code) ?? 400;
  return shouldFallbackToMcporter({
    statusCode,
    code: error.code,
    message: error.message,
  });
}

function extractToolData(invokeResult: Record<string, unknown>): Record<string, unknown> | undefined {
  const nestedEnvelope = asRecord(invokeResult.result);
  if (nestedEnvelope && nestedEnvelope.ok === true) {
    return asRecord(nestedEnvelope.data) ?? asRecord(nestedEnvelope.result) ?? nestedEnvelope;
  }
  if (invokeResult.ok === true) {
    return asRecord(invokeResult.data) ?? asRecord(invokeResult.result) ?? invokeResult;
  }
  return asRecord(invokeResult.data) ?? asRecord(invokeResult.result);
}

function buildPendingReconcileError(state: string, source: string): WaitCallError {
  return new WaitCallError({
    message: `approval still pending during reconciliation (state=${state})`,
    code: "MCP_APPROVAL_STILL_PENDING",
    retryable: true,
    category: "transport",
    details: { source, state },
  });
}

function mapPendingStateToWaitSuccess(state: string, item: Record<string, unknown>): WaitSuccess {
  if (state === "WAITING" || state === "READY" || state === "RUNNING") {
    throw buildPendingReconcileError(state, "reconcile_pending_get");
  }
  if (state === "SUCCEEDED") {
    return {
      done: true,
      terminalStatus: "SUCCEEDED",
      decisionOutcome: "ALLOW",
      raw: { ...item, source: "reconcile_pending_get", reconciled: true },
    };
  }
  if (state === "DENIED" || state === "EXPIRED") {
    return {
      done: true,
      terminalStatus: state,
      decisionOutcome: "DENY",
      raw: { ...item, source: "reconcile_pending_get", reconciled: true },
    };
  }
  if (state === "FAILED") {
    return {
      done: true,
      terminalStatus: "FAILED",
      decisionOutcome: "UNKNOWN",
      raw: { ...item, source: "reconcile_pending_get", reconciled: true },
    };
  }
  throw new WaitCallError({
    message: `unrecognized pending approval state from reconciliation: ${state || "UNKNOWN"}`,
    code: "MCP_VALIDATION_ERROR",
    retryable: false,
    category: "validation",
    details: { source: "reconcile_pending_get", item },
  });
}

function mapJobStatusToWaitSuccess(
  status: string | undefined,
  decisionOutcome: string | undefined,
  data: Record<string, unknown>,
): WaitSuccess {
  const normalizedStatus = status ?? "";
  const normalizedDecision = decisionOutcome ?? "";
  if (normalizedStatus === "PENDING" || normalizedStatus === "READY" || normalizedStatus === "RUNNING") {
    throw buildPendingReconcileError(normalizedStatus, "reconcile_job_get");
  }
  if (normalizedStatus === "SUCCEEDED" || normalizedDecision === "ALLOW") {
    return {
      done: true,
      terminalStatus: "SUCCEEDED",
      decisionOutcome: "ALLOW",
      raw: { ...data, source: "reconcile_job_get", reconciled: true },
    };
  }
  if (normalizedStatus === "DENIED" || normalizedDecision === "DENY") {
    return {
      done: true,
      terminalStatus: normalizedStatus || "DENIED",
      decisionOutcome: "DENY",
      raw: { ...data, source: "reconcile_job_get", reconciled: true },
    };
  }
  if (normalizedStatus === "FAILED") {
    return {
      done: true,
      terminalStatus: "FAILED",
      decisionOutcome: "UNKNOWN",
      raw: { ...data, source: "reconcile_job_get", reconciled: true },
    };
  }
  throw new WaitCallError({
    message: `unrecognized job status from reconciliation: ${normalizedStatus || "UNKNOWN"}`,
    code: "MCP_VALIDATION_ERROR",
    retryable: false,
    category: "validation",
    details: { source: "reconcile_job_get", data },
  });
}

async function reconcileWaitResult(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  handle: ApprovalHandle;
  signal?: AbortSignal;
  reconcileTimeoutMs: number;
}): Promise<WaitSuccess | undefined> {
  const challengeId = readString(params.handle.challenge_id);
  const pendingId = readString(params.handle.pending_id);
  const jobId = readString(params.handle.job_id);

  if (challengeId && pendingId) {
    try {
      const pendingInvoke = await invokeGatewayTool({
        config: params.config,
        tool: "vaultclaw_approvals_pending_get",
        args: {
          challenge_id: challengeId,
          pending_id: pendingId,
        },
        sessionKey: params.sessionKey,
        commandTimeoutMs: params.reconcileTimeoutMs,
        signal: params.signal,
      });
      const data = extractToolData(pendingInvoke.invokeResult);
      const item = asRecord(data?.item) ?? data;
      if (item) {
        const state = normalizeUpper(item.state) ?? normalizeUpper(item.status) ?? "";
        return mapPendingStateToWaitSuccess(state, item);
      }
    } catch (error) {
      if (isWaitCallError(error) && error.retryable) {
        throw error;
      }
    }
  }

  if (!jobId) {
    return undefined;
  }

  const jobInvoke = await invokeGatewayTool({
    config: params.config,
    tool: "vaultclaw_job_get",
    args: {
      job_id: jobId,
    },
    sessionKey: params.sessionKey,
    commandTimeoutMs: params.reconcileTimeoutMs,
    signal: params.signal,
  });
  const data = extractToolData(jobInvoke.invokeResult);
  if (!data) {
    return undefined;
  }

  const job = asRecord(data.job);
  const decisionOutcome =
    normalizeUpper(data.decision_outcome) ??
    normalizeUpper(asRecord(data.approval_state)?.decision_outcome);
  const status = normalizeUpper(job?.status) ?? normalizeUpper(data.status);
  return mapJobStatusToWaitSuccess(status, decisionOutcome, data);
}

function shouldAttemptUnknownTerminalReconcile(
  wait: WaitSuccess,
  options: { onUnknownTerminal: boolean },
): boolean {
  if (!options.onUnknownTerminal || !wait.done) {
    return false;
  }
  const decision = (wait.decisionOutcome ?? "").toUpperCase();
  const terminalStatus = (wait.terminalStatus ?? "").toUpperCase();
  if (decision === "ALLOW" || decision === "DENY") {
    return false;
  }
  return terminalStatus === "FAILED" || decision === "UNKNOWN" || decision === "";
}

export function createGatewayToolsInvokeWaitInvoker(config: OpenClawConfig): WaitInvoker {
  return async (params) => {
    const reconcileOptions = {
      onValidationError: params.reconcile?.onValidationError !== false,
      onUnknownTerminal: params.reconcile?.onUnknownTerminal !== false,
      timeoutMs: params.reconcile?.timeoutMs ?? 15000,
    };

    let primary: WaitSuccess;
    try {
      const invoke = await invokeGatewayTool({
        config,
        tool: "vaultclaw_approval_wait",
        args: {
          handle: params.handle as ApprovalHandle,
          timeout_ms: params.maxWaitMs,
          poll_interval_ms: params.pollIntervalMs,
        },
        sessionKey: params.sessionKey,
        commandTimeoutMs: params.commandTimeoutMs,
        signal: params.signal,
      });
      primary = parseWaitSuccess(invoke.invokeResult);
    } catch (error) {
      if (isWaitCallError(error) && shouldFallbackToMcporterFromError(error)) {
        try {
          primary = await invokeMcporterWait({
            config,
            handle: params.handle,
            maxWaitMs: params.maxWaitMs,
            pollIntervalMs: params.pollIntervalMs,
            commandTimeoutMs: params.commandTimeoutMs,
            signal: params.signal,
          });
        } catch (fallbackError) {
          if (isWaitCallError(fallbackError) && fallbackError.code === "ABORTED") {
            throw fallbackError;
          }
          if (
            isWaitCallError(fallbackError) &&
            reconcileOptions.onValidationError &&
            fallbackError.category === "validation"
          ) {
            const reconciled = await reconcileWaitResult({
              config,
              sessionKey: params.sessionKey,
              handle: params.handle,
              signal: params.signal,
              reconcileTimeoutMs: reconcileOptions.timeoutMs,
            });
            if (reconciled) {
              return reconciled;
            }
          }
          throw fallbackError;
        }
      } else {
        if (isWaitCallError(error) && error.code === "ABORTED") {
          throw error;
        }
        if (
          isWaitCallError(error) &&
          reconcileOptions.onValidationError &&
          error.category === "validation"
        ) {
          const reconciled = await reconcileWaitResult({
            config,
            sessionKey: params.sessionKey,
            handle: params.handle,
            signal: params.signal,
            reconcileTimeoutMs: reconcileOptions.timeoutMs,
          });
          if (reconciled) {
            return reconciled;
          }
        }
        throw error;
      }
    }

    const primaryWithSource = withWaitSource(primary, "wait_primary", false);

    if (shouldAttemptUnknownTerminalReconcile(primaryWithSource, reconcileOptions)) {
      const reconciled = await reconcileWaitResult({
        config,
        sessionKey: params.sessionKey,
        handle: params.handle,
        signal: params.signal,
        reconcileTimeoutMs: reconcileOptions.timeoutMs,
      });
      if (reconciled) {
        return reconciled;
      }
    }

    return primaryWithSource;
  };
}
