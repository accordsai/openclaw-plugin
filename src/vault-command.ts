import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ApprovalHandoffManager } from "./approval-manager.js";
import { parseApprovalRequiredResult } from "./approval-payload.js";
import { approvalRequiredMessage } from "./messages.js";
import { parseChannelTargetFromSessionKey } from "./notifier.js";
import type { ApprovalNotifier, PluginConfig, VaultCommandMode } from "./types.js";
import type { VaultPluginCommandContext, VaultPluginCommandHandler } from "./vault-command-types.js";
import { executeResolvedVaultRoute } from "./vault-executor.js";
import { runCoreFallback } from "./vault-core-fallback.js";
import {
  autoFillStartMessage,
  autoFillSuccessMessagePrefix,
  approvalQueuedMessage,
  executionFailureMessage,
  failedAutoFillMessage,
  fallbackFailureMessage,
  fallbackQueuedMessage,
  missingInputsMessage,
  partialAutoFillMessage,
  resolverFailureMessage,
  strictRejectMessage,
  successMessage,
  vaultStatusMessage,
  vaultUsageMessage,
} from "./vault-command-messages.js";
import { logVaultMetric } from "./vault-metrics.js";
import { VaultModeStore } from "./vault-mode-store.js";
import { buildVaultRouteContext } from "./vault-route-key.js";
import { resolveAndEnrichVaultRoute, type VaultAutoFillTaskHint } from "./vault-route-orchestrator.js";

type ParsedVaultCommand =
  | { kind: "usage" }
  | { kind: "status" }
  | { kind: "on"; mode?: VaultCommandMode }
  | { kind: "off" }
  | { kind: "update_token"; token: string }
  | { kind: "update_token_usage" }
  | { kind: "request"; text: string };

const VAULT_AGENT_TOKEN_PATTERN = /^ses_[A-Za-z0-9]+$/;

function parseVaultCommandArgs(rawArgs: string | undefined): ParsedVaultCommand {
  const args = (rawArgs ?? "").trim();
  if (args.length === 0) {
    return { kind: "usage" };
  }

  const normalized = args.toLowerCase();
  if (normalized === "status") {
    return { kind: "status" };
  }
  if (normalized === "off") {
    return { kind: "off" };
  }
  if (normalized === "on") {
    return { kind: "on" };
  }
  if (normalized === "on hybrid") {
    return { kind: "on", mode: "hybrid" };
  }
  if (normalized === "on strict") {
    return { kind: "on", mode: "strict" };
  }
  if (normalized === "update token") {
    return { kind: "update_token_usage" };
  }

  const updateToken = args.match(/^update\s+token\s+(.+)$/i);
  if (updateToken?.[1]) {
    const token = stripWrappingQuotes(updateToken[1]);
    if (token.length === 0) {
      return { kind: "update_token_usage" };
    }
    return {
      kind: "update_token",
      token,
    };
  }

  return {
    kind: "request",
    text: args,
  };
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (
      (first === "\"" && last === "\"") ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`")
    ) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asRecord(parent[key]);
  if (existing) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function maskToken(token: string): string {
  if (token.length <= 10) {
    return `${token.slice(0, 3)}***`;
  }
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

async function persistVaultAgentToken(api: OpenClawPluginApi, token: string): Promise<void> {
  const runtimeConfig = api.runtime?.config;
  if (
    !runtimeConfig ||
    typeof runtimeConfig.loadConfig !== "function" ||
    typeof runtimeConfig.writeConfigFile !== "function"
  ) {
    throw new Error("runtime config writer is unavailable");
  }

  const loaded = runtimeConfig.loadConfig() as unknown;
  const next = (structuredClone(loaded) || {}) as Record<string, unknown>;

  const env = ensureRecord(next, "env");
  const vars = ensureRecord(env, "vars");
  env.VC_AGENT_TOKEN = token;
  vars.VC_AGENT_TOKEN = token;

  const skills = ensureRecord(next, "skills");
  const entries = ensureRecord(skills, "entries");
  const vaultclaw = ensureRecord(entries, "vaultclaw");
  const vaultclawEnv = ensureRecord(vaultclaw, "env");
  vaultclawEnv.VC_AGENT_TOKEN = token;

  const vaultclawGoogle = ensureRecord(entries, "vaultclaw_google");
  const vaultclawGoogleEnv = ensureRecord(vaultclawGoogle, "env");
  vaultclawGoogleEnv.VC_AGENT_TOKEN = token;

  await runtimeConfig.writeConfigFile(next as any);
}

function cleanFieldValue(value: string): string {
  return value
    .trim()
    .replace(/^['"“”`]+|['"“”`]+$/g, "")
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}

function extractExplicitSubjectHint(requestText: string): string | undefined {
  const directSubject = requestText.match(/\bsubject\s*[:=]\s*(.+)$/im);
  if (directSubject?.[1]) {
    return cleanFieldValue(directSubject[1]);
  }

  const asSubject = requestText.match(
    /\b(?:use|set)\s+(.+?)\s+as\s+(?:the\s+)?subject\b/i,
  );
  if (asSubject?.[1]) {
    return cleanFieldValue(asSubject[1]);
  }

  const subjectShouldBe = requestText.match(/\bsubject\s+(?:should|must)\s+be\s+(.+)$/im);
  if (subjectShouldBe?.[1]) {
    return cleanFieldValue(subjectShouldBe[1]);
  }

  const withSubject = requestText.match(/\bwith\s+subject\s+(.+)$/im);
  if (withSubject?.[1]) {
    return cleanFieldValue(withSubject[1]);
  }

  return undefined;
}

export function normalizeVaultRequestForResolver(requestText: string): string {
  if (/\bsubject\s*[:=]/i.test(requestText)) {
    return requestText;
  }
  const subject = extractExplicitSubjectHint(requestText);
  if (!subject) {
    return requestText;
  }
  return `${requestText}\n\nSubject: ${subject}`;
}

function chooseSessionKey(candidates: string[]): string | undefined {
  return candidates.find((candidate) => candidate.trim().length > 0);
}

function isChannelRoutableSessionKey(sessionKey: string | undefined): boolean {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return false;
  }
  return Boolean(parseChannelTargetFromSessionKey(normalized));
}

