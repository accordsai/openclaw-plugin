import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayCompletionProbe } from "../src/completion-probe.js";

const CONFIG = {
  gateway: {
    bind: "loopback",
    port: 18789,
    tls: { enabled: false },
    auth: { mode: "none" },
  },
} as any;

describe("createGatewayCompletionProbe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns terminal success summary when job_get reports SUCCEEDED", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.tool).toBe("vaultclaw_job_get");
      expect(body.args).toEqual({ job_id: "job_1" });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            result: {
              ok: true,
              data: {
                decision_outcome: "ALLOW",
                job: {
                  id: "job_1",
                  status: "SUCCEEDED",
                  run_id: "run_1",
                },
                executed_step_ids: ["create_draft", "send_draft"],
                last_step_id: "send_draft",
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const probe = createGatewayCompletionProbe(CONFIG);
    const result = await probe({
      sessionKey: "agent:main:main",
      signal: {
        tool: "vaultclaw_approval_wait",
        handle: { kind: "JOB", job_id: "job_1" },
      },
      timeoutMs: 2000,
    });

    expect(result).toEqual({
      terminal: true,
      terminalStatus: "SUCCEEDED",
      decisionOutcome: "ALLOW",
      runId: "run_1",
      jobId: "job_1",
      executedSteps: 2,
      lastStep: "send_draft",
    });
  });

  it("returns undefined when no job id is available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const probe = createGatewayCompletionProbe(CONFIG);
    const result = await probe({
      sessionKey: "agent:main:main",
      signal: {
        tool: "vaultclaw_approval_wait",
        handle: { kind: "PLAN_RUN" },
      },
      timeoutMs: 2000,
    });

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns non-terminal summary for running jobs", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            ok: true,
            data: {
              decision_outcome: "ALLOW",
              job: {
                id: "job_2",
                status: "RUNNING",
                run_id: "run_2",
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const probe = createGatewayCompletionProbe(CONFIG);
    const result = await probe({
      sessionKey: "agent:main:main",
      signal: {
        tool: "vaultclaw_approval_wait",
        handle: { kind: "JOB", job_id: "job_2" },
      },
      timeoutMs: 2000,
    });

    expect(result?.terminal).toBe(false);
    expect(result?.terminalStatus).toBe("RUNNING");
    expect(result?.decisionOutcome).toBe("ALLOW");
    expect(result?.runId).toBe("run_2");
    expect(result?.jobId).toBe("job_2");
  });
});
