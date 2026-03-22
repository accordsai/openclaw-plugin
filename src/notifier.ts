import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ApprovalNotifier } from "./types.js";

type ChannelTarget = {
  channel: string;
  accountId?: string;
  chatType: "direct" | "group" | "channel" | "dm";
  peerId: string;
};

const CHAT_TYPES = new Set(["direct", "group", "channel", "dm"]);

export function createApprovalNotifier(api: Pick<OpenClawPluginApi, "runtime" | "logger">): ApprovalNotifier {
  return {
    post: ({ sessionKey, sessionId, text, reason, contextKey }) => {
      const scopedSessionId = sessionId?.trim();
      const scopedSessionKey =
        sessionKey?.trim() ||
        (scopedSessionId?.startsWith("agent:") ? scopedSessionId : undefined);
      if (!scopedSessionKey && !scopedSessionId) {
        api.logger.warn(
          `[vaultclaw-approval-handoff] skipped notification with no sessionKey/sessionId: ${text}`,
        );
        return;
      }

      const fallback = createFallbackNotifier({
        api,
        sessionKey: scopedSessionKey,
        sessionId: scopedSessionId,
        text,
        reason,
        contextKey,
      });

      if (!scopedSessionKey) {
        fallback();
        return;
      }

      const target = parseChannelTargetFromSessionKey(scopedSessionKey);
      if (!target) {
        if (isMainFreshAgentSessionKey(scopedSessionKey)) {
          const handled = tryChatInject({
            api,
            sessionKey: scopedSessionKey,
            text,
            fallback,
            targetLabel: "main-fresh",
          });
          if (handled) {
            return;
          }
        }
        fallback();
        return;
      }
      const handled = tryDirectChannelSend({
        api,
        target,
        sessionKey: scopedSessionKey,
        text,
        fallback,
      });
      if (!handled) {
        fallback();
      }
    },
  };
}

function tryDirectChannelSend(params: {
  api: Pick<OpenClawPluginApi, "runtime" | "logger">;
  target: ChannelTarget;
  sessionKey: string;
  text: string;
  fallback: () => void;
}): boolean {
  const { api, target, sessionKey, text, fallback } = params;
  const warnAndFallback = (phase: "failed" | "threw", error: unknown) => {
    api.logger.warn(
      `[vaultclaw-approval-handoff] direct ${target.channel} send ${phase}, falling back to system event: ${String(error)}`,
    );
    fallback();
  };

  if (target.channel === "telegram") {
    const send = api.runtime?.channel?.telegram?.sendMessageTelegram;
    if (typeof send !== "function") {
      return false;
    }
    try {
      void send(target.peerId, text, {
        accountId: target.accountId,
        plainText: text,
      }).catch((error: unknown) => warnAndFallback("failed", error));
      return true;
    } catch (error) {
      warnAndFallback("threw", error);
      return true;
    }
  }

  if (target.channel === "whatsapp") {
    const send = api.runtime?.channel?.whatsapp?.sendMessageWhatsApp;
    if (typeof send !== "function") {
      return false;
    }
    try {
      void send(target.peerId, text, {
        accountId: target.accountId,
        verbose: false,
      }).catch((error: unknown) => warnAndFallback("failed", error));
      return true;
    } catch (error) {
      warnAndFallback("threw", error);
      return true;
    }
  }

  if (target.channel === "discord") {
    const send = api.runtime?.channel?.discord?.sendMessageDiscord;
    if (typeof send !== "function") {
      return false;
    }
    try {
      void send(target.peerId, text, {
        accountId: target.accountId,
      }).catch((error: unknown) => warnAndFallback("failed", error));
      return true;
    } catch (error) {
      warnAndFallback("threw", error);
      return true;
    }
  }

  if (target.channel === "slack") {
    const send = api.runtime?.channel?.slack?.sendMessageSlack;
    if (typeof send !== "function") {
      return false;
    }
    try {
      void send(target.peerId, text, {
        accountId: target.accountId,
      }).catch((error: unknown) => warnAndFallback("failed", error));
      return true;
    } catch (error) {
      warnAndFallback("threw", error);
      return true;
    }
  }

  if (target.channel === "webchat") {
    return tryChatInject({
      api,
      sessionKey,
      text,
      fallback,
      targetLabel: "webchat",
    });
  }

  return false;
}

function isMainFreshAgentSessionKey(sessionKey: string): boolean {
  return /^agent:[^:]+:main-fresh-[^:]+$/i.test(sessionKey.trim());
}

