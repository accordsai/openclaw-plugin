import { describe, expect, it, vi } from "vitest";
import { runCoreFallback } from "../src/vault-core-fallback.js";

function readAgentCallBody(argv: string[]): Record<string, unknown> {
  const paramsFlagIndex = argv.indexOf("--params");
  if (paramsFlagIndex < 0 || paramsFlagIndex + 1 >= argv.length) {
    throw new Error("missing --params payload");
  }
  return JSON.parse(argv[paramsFlagIndex + 1] ?? "{}") as Record<string, unknown>;
}

describe("runCoreFallback", () => {
  it("prefers explicit sessionKey for fallback agent calls", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      stdout: "{\"ok\":true}",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const result = await runCoreFallback({
      runCommandWithTimeout,
      sessionKey: "agent:main:telegram:direct:509928323",
      ctx: {
        channel: "telegram",
        to: "509928323",
        from: "509928323",
      } as any,
      message: "send an email",
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(true);
    const callArgs = runCommandWithTimeout.mock.calls[0]?.[0] as string[];
    const body = readAgentCallBody(callArgs);
    expect(body.sessionKey).toBe("agent:main:telegram:direct:509928323");
    expect(body.channel).toBeUndefined();
    expect(body.to).toBeUndefined();
  });

  it("uses agent session from context when explicit sessionKey is unavailable", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      stdout: "{\"ok\":true}",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await runCoreFallback({
      runCommandWithTimeout,
      ctx: {
        channel: "telegram",
        from: "agent:main:telegram:direct:509928323",
      } as any,
      message: "send an email",
      timeoutMs: 30_000,
    });

    const callArgs = runCommandWithTimeout.mock.calls[0]?.[0] as string[];
    const body = readAgentCallBody(callArgs);
    expect(body.sessionKey).toBe("agent:main:telegram:direct:509928323");
    expect(body.channel).toBeUndefined();
  });

  it("falls back to channel routing when no agent session is available", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      stdout: "{\"ok\":true}",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await runCoreFallback({
      runCommandWithTimeout,
      ctx: {
        channel: "telegram",
        to: "509928323",
        accountId: "default",
      } as any,
      message: "send an email",
      timeoutMs: 30_000,
    });

    const callArgs = runCommandWithTimeout.mock.calls[0]?.[0] as string[];
    const body = readAgentCallBody(callArgs);
    expect(body.sessionKey).toBeUndefined();
    expect(body.channel).toBe("telegram");
    expect(body.to).toBe("509928323");
    expect(body.accountId).toBe("default");
  });
});