function isMainFreshSessionKey(sessionKey: string | undefined): boolean {
  const normalized = sessionKey?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /^agent:[^:]+:main-fresh-[^:]+$/.test(normalized);
}

function isWebchatSessionKey(sessionKey: string | undefined): boolean {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return false;
  }
  const channelTarget = parseChannelTargetFromSessionKey(normalized);
  return channelTarget?.channel === "webchat";
}

function chooseDeliveryTarget(params: {
  runtimeSession: {
    sessionKey?: string;
    sessionId?: string;
  };
  routeSessionKey?: string;
  executionSessionKey?: string;
  executionSessionId?: string;
}): {
  sessionKey?: string;
  sessionId?: string;
  reason: string;
} {
  if (
    isMainFreshSessionKey(params.executionSessionKey) &&
    isWebchatSessionKey(params.routeSessionKey)
  ) {
    const sessionKey = params.executionSessionKey?.trim();
    return {
      sessionKey,
      sessionId: params.executionSessionId ?? sessionKey,
      reason: "execution_main_fresh_webchat_local",
    };
  }

  if (isChannelRoutableSessionKey(params.runtimeSession.sessionKey)) {
    const sessionKey = params.runtimeSession.sessionKey?.trim();
    return {
      sessionKey,
      sessionId: params.runtimeSession.sessionId ?? sessionKey,
      reason: "runtime_session_key_channel_routable",
    };
  }

  const routeSessionKey = params.routeSessionKey?.trim();
  if (routeSessionKey) {
    return {
      sessionKey: routeSessionKey,
      sessionId: params.runtimeSession.sessionId ?? routeSessionKey,
      reason: "route_session_candidate",
    };
  }

  return {
    sessionKey: params.executionSessionKey,
    sessionId: params.executionSessionId ?? params.executionSessionKey,
    reason: "execution_session_fallback",
  };
}

function readRuntimeSessionContext(ctx: VaultPluginCommandContext): {
  sessionKey?: string;
  sessionId?: string;
} {
  const record = ctx as unknown as Record<string, unknown>;
  const sessionKey =
    typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
      ? record.sessionKey.trim()
      : undefined;
  const sessionId =
    typeof record.sessionId === "string" && record.sessionId.trim().length > 0
      ? record.sessionId.trim()
      : undefined;
  return {
    sessionKey,
    sessionId,
  };
}