function createFallbackNotifier(params: {
  api: Pick<OpenClawPluginApi, "runtime" | "logger">;
  sessionKey?: string;
  sessionId?: string;
  text: string;
  reason: string;
  contextKey?: string;
}) {
  let used = false;
  const sessionCandidates = Array.from(
    new Set([params.sessionKey?.trim(), params.sessionId?.trim()].filter((value): value is string => Boolean(value))),
  );
  return () => {
    if (used) {
      return;
    }
    used = true;
    if (sessionCandidates.length === 0) {
      params.api.logger.warn(
        `[vaultclaw-approval-handoff] failed to enqueue system event with no session candidates`,
      );
      return;
    }

    for (const sessionKey of sessionCandidates) {
      try {
        const enqueued = params.api.runtime.system.enqueueSystemEvent(params.text, {
          sessionKey,
          contextKey: params.contextKey,
        });
        if (!enqueued) {
          continue;
        }
        const requestHeartbeatNow = params.api.runtime?.system?.requestHeartbeatNow;
        if (typeof requestHeartbeatNow === "function") {
          requestHeartbeatNow({
            reason: `vaultclaw-approval-handoff:${params.reason}`,
            sessionKey,
          });
        }
        return;
      } catch (error) {
        params.api.logger.warn(
          `[vaultclaw-approval-handoff] failed to enqueue system event for session candidate ${sessionKey}: ${String(error)}`,
        );
      }
    }
    params.api.logger.warn(
      `[vaultclaw-approval-handoff] failed to enqueue system event for all session candidates`,
    );
  };
}

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
    // Continue scanning lines.
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

function tryChatInject(params: {
  api: Pick<OpenClawPluginApi, "runtime" | "logger">;
  sessionKey: string;
  text: string;
  fallback: () => void;
  targetLabel: string;
}): boolean {
  const run = params.api.runtime?.system?.runCommandWithTimeout;
  if (typeof run !== "function") {
    return false;
  }

  const payload = JSON.stringify({
    sessionKey: params.sessionKey,
    message: params.text,
    label: "Vault",
  });

  try {
    void run(
      [
        "openclaw",
        "gateway",
        "call",
        "chat.inject",
        "--json",
        "--timeout",
        "10000",
        "--params",
        payload,
      ],
      {
        timeoutMs: 12000,
        maxBuffer: 512 * 1024,
      },
    ).then((result) => {
      if (result.code !== 0) {
        throw new Error(
          `chat.inject failed (code=${String(result.code)}): ${readString(result.stderr) ?? readString(result.stdout) ?? "unknown error"}`,
        );
      }
      const parsed = parseJsonObject(result.stdout);
      if (parsed?.ok === false) {
        const errorObj =
          parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
            ? (parsed.error as Record<string, unknown>)
            : undefined;
        throw new Error(readString(errorObj?.message) ?? "chat.inject returned ok=false");
      }
    }).catch((error: unknown) => {
      params.api.logger.warn(
        `[vaultclaw-approval-handoff] ${params.targetLabel} chat.inject failed, falling back to system event: ${String(error)}`,
      );
      params.fallback();
    });
    return true;
  } catch (error) {
    params.api.logger.warn(
      `[vaultclaw-approval-handoff] ${params.targetLabel} chat.inject threw, falling back to system event: ${String(error)}`,
    );
    params.fallback();
    return true;
  }
}

export function parseChannelTargetFromSessionKey(sessionKey: string): ChannelTarget | undefined {
  const trimmed = stripSessionThreadSuffix(sessionKey.trim());
  if (!trimmed) {
    return undefined;
  }

  const parts = trimmed.split(":").filter((part) => part.length > 0);
  if (parts.length < 5) {
    return undefined;
  }
  if (parts[0]?.toLowerCase() !== "agent") {
    return undefined;
  }

  const rest = parts.slice(2);
  if (rest.length < 3) {
    return undefined;
  }

  const lower = rest.map((segment) => segment.toLowerCase());

  if (rest.length >= 4 && CHAT_TYPES.has(lower[2] ?? "")) {
    const peerId = rest.slice(3).join(":").trim();
    if (!peerId) {
      return undefined;
    }
    return {
      channel: (lower[0] ?? "").trim(),
      accountId: rest[1]?.trim() || undefined,
      chatType: lower[2] as ChannelTarget["chatType"],
      peerId,
    };
  }

  if (CHAT_TYPES.has(lower[1] ?? "")) {
    const peerId = rest.slice(2).join(":").trim();
    if (!peerId) {
      return undefined;
    }
    return {
      channel: (lower[0] ?? "").trim(),
      chatType: lower[1] as ChannelTarget["chatType"],
      peerId,
    };
  }

  return undefined;
}

function stripSessionThreadSuffix(sessionKey: string): string {
  const normalized = sessionKey.toLowerCase();
  const threadIndex = normalized.lastIndexOf(":thread:");
  const topicIndex = normalized.lastIndexOf(":topic:");
  const suffixIndex = Math.max(threadIndex, topicIndex);
  if (suffixIndex <= 0) {
    return sessionKey;
  }
  return sessionKey.slice(0, suffixIndex);
}
