import { randomUUID } from "node:crypto";
import type { ApprovalSignal, ResumeInvoker } from "./types.js";

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
    // Try parsing a JSON object from the last output line.
  }

  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || !line.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore and continue scanning
    }
  }

  return undefined;
}

function idSuffix(signal: ApprovalSignal): string {
  return (
    signal.challengeId ??
    signal.pendingId ??
    signal.runId ??
    signal.jobId ??
    randomUUID()
  );
}

function formatIds(signal: ApprovalSignal): string {
  const parts: string[] = [];
  if (signal.challengeId) {
    parts.push(`challenge_id=${signal.challengeId}`);
  }
  if (signal.pendingId) {
    parts.push(`pending_id=${signal.pendingId}`);
  }
  if (signal.runId) {
    parts.push(`run_id=${signal.runId}`);
  }
  if (signal.jobId) {
    parts.push(`job_id=${signal.jobId}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function buildAutoResumeMessage(signal: ApprovalSignal): string {
  return `System: Vaultclaw approval resolved ALLOW.${formatIds(signal)} Continue the in-progress request now without asking the user to type approved.`;
}

const CHANNEL_SESSION_KINDS = new Set([
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "signal",
  "imessage",
  "googlechat",
  "irc",
  "line",
  "msteams",
]);

function shouldDeliverAutoResume(sessionKey: string): boolean {
  const parts = sessionKey.split(":");
  if (parts.length < 3) {
    return false;
  }
  const kind = readString(parts[2])?.toLowerCase();
  if (!kind) {
    return false;
  }
  return CHANNEL_SESSION_KINDS.has(kind);
}

export function createGatewayAgentResumeInvoker(params: {
  runCommandWithTimeout: RunCommandWithTimeout;
  commandTimeoutMs?: number;
}): ResumeInvoker {
  const timeoutMs = params.commandTimeoutMs ?? 30000;
  return async ({ sessionKey, signal }) => {
    const scopedSessionKey = sessionKey?.trim();
    if (!scopedSessionKey) {
      throw new Error("cannot auto-resume without sessionKey");
    }

    const body = {
      sessionKey: scopedSessionKey,
      message: buildAutoResumeMessage(signal),
      // Channel sessions need explicit delivery for follow-up messages to reach chat surfaces.
      deliver: shouldDeliverAutoResume(scopedSessionKey),
      idempotencyKey: `vaultclaw-approval-resume:${idSuffix(signal)}:${Date.now()}`,
    };

    const result = await params.runCommandWithTimeout(
      [
        "openclaw",
        "gateway",
        "call",
        "agent",
        "--json",
        "--timeout",
        "20000",
        "--params",
        JSON.stringify(body),
      ],
      {
        timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );

    if (result.code !== 0) {
      throw new Error(
        `auto-resume command failed (code=${String(result.code)}): ${readString(result.stderr) ?? readString(result.stdout) ?? "unknown error"}`,
      );
    }

    const parsed = parseJsonObject(result.stdout);
    if (!parsed) {
      return;
    }

    if (parsed.ok === false) {
      const errorObj =
        parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
          ? (parsed.error as Record<string, unknown>)
          : undefined;
      const message = readString(errorObj?.message) ?? "gateway call returned ok=false";
      throw new Error(message);
    }
  };
}