function parsePeerFromAddress(value: string | undefined, channel: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  const lowerChannel = channel.trim().toLowerCase();
  const prefix = `${lowerChannel}:`;
  if (trimmed.toLowerCase().startsWith(prefix)) {
    const peer = trimmed.slice(prefix.length).trim();
    return peer.length > 0 ? peer : undefined;
  }
  const groupMatch = trimmed.match(/^(?:group|channel):(.+)$/i);
  if (groupMatch?.[1]) {
    return groupMatch[1].trim();
  }
  return trimmed;
}

function chooseProgressPeer(params: {
  ctx: VaultPluginCommandContext;
}): string | undefined {
  const to = parsePeerFromAddress(params.ctx.to, params.ctx.channel);
  const from = parsePeerFromAddress(params.ctx.from, params.ctx.channel);
  const sender = params.ctx.senderId?.trim();

  const toIsGroupOrChannel = typeof params.ctx.to === "string" && /^(group|channel):/i.test(params.ctx.to.trim());
  const fromIsGroupOrChannel = typeof params.ctx.from === "string" && /^(group|channel):/i.test(params.ctx.from.trim());

  if (toIsGroupOrChannel && to) {
    return to;
  }
  if (fromIsGroupOrChannel && from) {
    return from;
  }
  return sender || from || to || undefined;
}

function postVaultProgressUpdate(params: {
  api: OpenClawPluginApi;
  ctx: VaultPluginCommandContext;
  notifier?: ApprovalNotifier;
  sessionKey?: string;
  sessionId?: string;
  runToken: string;
  routeKey: string;
  text: string;
}): void {
  const channel = params.ctx.channel.trim().toLowerCase();
  const peerId = chooseProgressPeer({ ctx: params.ctx });

  const failoverToNotifier = () => {
    if (!params.notifier) {
      return;
    }
    params.notifier.post({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      reason: "vault-autofill-start",
      contextKey: `vault:${params.routeKey}:${params.runToken}:autofill-start`,
      text: params.text,
    });
  };

  if (!peerId) {
    failoverToNotifier();
    return;
  }

  if (channel === "telegram") {
    const send = params.api.runtime?.channel?.telegram?.sendMessageTelegram;
    if (typeof send === "function") {
      void send(peerId, params.text, {
        accountId: params.ctx.accountId,
        plainText: params.text,
      }).catch(() => failoverToNotifier());
      return;
    }
  }

  if (channel === "whatsapp") {
    const send = params.api.runtime?.channel?.whatsapp?.sendMessageWhatsApp;
    if (typeof send === "function") {
      void send(peerId, params.text, {
        accountId: params.ctx.accountId,
        verbose: false,
      }).catch(() => failoverToNotifier());
      return;
    }
  }

  if (channel === "discord") {
    const send = params.api.runtime?.channel?.discord?.sendMessageDiscord;
    if (typeof send === "function") {
      void send(peerId, params.text, {
        accountId: params.ctx.accountId,
      }).catch(() => failoverToNotifier());
      return;
    }
  }

  if (channel === "slack") {
    const send = params.api.runtime?.channel?.slack?.sendMessageSlack;
    if (typeof send === "function") {
      void send(peerId, params.text, {
        accountId: params.ctx.accountId,
      }).catch(() => failoverToNotifier());
      return;
    }
  }

  failoverToNotifier();
}

function describeAutoFillFetch(tasks: VaultAutoFillTaskHint[]): string | undefined {
  const hasWeatherRequest = tasks.some((task) => {
    const kind = task.kind?.trim().toLowerCase();
    const factKey = task.factKey.trim().toLowerCase();
    return kind === "weather_forecast" || factKey === "weather_summary";
  });

  if (hasWeatherRequest) {
    return "I am fetching weather details now.";
  }
  return "I am gathering the requested details now.";
}

function approvalResponseMessage(
  envelope: Record<string, unknown>,
  maxWaitMs: number,
): string {
  const parsed = parseApprovalRequiredResult(envelope);
  if (parsed.type !== "approval") {
    return approvalQueuedMessage();
  }
  return approvalRequiredMessage(parsed.signal, maxWaitMs);
}

