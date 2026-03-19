import type { ApprovalHandle, ApprovalHandleKind, ApprovalSignal } from "./types.js";

type ParseNotApproval = { type: "not_approval" };
type ParseInvalid = {
  type: "invalid";
  message: string;
  challengeId?: string;
  pendingId?: string;
  runId?: string;
  jobId?: string;
};
type ParseApproval = { type: "approval"; signal: ApprovalSignal };

export type ApprovalParseResult = ParseNotApproval | ParseInvalid | ParseApproval;

type McpErrorPayload = {
  code?: string;
  details?: Record<string, unknown>;
};

type RecoveredApproval = {
  found: boolean;
  challengeId?: string;
  pendingId?: string;
  runId?: string;
  jobId?: string;
  remoteAttestationURL?: string;
};

const FALLBACK_WAIT_TOOL = "vaultclaw_approval_wait";

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

function normalizeIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const compact = value.replace(/\s+/g, "").trim();
  return compact.length > 0 ? compact : undefined;
}

function readIdentifier(value: unknown): string | undefined {
  return normalizeIdentifier(readString(value));
}

function extractMcpErrorPayloadFromRecord(root: Record<string, unknown>): McpErrorPayload | undefined {
  const directError = asRecord(root.error);
  if (directError && typeof directError.code === "string") {
    return {
      code: readString(directError.code),
      details: asRecord(directError.details),
    };
  }

  const nested = asRecord(root.result);
  const nestedError = asRecord(nested?.error);
  if (nestedError && typeof nestedError.code === "string") {
    return {
      code: readString(nestedError.code),
      details: asRecord(nestedError.details),
    };
  }

  return undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed);
  } catch {
    // Fall through to best-effort extraction for concatenated/streamed JSON blobs.
  }

  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  let lastRecord: Record<string, unknown> | undefined;

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
          const parsed = JSON.parse(candidate) as unknown;
          const record = asRecord(parsed);
          if (record) {
            lastRecord = record;
          }
        } catch {
          // Ignore malformed candidate and continue scanning.
        }
        start = -1;
      }
    }
  }

  return lastRecord;
}

function extractFromContentArray(value: unknown): McpErrorPayload | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    const recordItem = asRecord(item);
    if (!recordItem) {
      continue;
    }
    const parsedText = parseJsonRecord(recordItem.text);
    if (!parsedText) {
      continue;
    }
    const nested = extractMcpErrorPayloadFromRecord(parsedText);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function extractMcpErrorPayload(input: unknown): McpErrorPayload | undefined {
  const root = asRecord(input);
  if (!root) {
    return undefined;
  }

  const direct = extractMcpErrorPayloadFromRecord(root);
  if (direct) {
    return direct;
  }

  const rootAggregated = parseJsonRecord(root.aggregated);
  if (rootAggregated) {
    const nested = extractMcpErrorPayloadFromRecord(rootAggregated);
    if (nested) {
      return nested;
    }
  }

  const rootStdout = parseJsonRecord(root.stdout);
  if (rootStdout) {
    const nested = extractMcpErrorPayloadFromRecord(rootStdout);
    if (nested) {
      return nested;
    }
  }

  const rootStderr = parseJsonRecord(root.stderr);
  if (rootStderr) {
    const nested = extractMcpErrorPayloadFromRecord(rootStderr);
    if (nested) {
      return nested;
    }
  }

  const details = asRecord(root.details);
  const detailsAggregated = parseJsonRecord(details?.aggregated);
  if (detailsAggregated) {
    const nested = extractMcpErrorPayloadFromRecord(detailsAggregated);
    if (nested) {
      return nested;
    }
  }

  const detailsStdout = parseJsonRecord(details?.stdout);
  if (detailsStdout) {
    const nested = extractMcpErrorPayloadFromRecord(detailsStdout);
    if (nested) {
      return nested;
    }
  }

  const contentNested = extractFromContentArray(root.content);
  if (contentNested) {
    return contentNested;
  }

  const nestedResult = asRecord(root.result);
  if (nestedResult) {
    const nestedDirect = extractMcpErrorPayloadFromRecord(nestedResult);
    if (nestedDirect) {
      return nestedDirect;
    }

    const nestedContent = extractFromContentArray(nestedResult.content);
    if (nestedContent) {
      return nestedContent;
    }
  }

  return undefined;
}

