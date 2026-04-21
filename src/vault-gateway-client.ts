import type { OpenClawConfig } from "openclaw/plugin-sdk";

export class VaultGatewayError extends Error {
  readonly code?: string;
  readonly category: "transport" | "validation" | "auth" | "unknown";
  readonly details?: unknown;

  constructor(params: {
    message: string;
    code?: string;
    category: "transport" | "validation" | "auth" | "unknown";
    details?: unknown;
  }) {
    super(params.message);
    this.name = "VaultGatewayError";
    this.code = params.code;
    this.category = params.category;
    this.details = params.details;
  }
}

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
    throw new VaultGatewayError({
      message: "gateway auth token/password is required for /tools/invoke",
      code: "MCP_AUTH_ERROR",
      category: "auth",
    });
  }

  return token ? `Bearer ${token}` : undefined;
}

export type ToolInvokeResponse = {
  statusCode: number;
  body: Record<string, unknown>;
  invokeResult?: Record<string, unknown>;
};

export type OpenResponseHTTPResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

export type ChatCompletionHTTPResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

export async function invokeGatewayTool(params: {
  config: OpenClawConfig;
  tool: string;
  args: Record<string, unknown>;
  sessionKey?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ToolInvokeResponse> {
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
  const signal = createCombinedSignal([params.signal, timeoutSignal]);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const authHeader = resolveAuthHeader(params.config);
  if (authHeader) {
    headers.authorization = authHeader;
  }

  const requestBody: Record<string, unknown> = {
    tool: params.tool,
    args: params.args,
  };
  if (params.sessionKey) {
    requestBody.sessionKey = params.sessionKey;
  }

  let response: Response;
  try {
    response = await fetch(`${resolveGatewayBaseUrl(params.config)}/tools/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    throw new VaultGatewayError({
      message: timeoutSignal.aborted
        ? `tools.invoke timed out after ${params.timeoutMs}ms`
        : `tools.invoke transport failure: ${String(error)}`,
      code: timeoutSignal.aborted ? "COMMAND_TIMEOUT" : "TRANSPORT_ERROR",
      category: "transport",
      details: error,
    });
  }

  const bodyUnknown = await response
    .json()
    .catch(() => ({ ok: false, error: { message: "invalid JSON from /tools/invoke" } }));
  const body = asRecord(bodyUnknown) ?? {};
  const invokeResult = asRecord(body.result);

  if (!response.ok || body.ok !== true) {
    const errObj = asRecord(body.error) ?? {};
    const message =
      readString(errObj.message) ?? `tools.invoke failed with status ${response.status}`;
    const code = readString(errObj.code) ?? "MCP_GATEWAY_ERROR";
    const category = response.status === 401 || response.status === 403
      ? "auth"
      : response.status >= 400 && response.status < 500
      ? "validation"
      : "transport";

    throw new VaultGatewayError({
      message,
      code,
      category,
      details: { status_code: response.status, body: bodyUnknown },
    });
  }

  return {
    statusCode: response.status,
    body,
    invokeResult,
  };
}

export async function invokeGatewayOpenResponse(params: {
  config: OpenClawConfig;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<OpenResponseHTTPResult> {
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
  const signal = createCombinedSignal([params.signal, timeoutSignal]);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const authHeader = resolveAuthHeader(params.config);
  if (authHeader) {
    headers.authorization = authHeader;
  }

  let response: Response;
  try {
    response = await fetch(`${resolveGatewayBaseUrl(params.config)}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal,
    });
  } catch (error) {
    throw new VaultGatewayError({
      message: timeoutSignal.aborted
        ? `gateway /v1/responses timed out after ${params.timeoutMs}ms`
        : `gateway /v1/responses transport failure: ${String(error)}`,
      code: timeoutSignal.aborted ? "COMMAND_TIMEOUT" : "TRANSPORT_ERROR",
      category: "transport",
      details: error,
    });
  }

  const bodyUnknown = await response
    .json()
    .catch(() => ({ error: { message: "invalid JSON from /v1/responses" } }));
  const body = asRecord(bodyUnknown) ?? {};
  if (!response.ok) {
    const errorObj = asRecord(body.error) ?? {};
    const endpointUnavailable = response.status === 404 || response.status === 405 || response.status === 501;
    throw new VaultGatewayError({
      message:
        readString(errorObj.message) ??
        (endpointUnavailable
          ? "gateway /v1/responses endpoint is unavailable"
          : `gateway /v1/responses failed with status ${response.status}`),
      code: endpointUnavailable
        ? "RESPONSES_ENDPOINT_UNAVAILABLE"
        : readString(errorObj.code) ?? "OPENRESPONSES_HTTP_ERROR",
      category: response.status === 401 || response.status === 403
        ? "auth"
        : response.status >= 400 && response.status < 500
        ? "validation"
        : "transport",
      details: { status_code: response.status, body: bodyUnknown },
    });
  }

  return {
    statusCode: response.status,
    body,
  };
}

export async function invokeGatewayChatCompletion(params: {
  config: OpenClawConfig;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ChatCompletionHTTPResult> {
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs);
  const signal = createCombinedSignal([params.signal, timeoutSignal]);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const authHeader = resolveAuthHeader(params.config);
  if (authHeader) {
    headers.authorization = authHeader;
  }

  let response: Response;
  try {
    response = await fetch(`${resolveGatewayBaseUrl(params.config)}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
      signal,
    });
  } catch (error) {
    throw new VaultGatewayError({
      message: timeoutSignal.aborted
        ? `gateway /v1/chat/completions timed out after ${params.timeoutMs}ms`
        : `gateway /v1/chat/completions transport failure: ${String(error)}`,
      code: timeoutSignal.aborted ? "COMMAND_TIMEOUT" : "TRANSPORT_ERROR",
      category: "transport",
      details: error,
    });
  }

  const bodyUnknown = await response
    .json()
    .catch(() => ({ error: { message: "invalid JSON from /v1/chat/completions" } }));
  const body = asRecord(bodyUnknown) ?? {};
  if (!response.ok) {
    const errorObj = asRecord(body.error) ?? {};
    const endpointUnavailable = response.status === 404 || response.status === 405 || response.status === 501;
    throw new VaultGatewayError({
      message:
        readString(errorObj.message) ??
        (endpointUnavailable
          ? "gateway /v1/chat/completions endpoint is unavailable"
          : `gateway /v1/chat/completions failed with status ${response.status}`),
      code: endpointUnavailable
        ? "CHAT_COMPLETIONS_ENDPOINT_UNAVAILABLE"
        : readString(errorObj.code) ?? "CHAT_COMPLETIONS_HTTP_ERROR",
      category: response.status === 401 || response.status === 403
        ? "auth"
        : response.status >= 400 && response.status < 500
        ? "validation"
        : "transport",
      details: { status_code: response.status, body: bodyUnknown },
    });
  }

  return {
    statusCode: response.status,
    body,
  };
}

export function extractToolEnvelope(result: ToolInvokeResponse): Record<string, unknown> {
  return result.invokeResult ?? {};
}

export function extractToolData(envelope: Record<string, unknown>): Record<string, unknown> {
  if (envelope.ok === true) {
    const data = asRecord(envelope.data);
    if (data) {
      return data;
    }
    const nested = asRecord(envelope.result);
    if (nested) {
      return nested;
    }
  }

  const nestedEnvelope = asRecord(envelope.result);
  if (nestedEnvelope?.ok === true) {
    return asRecord(nestedEnvelope.data) ?? asRecord(nestedEnvelope.result) ?? nestedEnvelope;
  }

  return {};
}

export function extractToolError(envelope: Record<string, unknown>): { code?: string; message?: string } {
  const errorObj = asRecord(envelope.error) ?? asRecord(asRecord(envelope.result)?.error);
  if (!errorObj) {
    return {};
  }
  return {
    code: readString(errorObj.code),
    message: readString(errorObj.message),
  };
}

export function isToolSuccess(envelope: Record<string, unknown>): boolean {
  if (envelope.ok === true) {
    return true;
  }
  const nestedEnvelope = asRecord(envelope.result);
  return nestedEnvelope?.ok === true;
}
