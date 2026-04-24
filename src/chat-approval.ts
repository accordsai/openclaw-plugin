import { parseApprovalRequiredResult } from "./approval-payload.js";
import { approvalRequiredMessage } from "./messages.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (!text) {
      continue;
    }
    out.push(text);
  }
  return out;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = asString(value).toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "no" || normalized === "0") {
    return false;
  }
  return undefined;
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  return { ...value };
}

function decisionModeFromOption(option: string): string {
  const normalized = option.trim().toLowerCase();
  if (normalized === "approve_n_calls" || normalized === "deny_n_calls") {
    return "n_calls";
  }
  if (normalized === "approve_until" || normalized === "deny_until") {
    return "until_utc";
  }
  if (normalized === "approve_scoped_once" || normalized === "deny_scoped_once") {
    return "http_scope";
  }
  return "fixed";
}

function optionLabelFromValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "approve_once":
      return "Approve once";
    case "deny_once":
      return "Deny once";
    case "approve_n_calls":
      return "Approve N calls";
    case "deny_n_calls":
      return "Deny N calls";
    case "approve_until":
      return "Approve until";
    case "deny_until":
      return "Deny until";
    case "approve_scoped_once":
      return "Approve scoped once";
    case "deny_scoped_once":
      return "Deny scoped once";
    default:
      return value;
  }
}

function parseOptions(
  rawOptions: unknown,
  rawDecisionPayloads: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (Array.isArray(rawOptions)) {
    const out: Record<string, unknown>[] = [];
    for (const item of rawOptions) {
      const row = asRecord(item);
      if (!row) {
        continue;
      }
      const value = asString(row.value);
      if (!value) {
        continue;
      }
      const next: Record<string, unknown> = {
        value,
        label: asString(row.label) || optionLabelFromValue(value),
        decision_mode: asString(row.decision_mode) || decisionModeFromOption(value),
      };
      const inputSchema = asRecord(row.input_schema);
      if (inputSchema) {
        next.input_schema = cloneRecord(inputSchema);
      }
      out.push(next);
    }
    if (out.length > 0) {
      return out;
    }
  }

  if (!rawDecisionPayloads || Object.keys(rawDecisionPayloads).length === 0) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const option of Object.keys(rawDecisionPayloads)) {
    const value = asString(option);
    if (!value) {
      continue;
    }
    out.push({
      value,
      label: optionLabelFromValue(value),
      decision_mode: decisionModeFromOption(value),
    });
  }
  out.sort((left, right) => asString(left.value).localeCompare(asString(right.value)));
  return out;
}

function hasKey(record: Record<string, unknown> | undefined, key: string): boolean {
  if (!record) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeMissingInputToken(value: string, fallback: string): string {
  const source = asString(value) || asString(fallback) || "x";
  const lower = source.toLowerCase();
  let out = "";
  for (const char of lower) {
    const code = char.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit || char === "." || char === "-" || char === "_") {
      out += char;
      continue;
    }
    out += "_";
  }
  out = out.replace(/^_+|_+$/g, "");
  return out || "x";
}

function missingInputIDForDocumentClaim(slot: string, subjectID: string, typeID: string): string {
  const slotPart = normalizeMissingInputToken(slot, "slot");
  const subjectPart = normalizeMissingInputToken(subjectID, "self");
  const typePart = normalizeMissingInputToken(typeID, "document");
  return `doc__${slotPart}__${subjectPart}__${typePart}`;
}

function claimHasExplicitMissingEvidence(row: Record<string, unknown>): boolean {
  const missing = asBoolean(row.missing);
  if (missing === true) {
    return true;
  }
  const resolved = asBoolean(row.resolved);
  if (resolved === false) {
    return true;
  }
  const resolveStatus = asString(row.resolve_status).toLowerCase();
  if (resolveStatus === "missing" || resolveStatus === "unresolved") {
    return true;
  }
  const reasonCode = asString(row.reason_code).toUpperCase();
  if (
    reasonCode === "DOCUMENT_NOT_FOUND" ||
    reasonCode === "DOCUMENT_SLOT_UNRESOLVED" ||
    reasonCode === "DOCUMENT_ATTACHMENT_UNRESOLVED"
  ) {
    return true;
  }
  return false;
}

function appendMissingDocumentInput(
  row: Record<string, unknown>,
  out: Record<string, unknown>[],
  seenInputIDs: Set<string>,
): void {
  const typeID = asString(row.type_id) || asString(row.declared_type) || asString(row.hint_type);
  if (!typeID) {
    return;
  }
  const required = asBoolean(row.required);
  if (required === false) {
    return;
  }
  const slot = asString(row.slot) || "document_attachment";
  const subjectID = asString(row.subject_id) || "self";
  const inputID = asString(row.input_id) || missingInputIDForDocumentClaim(slot, subjectID, typeID);
  if (!inputID || seenInputIDs.has(inputID)) {
    return;
  }
  seenInputIDs.add(inputID);

  const label = asString(row.label) || asString(row.display_name) || typeID;
  const tags = asStringArray(row.tags);
  if (tags.length === 0 && slot) {
    tags.push(`slot:${slot}`);
  }
  out.push({
    input_id: inputID,
    kind: "document",
    label,
    description: asString(row.description) || `Upload ${label} to continue this request.`,
    required: true,
    declared_type: asString(row.declared_type) || typeID,
    hint_type: asString(row.hint_type) || typeID,
    tags,
    file_accept: asString(row.file_accept) || "application/pdf,image/*",
  });
}

