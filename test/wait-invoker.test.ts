import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayToolsInvokeWaitInvoker, parseMcporterWaitSuccess } from "../src/wait-invoker.js";
import { WaitCallError } from "../src/types.js";

describe("parseMcporterWaitSuccess", () => {
  it("parses direct success envelope", () => {
    const parsed = parseMcporterWaitSuccess({
      ok: true,
      data: {
        done: true,
        terminal_status: "SUCCEEDED",
        decision_outcome: "ALLOW",
      },
    });

    expect(parsed.done).toBe(true);
    expect(parsed.terminalStatus).toBe("SUCCEEDED");
    expect(parsed.decisionOutcome).toBe("ALLOW");
  });

  it("parses nested stringified payload", () => {
    const parsed = parseMcporterWaitSuccess({
      ok: true,
      data: "{\"result\":{\"done\":true,\"terminal_status\":\"SUCCEEDED\",\"decision_outcome\":\"ALLOW\"}}",
    });

    expect(parsed.done).toBe(true);
    expect(parsed.terminalStatus).toBe("SUCCEEDED");
    expect(parsed.decisionOutcome).toBe("ALLOW");
  });

  it("parses content array payload", () => {
    const parsed = parseMcporterWaitSuccess({
      ok: true,
      result: {
        content: [
          {
            type: "text",
            text: "{\"done\":true,\"terminal_status\":\"SUCCEEDED\",\"decision_outcome\":\"ALLOW\"}",
          },
        ],
      },
    });

    expect(parsed.done).toBe(true);
    expect(parsed.terminalStatus).toBe("SUCCEEDED");
    expect(parsed.decisionOutcome).toBe("ALLOW");
  });

  it("parses status/outcome payload variants and infers done", () => {
    const parsed = parseMcporterWaitSuccess({
      ok: true,
      data: {
        status: "succeeded",
        decisionOutcome: "allow",
      },
    });

    expect(parsed.done).toBe(true);
    expect(parsed.terminalStatus).toBe("SUCCEEDED");
    expect(parsed.decisionOutcome).toBe("ALLOW");
  });

  it("throws validation error for malformed payload", () => {
    expect(() =>
      parseMcporterWaitSuccess({
        ok: true,
        data: null,
      }),
    ).toThrowError(WaitCallError);
  });
});

describe("createGatewayToolsInvokeWaitInvoker reconciliation", () => {
  const originalUrl = process.env.OPENCLAW_GATEWAY_HTTP_URL;
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  beforeEach(() => {
    process.env.OPENCLAW_GATEWAY_HTTP_URL = "http://127.0.0.1:18789";
    process.env.OPENCLAW_GATEWAY_TOKEN = "token";
  });

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.OPENCLAW_GATEWAY_HTTP_URL;
    } else {
      process.env.OPENCLAW_GATEWAY_HTTP_URL = originalUrl;
    }
    if (originalToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeInvoker() {
    return createGatewayToolsInvokeWaitInvoker({
      gateway: {
        auth: { mode: "token", token: "token" },
      },
    } as never);
  }

  it("reconciles malformed wait payload through pending_get as ALLOW", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tool = String(body.tool ?? "");
      if (tool === "vaultclaw_approval_wait") {
        return new Response(JSON.stringify({ ok: true, result: { ok: true, result: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (tool === "vaultclaw_approvals_pending_get") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              ok: true,
              result: {
                ok: true,
                data: {
                  item: { state: "SUCCEEDED" },
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected tool ${tool}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeInvoker()({
      sessionKey: "agent:main:main",
      handle: {
        kind: "PLAN_RUN",
        challenge_id: "ach_1",
        pending_id: "apj_1",
        run_id: "run_1",
        job_id: "job_1",
      },
      pollIntervalMs: 1500,
      maxWaitMs: 10000,
      commandTimeoutMs: 20000,
      reconcile: {
        onValidationError: true,
        onUnknownTerminal: true,
        timeoutMs: 5000,
      },
    });

    expect(result.done).toBe(true);
    expect(result.decisionOutcome).toBe("ALLOW");
    expect(result.terminalStatus).toBe("SUCCEEDED");
    expect((result.raw as Record<string, unknown>).source).toBe("reconcile_pending_get");
  });

  it("maps DENIED pending state to DENY", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tool = String(body.tool ?? "");
      if (tool === "vaultclaw_approval_wait") {
        return new Response(JSON.stringify({ ok: true, result: { ok: true, result: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (tool === "vaultclaw_approvals_pending_get") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              ok: true,
              result: {
                ok: true,
                data: {
                  item: { state: "DENIED" },
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected tool ${tool}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeInvoker()({
      sessionKey: "agent:main:main",
      handle: {
        kind: "PLAN_RUN",
        challenge_id: "ach_2",
        pending_id: "apj_2",
        run_id: "run_2",
        job_id: "job_2",
      },
      pollIntervalMs: 1500,
      maxWaitMs: 10000,
      commandTimeoutMs: 20000,
      reconcile: {
        onValidationError: true,
        onUnknownTerminal: true,
        timeoutMs: 5000,
      },
    });

    expect(result.done).toBe(true);
    expect(result.decisionOutcome).toBe("DENY");
    expect(result.terminalStatus).toBe("DENIED");
  });

  it("returns retryable error when reconciliation sees RUNNING state", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tool = String(body.tool ?? "");
      if (tool === "vaultclaw_approval_wait") {
        return new Response(JSON.stringify({ ok: true, result: { ok: true, result: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (tool === "vaultclaw_approvals_pending_get") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              ok: true,
              result: {
                ok: true,
                data: {
                  item: { state: "RUNNING" },
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected tool ${tool}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      makeInvoker()({
        sessionKey: "agent:main:main",
        handle: {
          kind: "PLAN_RUN",
          challenge_id: "ach_3",
          pending_id: "apj_3",
          run_id: "run_3",
          job_id: "job_3",
        },
        pollIntervalMs: 1500,
        maxWaitMs: 10000,
        commandTimeoutMs: 20000,
        reconcile: {
          onValidationError: true,
          onUnknownTerminal: true,
          timeoutMs: 5000,
        },
      }),
    ).rejects.toMatchObject({
      name: "WaitCallError",
      retryable: true,
    });
  });

  it("falls back to job_get reconciliation when pending identifiers are missing", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tool = String(body.tool ?? "");
      if (tool === "vaultclaw_approval_wait") {
        return new Response(JSON.stringify({ ok: true, result: { ok: true, result: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (tool === "vaultclaw_job_get") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              ok: true,
              result: {
                ok: true,
                data: {
                  decision_outcome: "ALLOW",
                  job: { status: "SUCCEEDED" },
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected tool ${tool}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeInvoker()({
      sessionKey: "agent:main:main",
      handle: {
        kind: "JOB",
        job_id: "job_4",
      },
      pollIntervalMs: 1500,
      maxWaitMs: 10000,
      commandTimeoutMs: 20000,
      reconcile: {
        onValidationError: true,
        onUnknownTerminal: true,
        timeoutMs: 5000,
      },
    });

    expect(result.done).toBe(true);
    expect(result.decisionOutcome).toBe("ALLOW");
    expect(result.terminalStatus).toBe("SUCCEEDED");
    expect((result.raw as Record<string, unknown>).source).toBe("reconcile_job_get");
  });
});
