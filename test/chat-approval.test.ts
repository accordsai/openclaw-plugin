import { describe, expect, it } from "vitest";
import { buildStructuredApprovalReply } from "../src/chat-approval.js";

describe("chat approval payload builder", () => {
  it("builds structured approval metadata from pending_approval payload", () => {
    const envelope = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          pending_approval: {
            pending_id: "apj_approval_1",
            challenge_id: "ach_approval_1",
            run_id: "run_approval_1",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "PLAN_RUN",
                  run_id: "run_approval_1",
                  challenge_id: "ach_approval_1",
                  pending_id: "apj_approval_1",
                },
              },
            },
            approval_prompt: {
              title: "Vault Access Request",
              body: "Complete flight booking to San Francisco",
            },
            remote_options: [
              {
                value: "approve_once",
                label: "Approve once",
                decision_mode: "fixed",
              },
            ],
            decision_payloads: {
              approve_once: {
                context: "connector.approval.decision.v1",
                payload_hash_sha256: "abc123",
                payload: {
                  challenge_id: "ach_approval_1",
                  effect: "ALLOW",
                },
              },
            },
            challenge: {
              required_secret_access: [
                {
                  slot: "user.full_name",
                  allowed_intents: ["full_name"],
                },
              ],
              required_document_access: [
                {
                  type_id: "passport_document",
                },
              ],
            },
            if_approved_data_flow: {
              secrets: {
                endpoint: "yes",
                agent: "no",
                endpoint_reason: "Endpoint receives secret-derived payload data.",
                agent_reason: "No direct secret reflection path to the approving agent.",
              },
              documents: {
                endpoint: "possible",
                agent: "no",
                endpoint_reason: "Document attachment may be included if provided.",
                agent_reason: "No direct document reflection path to the approving agent.",
              },
              auth_credentials: {
                endpoint: "yes",
                agent: "no",
                endpoint_reason: "Auth credentials are required for outbound authorization.",
                agent_reason: "No direct credential echo to the approving agent.",
              },
              claim_rows: [
                {
                  resource: "secrets",
                  claim: "full_name",
                },
                {
                  resource: "documents",
                  claim: "passport_document",
                },
              ],
            },
            webauthn_assertion: {
              key_id: "approver.webauthn.main",
              challenge_id: "ach_approval_1",
              challenge_b64u: "Y2hhbGxlbmdl",
              rp_id: "app.vaultclaw.local",
              allowed_origins: ["https://app.vaultclaw.local"],
              user_verification: "preferred",
            },
            webauthn_assertions: [
              {
                key_id: "approver.webauthn.main",
                challenge_id: "ach_approval_1",
                challenge_b64u: "Y2hhbGxlbmdl",
                rp_id: "app.vaultclaw.local",
                allowed_origins: ["https://app.vaultclaw.local"],
                user_verification: "preferred",
              },
              {
                key_id: "approver.webauthn.local",
                challenge_id: "ach_approval_1",
                challenge_b64u: "Y2hhbGxlbmdl",
                rp_id: "localhost",
                allowed_origins: ["http://localhost:13000"],
                user_verification: "preferred",
              },
            ],
            remote_attestation_url: "https://alerts.accords.ai/a/vault_test/apj_approval_1/redeem_code",
          },
        },
      },
    };

    const structured = buildStructuredApprovalReply(envelope, 600000);
    expect(structured).toBeDefined();
    expect(structured?.approval_required).toBe(true);
    expect(structured?.approval_request?.request_id).toBe("apj_approval_1");
    expect(structured?.approval_request?.pending_id).toBe("apj_approval_1");
    expect(structured?.approval_request?.title).toBe("Vault Access Request");
    expect(structured?.approval_request?.summary).toBe("Complete flight booking to San Francisco");

    const options = structured?.approval_request?.options as Array<Record<string, unknown>>;
    expect(Array.isArray(options)).toBe(true);
    expect(options[0]?.value).toBe("approve_once");

    const decisionPayloads = structured?.approval_request?.decision_payloads as Record<string, unknown>;
    expect(decisionPayloads?.approve_once).toBeDefined();
    const webAuthnAssertions = structured?.approval_request?.webauthn_assertions as Array<Record<string, unknown>>;
    expect(Array.isArray(webAuthnAssertions)).toBe(true);
    expect(webAuthnAssertions).toHaveLength(2);
    expect(webAuthnAssertions[1]?.key_id).toBe("approver.webauthn.local");

    const dataFlowRows = structured?.approval_request?.data_flow_rows as Array<Record<string, unknown>>;
    expect(Array.isArray(dataFlowRows)).toBe(true);
    expect(dataFlowRows.some((row) => row.resource === "secrets")).toBe(true);

    const foundFields = structured?.approval_request?.found_vault_fields as Array<Record<string, unknown>>;
    expect(foundFields.some((row) => row.field === "full_name")).toBe(true);
    expect(foundFields.some((row) => row.field === "passport_document")).toBe(true);
    expect(structured?.vault_data_found).toContain("full_name");
    expect(structured?.vault_data_found).toContain("passport_document");
  });

  it("includes remote_request_id when provided without changing request_id shape", () => {
    const envelope = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          pending_approval: {
            pending_id: "apj_remote_request_id",
            remote_request_id: "rrq_remote_request_id",
            challenge_id: "ach_remote_request_id",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "JOB",
                  job_id: "job_remote_request_id",
                  challenge_id: "ach_remote_request_id",
                  pending_id: "apj_remote_request_id",
                },
              },
            },
            remote_options: [
              {
                value: "approve_once",
                label: "Approve once",
              },
            ],
            decision_payloads: {
              approve_once: {
                context: "connector.approval.decision.v1",
                payload_hash_sha256: "abc123",
                payload: {
                  challenge_id: "ach_remote_request_id",
                  effect: "ALLOW",
                },
              },
            },
            webauthn_assertion: {
              key_id: "approver.webauthn.main",
              challenge_id: "ach_remote_request_id",
              challenge_b64u: "Y2hhbGxlbmdl",
              rp_id: "app.vaultclaw.local",
              allowed_origins: ["https://app.vaultclaw.local"],
            },
          },
        },
      },
    };

    const structured = buildStructuredApprovalReply(envelope, 600000);
    expect(structured?.approval_request?.pending_id).toBe("apj_remote_request_id");
    expect(structured?.approval_request?.remote_request_id).toBe("rrq_remote_request_id");
    expect(structured?.approval_request?.request_id).toBe("rrq_remote_request_id");
  });

  it("uses authoritative missing_inputs when pending payload provides them", () => {
    const envelope = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          pending_approval: {
            pending_id: "apj_missing_inputs_authoritative",
            challenge_id: "ach_missing_inputs_authoritative",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "JOB",
                  job_id: "job_missing_inputs_authoritative",
                  challenge_id: "ach_missing_inputs_authoritative",
                  pending_id: "apj_missing_inputs_authoritative",
                },
              },
            },
            missing_inputs: [
              {
                input_id: "passport_upload",
                kind: "document",
                label: "Passport Document",
                required: true,
                declared_type: "identity.passport",
              },
            ],
            challenge: {
              required_document_access: [
                {
                  slot: "s1:document_attachment",
                  type_id: "identity.passport",
                  subject_id: "self",
                  required: true,
                },
              ],
            },
          },
        },
      },
    };

    const structured = buildStructuredApprovalReply(envelope, 600000);
    const missingInputs = structured?.approval_request?.missing_inputs as Array<Record<string, unknown>>;
    expect(Array.isArray(missingInputs)).toBe(true);
    expect(missingInputs).toHaveLength(1);
    expect(missingInputs[0]?.input_id).toBe("passport_upload");
    expect(missingInputs[0]?.declared_type).toBe("identity.passport");
  });

  it("synthesizes missing document inputs from explicit unresolved evidence when missing_inputs is absent", () => {
    const envelope = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          pending_approval: {
            pending_id: "apj_unresolved_claim",
            challenge_id: "ach_unresolved_claim",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "JOB",
                  job_id: "job_unresolved_claim",
                  challenge_id: "ach_unresolved_claim",
                  pending_id: "apj_unresolved_claim",
                },
              },
            },
            unresolved_required_document_access: [
              {
                slot: "create_draft:document_attachment",
                type_id: "identity.passport",
                subject_id: "self",
                required: true,
                resolved: false,
                missing: true,
                reason_code: "DOCUMENT_NOT_FOUND",
              },
            ],
            challenge: {
              required_document_access: [
                {
                  slot: "create_draft:document_attachment",
                  type_id: "identity.passport",
                  subject_id: "self",
                  required: true,
                },
              ],
            },
          },
        },
      },
    };

    const structured = buildStructuredApprovalReply(envelope, 600000);
    const missingInputs = structured?.approval_request?.missing_inputs as Array<Record<string, unknown>>;
    expect(Array.isArray(missingInputs)).toBe(true);
    expect(missingInputs).toHaveLength(1);
    expect(missingInputs[0]?.kind).toBe("document");
    expect(missingInputs[0]?.declared_type).toBe("identity.passport");
    expect(structured?.vault_data_missing?.length).toBe(1);
  });

  it("does not synthesize missing document inputs from required_document_access without explicit unresolved evidence", () => {
    const envelope = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          pending_approval: {
            pending_id: "apj_no_unresolved_evidence",
            challenge_id: "ach_no_unresolved_evidence",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "JOB",
                  job_id: "job_no_unresolved_evidence",
                  challenge_id: "ach_no_unresolved_evidence",
                  pending_id: "apj_no_unresolved_evidence",
                },
              },
            },
            challenge: {
              required_document_access: [
                {
                  slot: "create_draft:document_attachment",
                  type_id: "identity.passport",
                  subject_id: "self",
                  required: true,
                },
              ],
            },
          },
        },
      },
    };

    const structured = buildStructuredApprovalReply(envelope, 600000);
    const missingInputs = structured?.approval_request?.missing_inputs as Array<Record<string, unknown>>;
    expect(Array.isArray(missingInputs)).toBe(true);
    expect(missingInputs).toHaveLength(0);
    expect(structured?.vault_data_missing).toBeUndefined();
  });
});