function synthesizeMissingInputsFromExplicitEvidence(
  pending: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!pending) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  const seenInputIDs = new Set<string>();

  const unresolvedClaims = Array.isArray(pending.unresolved_required_document_access)
    ? pending.unresolved_required_document_access
    : [];
  for (const item of unresolvedClaims) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    appendMissingDocumentInput(row, out, seenInputIDs);
  }

  const challenge = asRecord(pending.challenge);
  const requiredDocClaims = Array.isArray(challenge?.required_document_access)
    ? challenge.required_document_access
    : [];
  for (const item of requiredDocClaims) {
    const row = asRecord(item);
    if (!row || !claimHasExplicitMissingEvidence(row)) {
      continue;
    }
    appendMissingDocumentInput(row, out, seenInputIDs);
  }
  return out;
}

function parseMissingInputs(rawMissing: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rawMissing)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const item of rawMissing) {
    const row = asRecord(item);
    if (!row) {
      const id = asString(item);
      if (!id) {
        continue;
      }
      out.push({
        input_id: id,
        kind: "secret",
        label: id,
        required: true,
      });
      continue;
    }
    const inputID = asString(row.input_id);
    if (!inputID) {
      continue;
    }
    out.push({
      input_id: inputID,
      kind: asString(row.kind) || "secret",
      label: asString(row.label) || inputID,
      description: asString(row.description),
      required: Boolean(row.required),
      secret_type: asString(row.secret_type),
      default_intent: asString(row.default_intent),
      declared_type: asString(row.declared_type),
      hint_type: asString(row.hint_type),
      tags: asStringArray(row.tags),
      filename: asString(row.filename),
      file_accept: asString(row.file_accept),
    });
  }
  return out;
}

function collectClaimLabels(rawClaims: unknown): string[] {
  if (!Array.isArray(rawClaims)) {
    return [];
  }
  const labels = new Set<string>();
  for (const item of rawClaims) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const intents = asStringArray(row.allowed_intents);
    for (const intent of intents) {
      labels.add(intent);
    }
    const slot = asString(row.slot);
    if (slot) {
      labels.add(slot);
    }
    const secretType = asString(row.secret_type);
    if (secretType) {
      labels.add(secretType);
    }
    const typeID = asString(row.type_id);
    if (typeID) {
      labels.add(typeID);
    }
  }
  return Array.from(labels).sort((left, right) => left.localeCompare(right));
}

function parseFoundVaultFields(pending: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const challenge = asRecord(pending?.challenge);
  if (!challenge) {
    return [];
  }
  const labels = new Set<string>();
  for (const label of collectClaimLabels(challenge.required_secret_access)) {
    labels.add(label);
  }
  for (const label of collectClaimLabels(challenge.required_document_access)) {
    labels.add(label);
  }
  const out: Record<string, unknown>[] = [];
  for (const field of Array.from(labels).sort((left, right) => left.localeCompare(right))) {
    out.push({
      field,
      masked_value: "[masked]",
    });
  }
  return out;
}

function normalizeExposure(value: unknown): "yes" | "no" | "possible" {
  const normalized = asString(value).toLowerCase();
  if (normalized === "yes" || normalized === "possible") {
    return normalized;
  }
  return "no";
}

function parseDataFlowRows(rawFlow: unknown): Record<string, unknown>[] {
  const flow = asRecord(rawFlow);
  if (!flow) {
    return [];
  }
  const claimRows = Array.isArray(flow.claim_rows) ? flow.claim_rows : [];
  const claimByResource = new Map<string, string[]>();
  for (const item of claimRows) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const resource = asString(row.resource);
    if (!resource) {
      continue;
    }
    const claim = asString(row.claim) || asString(row.slot) || asString(row.type_id);
    if (!claim) {
      continue;
    }
    const current = claimByResource.get(resource) ?? [];
    current.push(claim);
    claimByResource.set(resource, current);
  }

  const resources = ["secrets", "documents", "auth_credentials"];
  const out: Record<string, unknown>[] = [];
  for (const resource of resources) {
    const details = asRecord(flow[resource]);
    if (!details) {
      continue;
    }
    const summary: string[] = [];
    const endpointReason = asString(details.endpoint_reason);
    const agentReason = asString(details.agent_reason);
    if (endpointReason) {
      summary.push(`End client: ${endpointReason}`);
    }
    if (agentReason) {
      summary.push(`Outside agent: ${agentReason}`);
    }
    const claims = (claimByResource.get(resource) ?? []).sort((left, right) => left.localeCompare(right));
    out.push({
      resource,
      outside_agent_sees: normalizeExposure(details.agent),
      end_client_sees: normalizeExposure(details.endpoint),
      claims,
      summary,
    });
  }
  return out;
}