export function createVaultCommandHandler(params: {
  api: OpenClawPluginApi;
  manager: ApprovalHandoffManager;
  config: PluginConfig;
  notifier?: ApprovalNotifier;
}): VaultPluginCommandHandler {
  const stateDir = params.api.runtime.state.resolveStateDir();
  const modeStore = new VaultModeStore({
    filePath: join(
      stateDir,
      "plugins",
      "vaultclaw-mcp-approval-handoff",
      "vault-mode-state.v1.json",
    ),
    defaultEnabled: params.config.vaultCommand.defaultEnabled,
    defaultMode: params.config.vaultCommand.defaultMode,
    ttlMs: params.config.vaultCommand.sessionModeTtlMs,
  });

  const activeRuns = new Set<string>();

  return async (ctx: VaultPluginCommandContext) => {
    const startedAt = Date.now();
    const parsed = parseVaultCommandArgs(ctx.args);
    const routeContext = buildVaultRouteContext(ctx);
    const runtimeSession = readRuntimeSessionContext(ctx);
    const routeSessionKey = chooseSessionKey(routeContext.sessionCandidates);
    const executionSessionKey =
      runtimeSession.sessionKey ??
      routeSessionKey ??
      (runtimeSession.sessionId?.startsWith("agent:") ? runtimeSession.sessionId : undefined);
    const executionSessionId = runtimeSession.sessionId ?? executionSessionKey ?? routeContext.key;
    const deliveryTarget = chooseDeliveryTarget({
      runtimeSession,
      routeSessionKey,
      executionSessionKey,
      executionSessionId,
    });

    logVaultMetric({
      logger: params.api.logger,
      event: "vault_cmd_received",
      routeKey: routeContext.key,
      extra: {
        channel: ctx.channel,
        has_session_key: Boolean(executionSessionKey),
        has_delivery_session_key: Boolean(deliveryTarget.sessionKey),
        command_kind: parsed.kind,
      },
    });

    if (!params.config.vaultCommand.enabled) {
      return {
        text: "Vault command path is disabled in plugin config.",
      };
    }

    await modeStore.prune();
    const currentState = await modeStore.get(routeContext.key);

    if (parsed.kind === "usage") {
      return {
        text: vaultUsageMessage({
          enabled: currentState.enabled,
          mode: currentState.mode,
        }),
      };
    }

    if (parsed.kind === "status") {
      return {
        text: vaultStatusMessage({
          enabled: currentState.enabled,
          mode: currentState.mode,
        }),
      };
    }

    if (parsed.kind === "on") {
      const nextMode = parsed.mode ?? currentState.mode ?? params.config.vaultCommand.defaultMode;
      const nextState = await modeStore.set(routeContext.key, {
        enabled: true,
        mode: nextMode,
      });
      logVaultMetric({
        logger: params.api.logger,
        event: "vault_mode_changed",
        routeKey: routeContext.key,
        extra: {
          enabled: nextState.enabled,
          mode: nextState.mode,
        },
      });
      return {
        text: vaultStatusMessage({
          enabled: nextState.enabled,
          mode: nextState.mode,
        }),
      };
    }

    if (parsed.kind === "off") {
      const nextState = await modeStore.set(routeContext.key, {
        enabled: false,
        mode: currentState.mode,
      });
      logVaultMetric({
        logger: params.api.logger,
        event: "vault_mode_changed",
        routeKey: routeContext.key,
        extra: {
          enabled: nextState.enabled,
          mode: nextState.mode,
        },
      });
      return {
        text: vaultStatusMessage({
          enabled: nextState.enabled,
          mode: nextState.mode,
        }),
      };
    }

    if (parsed.kind === "update_token_usage") {
      return {
        text: "Usage: /vault update token <ses_...>",
      };
    }

    if (parsed.kind === "update_token") {
      if (!VAULT_AGENT_TOKEN_PATTERN.test(parsed.token)) {
        return {
          text: "Vault token format looks invalid. Expected a token that starts with `ses_`.",
        };
      }

      try {
        await persistVaultAgentToken(params.api, parsed.token);
      } catch (error) {
        logVaultMetric({
          logger: params.api.logger,
          event: "vault_token_update_failed",
          routeKey: routeContext.key,
        });
        return {
          text: `Failed to save Vaultclaw token: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      logVaultMetric({
        logger: params.api.logger,
        event: "vault_token_updated",
        routeKey: routeContext.key,
      });
      return {
        text: `Vaultclaw token saved (${maskToken(parsed.token)}). Restart the OpenClaw gateway to apply it immediately.`,
      };
    }

    const runToken = randomUUID();
    if (activeRuns.size >= params.config.vaultCommand.maxConcurrentRuns) {
      return {
        text: "Vault command concurrency limit reached. Try again in a moment.",
      };
    }

    activeRuns.add(runToken);
    try {
      const runHybridFallback = async (reason: string): Promise<{ text: string }> => {
        if (typeof params.api.runtime.system.runCommandWithTimeout !== "function") {
          return {
            text: fallbackFailureMessage("runCommandWithTimeout is unavailable"),
          };
        }

        logVaultMetric({
          logger: params.api.logger,
          event: "vault_core_fallback_started",
          routeKey: routeContext.key,
          extra: {
            reason,
          },
        });
        const fallback = await runCoreFallback({
          runCommandWithTimeout: params.api.runtime.system.runCommandWithTimeout,
          ctx,
          message: parsed.text,
          timeoutMs: params.config.vaultCommand.coreFallbackTimeoutMs,
          sessionKey: executionSessionKey,
        });
        logVaultMetric({
          logger: params.api.logger,
          event: "vault_core_fallback_finished",
          routeKey: routeContext.key,
          extra: {
            ok: fallback.ok,
            reason,
          },
        });

        return {
          text: fallback.ok ? fallbackQueuedMessage() : fallbackFailureMessage(fallback.message),
        };
      };

      if (!currentState.enabled) {
        if (!params.config.vaultCommand.enableCoreFallback) {
          return {
            text: "Vault command mode is OFF. Use `/vault on` or run request without `/vault`.",
          };
        }

        return await runHybridFallback("mode_off");
      }

      let autoFillStartPosted = false;
      const resolverRequestText = normalizeVaultRequestForResolver(parsed.text);
      const resolved = await resolveAndEnrichVaultRoute({
        config: params.api.config,
        resolverTool: params.config.vaultCommand.resolverTool,
        requestText: resolverRequestText,
        resolverTimeoutMs: params.config.vaultCommand.resolverTimeoutMs,
        sessionKey: executionSessionKey,
        enrichmentGlobalTimeoutMs: params.config.vaultCommand.enrichmentGlobalTimeoutMs,
        enrichmentTaskTimeoutMs: params.config.vaultCommand.enrichmentTaskTimeoutMs,
        onAutoFillStart: ({ tasks }) => {
          if (autoFillStartPosted) {
            return;
          }
          autoFillStartPosted = true;
          postVaultProgressUpdate({
            api: params.api,
            ctx,
            notifier: params.notifier,
            sessionKey: deliveryTarget.sessionKey,
            sessionId: deliveryTarget.sessionId,
            runToken,
            routeKey: routeContext.key,
            text: autoFillStartMessage({
              fetchHint: describeAutoFillFetch(tasks),
            }),
          });
        },
      });

      if (resolved.failure) {
        return {
          text: resolverFailureMessage(resolved.failure.message),
        };
      }

      const payload = resolved.payload;
      if (!payload) {
        return {
          text: resolverFailureMessage("empty resolver payload"),
        };
      }

      logVaultMetric({
        logger: params.api.logger,
        event: "vault_route_resolved",
        routeKey: routeContext.key,
        extra: {
          status: payload.status,
          confidence: payload.confidence,
          domain: payload.domain,
          source: payload.route?.source,
          retry_status: resolved.telemetry.retryStatus,
          enrichment_used_guidance: resolved.telemetry.usedGuidance,
          enrichment_auto_retry_attempted: resolved.telemetry.autoRetryAttempted,
        },
      });

      if (resolved.telemetry.usedGuidance) {
        logVaultMetric({
          logger: params.api.logger,
          event: "vault_missing_input_enrichment",
          routeKey: routeContext.key,
          extra: {
            guidance_count: resolved.telemetry.guidanceCount,
            fact_tasks_started: resolved.telemetry.factTasksStarted,
            fact_tasks_completed: resolved.telemetry.factTasksCompleted,
            fact_tasks_failed: resolved.telemetry.factTasksFailed,
            fact_tasks_timed_out: resolved.telemetry.factTasksTimedOut,
            retry_status: resolved.telemetry.retryStatus,
            elapsed_ms: resolved.telemetry.elapsedMs,
            fallback_to_user_reason: resolved.telemetry.fallbackToUserReason,
          },
        });
      }

      if (payload.status === "RESOLVED_MISSING_INPUTS") {
        if (resolved.telemetry.autoRetryAttempted) {
          if (params.config.vaultCommand.enableCoreFallback) {
            return await runHybridFallback(
              resolved.telemetry.factTasksCompleted > 0
                ? "auto_enrich_retry_still_missing_inputs"
                : "auto_enrich_retry_missing_inputs_no_facts_completed",
            );
          }
          if (resolved.telemetry.factTasksCompleted > 0) {
            return {
              text: partialAutoFillMessage(payload.missing_inputs ?? []),
            };
          }
          return {
            text: failedAutoFillMessage(payload.missing_inputs ?? []),
          };
        }

        if (resolved.telemetry.usedGuidance) {
          return {
            text: missingInputsMessage(payload.missing_inputs ?? []),
          };
        }

        return {
          text: missingInputsMessage(payload.missing_inputs ?? []),
        };
      }

      if (payload.status === "NOT_VAULT_ELIGIBLE" || payload.status === "AMBIGUOUS") {
        if (currentState.mode === "strict") {
          return {
            text: strictRejectMessage(payload.fallback_hint),
          };
        }

        if (!params.config.vaultCommand.enableCoreFallback) {
          return {
            text: strictRejectMessage(payload.fallback_hint),
          };
        }

        return await runHybridFallback("not_vault_eligible_or_ambiguous");
      }

      logVaultMetric({
        logger: params.api.logger,
        event: "vault_exec_started",
        routeKey: routeContext.key,
      });
      const autoFillSucceeded = resolved.telemetry.autoRetryAttempted;
      const withAutoFillPrefix = (message: string): string =>
        autoFillSucceeded ? `${autoFillSuccessMessagePrefix()} ${message}` : message;

      const executed = await executeResolvedVaultRoute({
        config: params.api.config,
        payload,
        sessionKey: executionSessionKey,
        timeoutMs: params.config.commandTimeoutMs,
      });

      logVaultMetric({
        logger: params.api.logger,
        event: "vault_exec_finished",
        routeKey: routeContext.key,
        extra: {
          outcome: executed.kind,
        },
      });

      if (executed.kind === "approval_required") {
        logVaultMetric({
          logger: params.api.logger,
          event: "vault_approval_detected",
          routeKey: routeContext.key,
        });
        params.manager.onAfterToolCall(
          {
            toolName: executed.toolName,
            result: executed.envelope,
          },
          {
            sessionKey: executionSessionKey,
            sessionId: executionSessionId,
            deliverySessionKey: deliveryTarget.sessionKey,
            deliverySessionId: deliveryTarget.sessionId,
            deliveryTargetReason: deliveryTarget.reason,
            skipInitialRequiredNotification: true,
          },
        );
        return {
          text: withAutoFillPrefix(
            approvalResponseMessage(executed.envelope, params.config.maxWaitMs),
          ),
        };
      }

      if (executed.kind === "missing_inputs") {
        return {
          text: withAutoFillPrefix(missingInputsMessage(executed.missingInputs)),
        };
      }

      if (executed.kind === "error") {
        return {
          text: withAutoFillPrefix(executionFailureMessage(executed.message)),
        };
      }

      return {
        text: withAutoFillPrefix(successMessage(executed.summary)),
      };
    } finally {
      activeRuns.delete(runToken);
      logVaultMetric({
        logger: params.api.logger,
        event: "vault_cmd_terminal",
        routeKey: routeContext.key,
        level: "debug",
        extra: {
          t_total_terminal_ms: Date.now() - startedAt,
        },
      });
    }
  };
}

export { parseVaultCommandArgs };
