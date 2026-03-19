import { describe, expect, it, vi } from "vitest";
import { createGatewayAgentResumeInvoker } from "../src/resume-invoker.js";

function extractGatewayParams(argv: string[]): Record<string, unknown> {
  const idx = argv.indexOf("--params");
  if (idx < 0) {
    throw new Error("missing --params");
  }
  const raw = argv[idx + 1];
  if (!raw) {
    throw new Error("missing --params payload");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid --params payload");
  }
  return parsed as Record<string, unknown>;
}

describe("createGatewayAgentResumeInvoker", () => {
  it("calls gateway agent method for session resume", async () => {
    const runCommandWithTimeout = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true, result: { runId: "run_1" } }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));

    const invoker = createGatewayAgentResumeInvoker({ runCommandWithTimeout });
    await invoker({
      sessionKey: "agent:main:main",
      signal: {
        tool: "vaultclaw_approval_wait",
        handle: { kind: "JOB" },
        challengeId: "ach_1",
        pendingId: "apj_1",
        jobId: "job_1",
      },
    });

    expect(runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const firstCall = runCommandWithTimeout.mock.calls[0] as unknown[] | undefined;
    const argv = Array.isArray(firstCall?.[0]) ? (firstCall?.[0] as string[]) : [];
    expect(argv.slice(0, 4)).toEqual(["openclaw", "gateway", "call", "agent"]);
    expect(argv).toContain("--params");
    const body = extractGatewayParams(argv);
    expect(body.deliver).toBe(false);
  });

  it("sets deliver=true for channel sessions", async () => {
    const runCommandWithTimeout = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true, result: { runId: "run_2" } }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));

    const invoker = createGatewayAgentResumeInvoker({ runCommandWithTimeout });
    await invoker({
      sessionKey: "agent:main:telegram:direct:509928323",
      signal: {
        tool: "vaultclaw_approval_wait",
        handle: { kind: "JOB" },
        challengeId: "ach_2",
        pendingId: "apj_2",
        jobId: "job_2",
      },
    });

    const firstCall = runCommandWithTimeout.mock.calls[0] as unknown[] | undefined;
    const argv = Array.isArray(firstCall?.[0]) ? (firstCall?.[0] as string[]) : [];
    const body = extractGatewayParams(argv);
    expect(body.deliver).toBe(true);
  });

  it("throws when gateway call returns ok=false", async () => {
    const runCommandWithTimeout = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: false, error: { message: "boom" } }),
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));
    const invoker = createGatewayAgentResumeInvoker({ runCommandWithTimeout });

    await expect(() =>
      invoker({
        sessionKey: "agent:main:main",
        signal: {
          tool: "vaultclaw_approval_wait",
          handle: { kind: "JOB" },
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("throws when session key is missing", async () => {
    const runCommandWithTimeout = vi.fn();
    const invoker = createGatewayAgentResumeInvoker({ runCommandWithTimeout });

    await expect(() =>
      invoker({
        signal: {
          tool: "vaultclaw_approval_wait",
          handle: { kind: "JOB" },
        },
      }),
    ).rejects.toThrow("cannot auto-resume without sessionKey");
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