function parseDecisionPayloads(rawPayloads: unknown): Record<string, unknown> | undefined {
  const payloads = asRecord(rawPayloads);
  if (!payloads) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [option, envelopeRaw] of Object.entries(payloads)) {
    const key = asString(option);
    const envelope = asRecord(envelopeRaw);
    if (!key || !envelope) {
      continue;
    }
    const payload = asRecord(envelope.payload);
    out[key] = {
      context: asString(envelope.context),
      payload_hash_sha256: asString(envelope.payload_hash_sha256),
      payload: payload ? cloneRecord(payload) : envelope.payload,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseWebAuthnAssertions(rawAssertions: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rawAssertions)) {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const item of rawAssertions) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const keyID = asString(row.key_id);
    if (!keyID) {
      continue;
    }
    const next = cloneRecord(row);
    if (next) {
      out.push(next);
    }
  }
  return out;
}

function parseApprovalRequest(parsed: ReturnType<typeof parseApprovalRequiredResult>): Record<string, unknown> | undefined {
  if (parsed.type !== "approval") {
    return undefined;
  }
  const approval = parsed.approval;
  const pending = parsed.pendingApproval ?? approval;
  const prompt = asRecord(pending?.approval_prompt) ?? asRecord(approval?.approval_prompt);
  const decisionPayloads = parseDecisionPayloads(pending?.decision_payloads);
  const options = parseOptions(pending?.remote_options, decisionPayloads);
  const missingInputsAuthoritative = hasKey(pending, "missing_inputs");
  const parsedMissingInputs = parseMissingInputs(pending?.missing_inputs);
  const missingInputs = missingInputsAuthoritative
    ? parsedMissingInputs
    : parsedMissingInputs.length > 0
      ? parsedMissingInputs
      : synthesizeMissingInputsFromExplicitEvidence(pending);
  const foundFields = parseFoundVaultFields(pending);
  const dataFlowRows = parseDataFlowRows(pending?.if_approved_data_flow);
  const fallbackURL = asString(pending?.remote_attestation_url) || parsed.signal.remoteAttestationURL || "";

  const requestID =
    asString(pending?.remote_request_id) ||
    parsed.signal.pendingId ||
    parsed.signal.challengeId ||
    parsed.signal.runId ||
    parsed.signal.jobId ||
    "";
  if (!requestID) {
    return undefined;
  }

  const out: Record<string, unknown> = {
    request_id: requestID,
    title: asString(prompt?.title) || "Vault Access Request",
    summary: asString(prompt?.body) || asString(prompt?.summary),
    state: "PENDING",
    options,
    found_vault_fields: foundFields,
    missing_inputs: missingInputs,
    data_flow_rows: dataFlowRows,
    remote_attestation_url: fallbackURL,
  };
  const pendingID = asString(pending?.pending_id) || parsed.signal.pendingId || "";
  if (pendingID) {
    out.pending_id = pendingID;
  }
  const remoteRequestID = asString(pending?.remote_request_id);
  if (remoteRequestID) {
    out.remote_request_id = remoteRequestID;
  }
  if (decisionPayloads) {
    out.decision_payloads = decisionPayloads;
  }
  const webauthnAssertions = parseWebAuthnAssertions(pending?.webauthn_assertions);
  if (webauthnAssertions.length > 0) {
    out.webauthn_assertions = webauthnAssertions;
  }
  const webauthnAssertion = asRecord(pending?.webauthn_assertion);
  if (webauthnAssertion) {
    out.webauthn_assertion = cloneRecord(webauthnAssertion);
  } else if (webauthnAssertions.length > 0) {
    out.webauthn_assertion = cloneRecord(webauthnAssertions[0]);
  }
  return out;
}

export type StructuredApprovalReply = {
  text: string;
  approval_required: boolean;
  approval_request?: Record<string, unknown>;
  vault_data_found?: string[];
  vault_data_missing?: string[];
};

export function buildStructuredApprovalReply(
  envelope: unknown,
  maxWaitMs: number,
): StructuredApprovalReply | undefined {
  const parsed = parseApprovalRequiredResult(envelope);
  if (parsed.type !== "approval") {
    return undefined;
  }
  const approvalRequest = parseApprovalRequest(parsed);
  const out: StructuredApprovalReply = {
    text: approvalRequiredMessage(parsed.signal, maxWaitMs),
    approval_required: true,
  };
  if (approvalRequest) {
    out.approval_request = approvalRequest;
    const foundFields = Array.isArray(approvalRequest.found_vault_fields)
      ? approvalRequest.found_vault_fields
      : [];
    const found = foundFields
      .map((item) => asString(asRecord(item)?.field))
      .filter((entry) => entry.length > 0);
    if (found.length > 0) {
      out.vault_data_found = found;
    }
    const missingInputs = Array.isArray(approvalRequest.missing_inputs)
      ? approvalRequest.missing_inputs
      : [];
    const missing = missingInputs
      .map((item) => {
        const row = asRecord(item);
        return asString(row?.input_id) || asString(row?.label);
      })
      .filter((entry) => entry.length > 0);
    if (missing.length > 0) {
      out.vault_data_missing = missing;
    }
  }
  return out;
}
