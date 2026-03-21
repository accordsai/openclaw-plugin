import { randomUUID } from "node:crypto";
import type { VaultPluginCommandContext } from "./vault-command-types.js";

type RunCommandWithTimeout = (
  argv: string[],
  optionsOrTimeout:
    | number
    | {
      timeoutMs: number;
      maxBuffer?: number;
      cwd?: string;
      input?: string;
      env?: NodeJS.ProcessEnv;
      windowsVerbatimArguments?: boolean;
      noOutputTimeoutMs?: number;
    },
) => Promise<{
  pid?: number;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
  noOutputTimedOut?: boolean;
}>;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function isAgentSessionAddress(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().startsWith("agent:");
}

export async function runCoreFallback(params: {
  runCommandWithTimeout: RunCommandWithTimeout;
  ctx: VaultPluginCommandContext;
  message: string;
  timeoutMs: number;
  sessionKey?: string;
}): Promise<{ ok: boolean; message: string }> {
  const body: Record<string, unknown> = {
    message: params.message,
    idempotencyKey: `vault-fallback:${randomUUID()}`,
    deliver: true,
  };

  if (isAgentSessionAddress(params.sessionKey)) {
    body.sessionKey = params.sessionKey?.trim();
  } else if (isAgentSessionAddress(params.ctx.from)) {
    body.sessionKey = params.ctx.from?.trim();
  } else if (isAgentSessionAddress(params.ctx.to)) {
    body.sessionKey = params.ctx.to?.trim();
  } else {
    if (params.ctx.channel) {
      body.channel = params.ctx.channel;
    }
    if (params.ctx.to) {
      body.to = params.ctx.to;
    }
    if (params.ctx.accountId) {
      body.accountId = params.ctx.accountId;
    }
    if (typeof params.ctx.messageThreadId === "number") {
      body.threadId = String(params.ctx.messageThreadId);
    }
  }

  const result = await params.runCommandWithTimeout(
    [
      "openclaw",
      "gateway",
      "call",
      "agent",
      "--json",
      "--timeout",
      String(Math.max(1000, Math.trunc(params.timeoutMs))),
      "--params",
      JSON.stringify(body),
    ],
    {
      timeoutMs: params.timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  );

  if (result.code !== 0) {
    return {
      ok: false,
      message: readString(result.stderr) ?? readString(result.stdout) ?? "gateway call failed",
    };
  }

  const parsed = parseJsonObject(result.stdout);
  if (!parsed) {
    return {
      ok: true,
      message: "Fallback routed to standard OpenClaw flow.",
    };
  }
  if (parsed.ok === false) {
    const errorObj = parsed.error && typeof parsed.error === "object"
      ? (parsed.error as Record<string, unknown>)
      : undefined;
    return {
      ok: false,
      message: readString(errorObj?.message) ?? "gateway call returned ok=false",
    };
  }
  return {
    ok: true,
    message: "Fallback routed to standard OpenClaw flow.",
  };
}
