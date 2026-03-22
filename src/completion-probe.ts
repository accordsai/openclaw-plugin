import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { CompletionProbe } from "./types.js";
import {
  extractToolEnvelope,
  invokeGatewayTool,
  isToolSuccess,
} from "./vault-gateway-client.js";

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

function normalizeUpper(value: unknown): string | undefined {
  const text = readString(value);
  return text ? text.toUpperCase() : undefined;
}

function readExecutedSteps(data: Record<string, unknown>, job: Record<string, unknown> | undefined): number | undefined {
  const direct =
    readNumber(data.executed_steps) ??
    readNumber(data.executedSteps) ??
    readNumber(job?.executed_steps) ??
    readNumber(job?.executedSteps);
  if (direct !== undefined) {
    return direct;
  }
  const steps = Array.isArray(data.executed_step_ids)
    ? data.executed_step_ids
    : Array.isArray(job?.executed_step_ids)
    ? job?.executed_step_ids
    : undefined;
  return Array.isArray(steps) ? steps.length : undefined;
}

function readLastStep(data: Record<string, unknown>, job: Record<string, unknown> | undefined): string | undefined {
  return (
    readString(data.last_step) ??
    readString(data.last_step_id) ??
    readString(job?.last_step) ??
    readString(job?.last_step_id)
  );
}

function looksLikeCompletionPayload(record: Record<string, unknown>): boolean {
  return Boolean(
    asRecord(record.job) ||
      readString(record.status) ||
      readString(record.decision_outcome) ||
      readString(asRecord(record.approval_state)?.decision_outcome),
  );
}

function findCompletionPayload(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 8) {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (looksLikeCompletionPayload(record)) {
    return record;
  }

  const nestedCandidates = [record.data, record.result, record.output, record.response];
  for (const candidate of nestedCandidates) {
    const nested = findCompletionPayload(candidate, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export function createGatewayCompletionProbe(config: OpenClawConfig): CompletionProbe {
  return async ({ sessionKey, signal, timeoutMs }) => {
    const jobId = readString(signal.jobId) ?? readString(signal.handle.job_id);
    if (!jobId) {
      return undefined;
    }

    const invoked = await invokeGatewayTool({
      config,
      tool: "vaultclaw_job_get",
      args: {
        job_id: jobId,
      },
      sessionKey,
      timeoutMs,
    });

    const envelope = extractToolEnvelope(invoked);
    if (!isToolSuccess(envelope)) {
      return undefined;
    }

    const data = findCompletionPayload(envelope);
    if (!data) {
      return undefined;
    }
    const job = asRecord(data.job);
    const terminalStatus =
      normalizeUpper(job?.status) ??
      normalizeUpper(data.status);
    const decisionOutcome =
      normalizeUpper(data.decision_outcome) ??
      normalizeUpper(asRecord(data.approval_state)?.decision_outcome);

    const runId =
      readString(data.run_id) ??
      readString(job?.run_id) ??
      readString(signal.runId) ??
      readString(signal.handle.run_id);
    const resolvedJobId = readString(data.job_id) ?? readString(job?.id) ?? jobId;

    return {
      terminal: Boolean(terminalStatus && TERMINAL_STATUSES.has(terminalStatus)),
      terminalStatus,
      decisionOutcome,
      runId,
      jobId: resolvedJobId,
      executedSteps: readExecutedSteps(data, job),
      lastStep: readLastStep(data, job),
    };
  };
}