function collectTextsFromRecord(record: Record<string, unknown>, out: string[], seen: Set<Record<string, unknown>>) {
  if (seen.has(record)) {
    return;
  }
  seen.add(record);

  const candidates = [record.aggregated, record.stdout, record.stderr, record.text];
  for (const candidate of candidates) {
    const text = readString(candidate);
    if (text) {
      out.push(text);
    }
  }

  const details = asRecord(record.details);
  if (details) {
    collectTextsFromRecord(details, out, seen);
  }

  const result = asRecord(record.result);
  if (result) {
    collectTextsFromRecord(result, out, seen);
  } else {
    const resultText = readString(record.result);
    if (resultText) {
      out.push(resultText);
    }
  }

  const content = Array.isArray(record.content) ? record.content : undefined;
  if (content) {
    for (const item of content) {
      const text = readString(asRecord(item)?.text);
      if (text) {
        out.push(text);
      }
      const nested = asRecord(item);
      if (nested) {
        collectTextsFromRecord(nested, out, seen);
      }
    }
  }
}

function collectApprovalCandidateTexts(input: unknown): string[] {
  const texts: string[] = [];
  const direct = readString(input);
  if (direct) {
    texts.push(direct);
  }

  const root = asRecord(input);
  if (!root) {
    return texts;
  }

  collectTextsFromRecord(root, texts, new Set<Record<string, unknown>>());
  return texts;
}

function extractIdFromText(text: string, key: string): string | undefined {
  const quotedPattern = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i");
  const quoted = text.match(quotedPattern)?.[1];
  if (quoted) {
    return normalizeIdentifier(quoted);
  }

  const singleQuotedPattern = new RegExp(`'${key}'\\s*:\\s*'([^']+)'`, "i");
  const singleQuoted = text.match(singleQuotedPattern)?.[1];
  if (singleQuoted) {
    return normalizeIdentifier(singleQuoted);
  }

  const loosePattern = new RegExp(`${key}\\s*[:=]\\s*([A-Za-z0-9._:-]+(?:\\s+[A-Za-z0-9._:-]+)*)`, "i");
  const loose = text.match(loosePattern)?.[1];
  if (loose) {
    return normalizeIdentifier(loose);
  }

  return undefined;
}

function normalizeURL(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const compact = value.trim();
  if (!compact) {
    return undefined;
  }
  return compact.replace(/[),.;]+$/g, "");
}

function extractURLFromText(text: string, key: string): string | undefined {
  const quotedPattern = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i");
  const quoted = normalizeURL(text.match(quotedPattern)?.[1]);
  if (quoted) {
    return quoted;
  }

  const singleQuotedPattern = new RegExp(`'${key}'\\s*:\\s*'([^']+)'`, "i");
  const singleQuoted = normalizeURL(text.match(singleQuotedPattern)?.[1]);
  if (singleQuoted) {
    return singleQuoted;
  }

  const loosePattern = new RegExp(`${key}\\s*[:=]\\s*(https?:\\/\\/\\S+)`, "i");
  return normalizeURL(text.match(loosePattern)?.[1]);
}

function recoverApprovalFromRaw(input: unknown): RecoveredApproval {
  const recovered: RecoveredApproval = { found: false };
  const texts = collectApprovalCandidateTexts(input);

  for (const text of texts) {
    if (!text.toUpperCase().includes("MCP_APPROVAL_REQUIRED")) {
      continue;
    }

    recovered.found = true;
    recovered.challengeId ??= extractIdFromText(text, "challenge_id");
    recovered.pendingId ??= extractIdFromText(text, "pending_id");
    recovered.runId ??= extractIdFromText(text, "run_id");
    recovered.jobId ??= extractIdFromText(text, "job_id");
    recovered.remoteAttestationURL ??= extractURLFromText(text, "remote_attestation_url");
  }

  return recovered;
}

