import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeResolvedVaultRoute } from "../src/vault-executor.js";
import { invokeGatewayTool, type ToolInvokeResponse } from "../src/vault-gateway-client.js";

vi.mock("../src/vault-gateway-client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/vault-gateway-client.js")>(
    "../src/vault-gateway-client.js",
  );
  return {
    ...actual,
    invokeGatewayTool: vi.fn(),
  };
});

function toolEnvelopeResult(envelope: Record<string, unknown>): ToolInvokeResponse {
  return {
    statusCode: 200,
    body: { ok: true },
    invokeResult: envelope,
  };
}

describe("executeResolvedVaultRoute approval parsing", () => {
  const invokeMock = vi.mocked(invokeGatewayTool);

  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("returns approval_required when tool envelope has a valid approval payload", async () => {
    invokeMock
      .mockResolvedValueOnce(toolEnvelopeResult({ ok: true, data: {} }))
      .mockResolvedValueOnce(
        toolEnvelopeResult({
          ok: false,
          error: {
            code: "MCP_APPROVAL_REQUIRED",
            details: {
              approval: {
                challenge_id: "ach_100",
                pending_id: "apj_100",
                run_id: "run_100",
                job_id: "job_100",
                next_action: {
                  tool: "vaultclaw_approval_wait",
                  arguments: {
                    handle: {
                      kind: "PLAN_RUN",
                      challenge_id: "ach_100",
                      pending_id: "apj_100",
                      run_id: "run_100",
                      job_id: "job_100",
                    },
                  },
                },
              },
            },
          },
        }),
      );

    const outcome = await executeResolvedVaultRoute({
      config: {} as any,
      payload: {
        status: "RESOLVED_EXECUTABLE",
        execution: {
          strategy: "CONNECTOR_EXECUTE_JOB",
          connector_id: "google.gmail",
          verb: "send_email",
        },
        inputs: {
          method: "POST",
          url: "https://example.com/send",
        },
      } as any,
      sessionKey: "agent:main:main",
      timeoutMs: 5000,
    });

    expect(outcome.kind).toBe("approval_required");
  });

  it("returns error when approval payload is malformed and non-actionable", async () => {
    invokeMock
      .mockResolvedValueOnce(toolEnvelopeResult({ ok: true, data: {} }))
      .mockResolvedValueOnce(
        toolEnvelopeResult({
          details: {
            aggregated:
              "{\"ok\":false,\"error\":{\"code\":\"MCP_APPROVAL_REQUIRED\",\"details\":{\"approval\":{\"challenge_id\":\"ach_only\"",
          },
        }),
      );

    const outcome = await executeResolvedVaultRoute({
      config: {} as any,
      payload: {
        status: "RESOLVED_EXECUTABLE",
        execution: {
          strategy: "CONNECTOR_EXECUTE_JOB",
          connector_id: "google.gmail",
          verb: "send_email",
        },
        inputs: {
          method: "POST",
          url: "https://example.com/send",
        },
      } as any,
      sessionKey: "agent:main:main",
      timeoutMs: 5000,
    });

    expect(outcome).toEqual({
      kind: "error",
      code: "MCP_APPROVAL_REQUIRED",
      message:
        "approval response was malformed: approval payload malformed and fallback recovery missing required identifiers",
    });
  });
});
