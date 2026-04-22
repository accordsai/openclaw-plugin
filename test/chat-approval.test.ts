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
            remote_attestation_url: "https://alerts.accords.ai/a/vault_test/apj_approval_1/redeem_code",
          },
        },
      },
    };

    const structured = buildStructuredApprovalReply(envelope, 600000);
    expect(structured).toBeDefined();
    expect(structured?.approval_required).toBe(true);
    expect(structured?.approval_request?.request_id).toBe("apj_approval_1");
    expect(structured?.approval_request?.title).toBe("Vault Access Request");
    expect(structured?.approval_request?.summary).toBe("Complete flight booking to San Francisco");

    const options = structured?.approval_request?.options as Array<Record<string, unknown>>;
    expect(Array.isArray(options)).toBe(true);
    expect(options[0]?.value).toBe("approve_once");

    const decisionPayloads = structured?.approval_request?.decision_payloads as Record<string, unknown>;
    expect(decisionPayloads?.approve_once).toBeDefined();

    const dataFlowRows = structured?.approval_request?.data_flow_rows as Array<Record<string, unknown>>;
    expect(Array.isArray(dataFlowRows)).toBe(true);
    expect(dataFlowRows.some((row) => row.resource === "secrets")).toBe(true);

    const foundFields = structured?.approval_request?.found_vault_fields as Array<Record<string, unknown>>;
    expect(foundFields.some((row) => row.field === "full_name")).toBe(true);
    expect(foundFields.some((row) => row.field === "passport_document")).toBe(true);
    expect(structured?.vault_data_found).toContain("full_name");
    expect(structured?.vault_data_found).toContain("passport_document");
  });
});