function normalizeHandleKind(raw: unknown): ApprovalHandleKind | undefined {
  const kind = readString(raw)?.toUpperCase();
  if (kind === "JOB" || kind === "PLAN_RUN") {
    return kind;
  }
  return undefined;
}

function buildSignal(params: {
  tool: string;
  handle: ApprovalHandle;
  challengeId?: string;
  pendingId?: string;
  runId?: string;
  jobId?: string;
  remoteAttestationURL?: string;
  remoteAttestationLinkMarkdown?: string;
}): ApprovalSignal {
  const signal: ApprovalSignal = {
    tool: params.tool,
    handle: params.handle,
    challengeId: params.challengeId,
    pendingId: params.pendingId,
    runId: params.runId,
    jobId: params.jobId,
  };
  if (params.remoteAttestationURL) {
    signal.remoteAttestationURL = params.remoteAttestationURL;
  }
  if (params.remoteAttestationLinkMarkdown) {
    signal.remoteAttestationLinkMarkdown = params.remoteAttestationLinkMarkdown;
  }
  return signal;
}

function hasRecoverableHandle(recovered: RecoveredApproval): boolean {
  return Boolean(
    recovered.challengeId &&
      recovered.pendingId &&
      (recovered.runId || recovered.jobId),
  );
}

function buildRecoveredSignal(recovered: RecoveredApproval): ApprovalSignal {
  const kind: ApprovalHandleKind = recovered.runId ? "PLAN_RUN" : "JOB";
  const handle: ApprovalHandle = {
    kind,
    challenge_id: recovered.challengeId,
    pending_id: recovered.pendingId,
    run_id: recovered.runId,
    job_id: recovered.jobId,
  };

  return buildSignal({
    tool: FALLBACK_WAIT_TOOL,
    handle,
    challengeId: recovered.challengeId,
    pendingId: recovered.pendingId,
    runId: recovered.runId,
    jobId: recovered.jobId,
    remoteAttestationURL: recovered.remoteAttestationURL,
    remoteAttestationLinkMarkdown: recovered.remoteAttestationURL
      ? `[${recovered.remoteAttestationURL}](${recovered.remoteAttestationURL})`
      : undefined,
  });
}

function invalidResult(params: {
  message: string;
  challengeId?: string;
  pendingId?: string;
  runId?: string;
  jobId?: string;
}): ApprovalParseResult {
  return {
    type: "invalid",
    message: params.message,
    challengeId: params.challengeId,
    pendingId: params.pendingId,
    runId: params.runId,
    jobId: params.jobId,
  };
}

