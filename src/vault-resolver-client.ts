import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  extractToolData,
  extractToolEnvelope,
  extractToolError,
  invokeGatewayTool,
  isToolSuccess,
} from "./vault-gateway-client.js";

export type ResolverStatus =
  | "RESOLVED_EXECUTABLE"
  | "RESOLVED_MISSING_INPUTS"
  | "NOT_VAULT_ELIGIBLE"
  | "AMBIGUOUS";

export type ResolverRoute = {
  route_id?: string;
  cookbook_id?: string;
  version?: string;
  entry_id?: string;
  entry_type?: string;
  source?: "registry" | "search" | string;
};

export type ResolverExecution = {
  strategy?: "TEMPLATE" | "RECIPE" | "CONNECTOR_EXECUTE_JOB" | "PLAN_EXECUTE" | string;
  tool?: string;
  connector_id?: string;
  verb?: string;
  orchestration?: Record<string, unknown>;
};

export type ResolverExternalFactRequest = {
  fact_key?: string;
  kind?: string;
  parallelizable?: boolean;
  batch_group?: string;
  instructions?: string;
  request_text?: string;
  [key: string]: unknown;
};

export type ResolverMissingInputGuidance = {
  input_key?: string;
  resolution_mode?: "AUTO_RETRY_WITH_FACTS" | "ASK_USER" | string;
  external_fact_request?: ResolverExternalFactRequest;
  [key: string]: unknown;
};

export type ResolverProgressHint = {
  mode?: "AUTO_ENRICH_AND_RETRY" | "PARTIAL_AUTO_ENRICH_THEN_ASK_USER" | "ASK_USER" | string;
  text?: string;
  [key: string]: unknown;
};

export type ResolverPayload = {
  status: ResolverStatus;
  confidence?: "HIGH" | "MEDIUM" | "LOW" | string;
  domain?: string;
  route?: ResolverRoute;
  execution?: ResolverExecution;
  inputs?: Record<string, unknown>;
  missing_inputs?: string[];
  missing_input_guidance?: ResolverMissingInputGuidance[];
  progress_hint?: ResolverProgressHint;
  reasons?: string[];
  fallback_hint?: string;
};

export type ResolverFailure = {
  code?: string;
  message: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function asGuidanceArray(value: unknown): ResolverMissingInputGuidance[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ResolverMissingInputGuidance[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const externalFactRequest = asRecord(record.external_fact_request) as ResolverExternalFactRequest | undefined;
    out.push({
      ...record,
      input_key: typeof record.input_key === "string" ? record.input_key : undefined,
      resolution_mode: typeof record.resolution_mode === "string" ? record.resolution_mode : undefined,
      external_fact_request: externalFactRequest,
    });
  }
  return out;
}

function parseResolverPayload(data: Record<string, unknown>): ResolverPayload | undefined {
  const status = typeof data.status === "string" ? data.status.trim() : "";
  if (
    status !== "RESOLVED_EXECUTABLE" &&
    status !== "RESOLVED_MISSING_INPUTS" &&
    status !== "NOT_VAULT_ELIGIBLE" &&
    status !== "AMBIGUOUS"
  ) {
    return undefined;
  }

  return {
    status,
    confidence: typeof data.confidence === "string" ? data.confidence : undefined,
    domain: typeof data.domain === "string" ? data.domain : undefined,
    route: asRecord(data.route) as ResolverRoute | undefined,
    execution: asRecord(data.execution) as ResolverExecution | undefined,
    inputs: asRecord(data.inputs),
    missing_inputs: asStringArray(data.missing_inputs),
    missing_input_guidance: asGuidanceArray(data.missing_input_guidance),
    progress_hint: asRecord(data.progress_hint) as ResolverProgressHint | undefined,
    reasons: asStringArray(data.reasons),
    fallback_hint: typeof data.fallback_hint === "string" ? data.fallback_hint : undefined,
  };
}

export async function resolveVaultRoute(params: {
  config: OpenClawConfig;
  resolverTool: string;
  requestText: string;
  timeoutMs: number;
  sessionKey?: string;
  context?: Record<string, unknown>;
}): Promise<{ payload?: ResolverPayload; failure?: ResolverFailure; rawEnvelope: Record<string, unknown> }> {
  const args: Record<string, unknown> = {
    request_text: params.requestText,
    options: {
      allow_search_fallback: true,
    },
  };
  if (params.context && Object.keys(params.context).length > 0) {
    args.context = params.context;
  }

  const response = await invokeGatewayTool({
    config: params.config,
    tool: params.resolverTool,
    args,
    sessionKey: params.sessionKey,
    timeoutMs: params.timeoutMs,
  });

  const envelope = extractToolEnvelope(response);
  if (!isToolSuccess(envelope)) {
    const err = extractToolError(envelope);
    return {
      rawEnvelope: envelope,
      failure: {
        code: err.code,
        message: err.message ?? "resolver tool returned failure",
      },
    };
  }

  const data = extractToolData(envelope);
  const payload = parseResolverPayload(data);
  if (!payload) {
    return {
      rawEnvelope: envelope,
      failure: {
        message: "resolver returned malformed payload",
      },
    };
  }

  return {
    rawEnvelope: envelope,
    payload,
  };
}