export function parseApprovalRequiredResult(input: unknown): ApprovalParseResult {
  const recovered = recoverApprovalFromRaw(input);
  const payload = extractMcpErrorPayload(input);

  if (!payload) {
    if (!recovered.found) {
      return { type: "not_approval" };
    }
    if (hasRecoverableHandle(recovered)) {
      return { type: "approval", signal: buildRecoveredSignal(recovered) };
    }
    return invalidResult({
      message: "approval payload malformed and fallback recovery missing required identifiers",
      challengeId: recovered.challengeId,
      pendingId: recovered.pendingId,
      runId: recovered.runId,
      jobId: recovered.jobId,
    });
  }

  if (payload.code !== "MCP_APPROVAL_REQUIRED") {
    if (!recovered.found) {
      return { type: "not_approval" };
    }
    if (hasRecoverableHandle(recovered)) {
      return { type: "approval", signal: buildRecoveredSignal(recovered) };
    }
    return invalidResult({
      message: "approval payload malformed and fallback recovery missing required identifiers",
      challengeId: recovered.challengeId,
      pendingId: recovered.pendingId,
      runId: recovered.runId,
      jobId: recovered.jobId,
    });
  }

  const details = payload.details;
  const approval = asRecord(details?.approval);
  if (!approval) {
    if (hasRecoverableHandle(recovered)) {
      return { type: "approval", signal: buildRecoveredSignal(recovered) };
    }
    return invalidResult({
      message: "approval details missing at error.details.approval",
      challengeId: recovered.challengeId,
      pendingId: recovered.pendingId,
      runId: recovered.runId,
      jobId: recovered.jobId,
    });
  }

  const challengeId = readIdentifier(approval.challenge_id) ?? recovered.challengeId;
  const pendingId = readIdentifier(approval.pending_id) ?? recovered.pendingId;
  const runIdFromApproval = readIdentifier(approval.run_id) ?? recovered.runId;
  const jobIdFromApproval = readIdentifier(approval.job_id) ?? recovered.jobId;
  const pendingApproval = asRecord(approval.pending_approval);
  const remoteAttestationURL =
    normalizeURL(readString(approval.remote_attestation_url)) ??
    normalizeURL(readString(pendingApproval?.remote_attestation_url)) ??
    recovered.remoteAttestationURL;
  const remoteAttestationLinkMarkdown =
    readString(approval.remote_attestation_link_markdown) ??
    (remoteAttestationURL ? `[${remoteAttestationURL}](${remoteAttestationURL})` : undefined);

  const nextAction = asRecord(approval.next_action);
  if (!nextAction) {
    if (hasRecoverableHandle({
      found: true,
      challengeId,
      pendingId,
      runId: runIdFromApproval,
      jobId: jobIdFromApproval,
    })) {
      return {
        type: "approval",
        signal: buildRecoveredSignal({
          found: true,
          challengeId,
          pendingId,
          runId: runIdFromApproval,
          jobId: jobIdFromApproval,
        }),
      };
    }
    return invalidResult({
      message: "approval.next_action missing",
      challengeId,
      pendingId,
      runId: runIdFromApproval,
      jobId: jobIdFromApproval,
    });
  }

  const tool = readString(nextAction.tool) ?? FALLBACK_WAIT_TOOL;

  const args = asRecord(nextAction.arguments);
  const handleRaw = asRecord(args?.handle);
  if (!handleRaw) {
    if (hasRecoverableHandle({
      found: true,
      challengeId,
      pendingId,
      runId: runIdFromApproval,
      jobId: jobIdFromApproval,
    })) {
      return {
        type: "approval",
        signal: buildRecoveredSignal({
          found: true,
          challengeId,
          pendingId,
          runId: runIdFromApproval,
          jobId: jobIdFromApproval,
        }),
      };
    }
    return invalidResult({
      message: "approval.next_action.arguments.handle missing",
      challengeId,
      pendingId,
      runId: runIdFromApproval,
      jobId: jobIdFromApproval,
    });
  }

  let kind = normalizeHandleKind(handleRaw.kind);
  const runId = readIdentifier(handleRaw.run_id) ?? runIdFromApproval;
  const jobId = readIdentifier(handleRaw.job_id) ?? jobIdFromApproval;
  if (!kind) {
    kind = runId ? "PLAN_RUN" : jobId ? "JOB" : undefined;
  }
  if (!kind) {
    return invalidResult({
      message: "approval handle kind must be JOB or PLAN_RUN",
      challengeId,
      pendingId,
      runId,
      jobId,
    });
  }

  if (kind === "PLAN_RUN" && !runId) {
    return invalidResult({
      message: "approval handle missing run_id for PLAN_RUN",
      challengeId,
      pendingId,
      runId,
      jobId,
    });
  }
  if (kind === "JOB" && !jobId) {
    return invalidResult({
      message: "approval handle missing job_id for JOB",
      challengeId,
      pendingId,
      runId,
      jobId,
    });
  }

  const handle: ApprovalHandle = {
    kind,
    challenge_id: readIdentifier(handleRaw.challenge_id) ?? challengeId,
    pending_id: readIdentifier(handleRaw.pending_id) ?? pendingId,
    run_id: runId,
    job_id: jobId,
  };

  return {
    type: "approval",
    signal: buildSignal({
      tool,
      handle,
      challengeId: handle.challenge_id,
      pendingId: handle.pending_id,
      runId: handle.run_id,
      jobId: handle.job_id,
      remoteAttestationURL,
      remoteAttestationLinkMarkdown,
    }),
  };
}
