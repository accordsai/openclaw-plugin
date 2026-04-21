import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ApprovalHandoffManager } from "./src/approval-manager.js";
import { createGatewayCompletionProbe } from "./src/completion-probe.js";
import { normalizePluginConfig } from "./src/config.js";
import { createApprovalNotifier } from "./src/notifier.js";
import { createGatewayAgentResumeInvoker } from "./src/resume-invoker.js";
import { extractToolResultToolName, resolveSessionContext } from "./src/session-context.js";
import { maybeDisableTelegramNativeCommands } from "./src/telegram-native-commands-guard.js";
import { createVaultCommandHandler } from "./src/vault-command.js";
import type { VaultPluginCommandContext } from "./src/vault-command-types.js";
import { createGatewayToolsInvokeWaitInvoker } from "./src/wait-invoker.js";

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseVaultArgsFromText(text: string | undefined): string | undefined {
  const trimmed = readNonEmptyString(text);
  if (!trimmed) {
    return undefined;
  }

  const parseLine = (line: string): string | undefined => {
    const normalized = line.replace(/^user\s*:\s*/i, "").trim();
    const lineMatch = normalized.match(/^\/?vault(?:\s+([\s\S]*))?$/i);
    if (!lineMatch) {
      return undefined;
    }
    return lineMatch[1]?.trim() ?? "";
  };

  const directMatch = parseLine(trimmed);
  if (directMatch !== undefined) {
    return directMatch;
  }

  const lines = trimmed.split(/\r?\n/);
  let matchedArgs: string | undefined;
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed !== undefined) {
      matchedArgs = parsed;
    }
  }
  return matchedArgs;
}

function parseVaultDispatchArgs(event: unknown): string | undefined {
  const record = event as Record<string, unknown> | undefined;
  return (
    parseVaultArgsFromText(readNonEmptyString(record?.body)) ??
    parseVaultArgsFromText(readNonEmptyString(record?.content))
  );
}

function buildCommandContext(params: {
  api: OpenClawPluginApi;
  args: string;
  channel: string;
  channelId?: string;
  senderId?: string;
  accountId?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionFile?: string;
  gatewayClientScopes?: string[];
  from?: string;
  to?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
  isAuthorizedSender?: boolean;
}): VaultPluginCommandContext {
  return {
    senderId: params.senderId,
    channel: params.channel,
    channelId: params.channelId as any,
    isAuthorizedSender: params.isAuthorizedSender ?? true,
    gatewayClientScopes: params.gatewayClientScopes,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    args: params.args,
    commandBody: params.args.length > 0 ? `vault ${params.args}` : "vault",
    config: params.api.config,
    from: params.from,
    to: params.to,
    accountId: params.accountId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    requestConversationBinding: async () => ({ created: false } as any),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

const plugin = {
  id: "vaultclaw-mcp-approval-handoff",
  name: "Vaultclaw MCP Approval Handoff",
  description: "Automatically waits MCP approval challenges and posts terminal outcomes.",
  configSchema: {
    parse(value: unknown) {
      return normalizePluginConfig(value);
    },
    uiHints: {
      enabled: {
        label: "Enable Auto Approval Wait",
      },
      pollIntervalMs: {
        label: "Poll Interval (ms)",
      },
      maxWaitMs: {
        label: "Max Wait (ms)",
      },
      commandTimeoutMs: {
        label: "Command Timeout (ms)",
      },
      maxConcurrentWaits: {
        label: "Max Concurrent Waits",
      },
      allowMcporterFallback: {
        label: "Allow MCporter Fallback",
      },
      reconcileOnValidationError: {
        label: "Reconcile on Validation Error",
      },
      reconcileOnUnknownTerminal: {
        label: "Reconcile on Unknown Terminal",
      },
      reconcileOnWaitError: {
        label: "Reconcile on Wait Error",
      },
      reconcileTimeoutMs: {
        label: "Reconcile Timeout (ms)",
      },
      "vaultCommand.enabled": {
        label: "Enable /vault Command",
      },
      "vaultCommand.defaultEnabled": {
        label: "Default Session State",
      },
      "vaultCommand.defaultMode": {
        label: "Default /vault Mode",
      },
      "vaultCommand.autoDisableTelegramNativeCommands": {
        label: "Auto-disable Telegram Native Commands",
      },
      "vaultCommand.sessionModeTtlMs": {
        label: "Session Mode TTL (ms)",
      },
      "vaultCommand.maxConcurrentRuns": {
        label: "Max Concurrent /vault Runs",
      },
      "vaultCommand.enableCoreFallback": {
        label: "Enable HYBRID Core Fallback",
      },
      "vaultCommand.coreFallbackTimeoutMs": {
        label: "Core Fallback Timeout (ms)",
      },
      "vaultCommand.resolverTool": {
        label: "Resolver Tool",
      },
      "vaultCommand.resolverTimeoutMs": {
        label: "Resolver Timeout (ms)",
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const config = normalizePluginConfig(api.pluginConfig);
    const waitInvoker = createGatewayToolsInvokeWaitInvoker(api.config);
    const completionProbe = createGatewayCompletionProbe(api.config);
    const resumeInvoker = typeof api.runtime?.system?.runCommandWithTimeout === "function"
      ? createGatewayAgentResumeInvoker({
        runCommandWithTimeout: api.runtime.system.runCommandWithTimeout,
      })
      : undefined;
    const notifier = createApprovalNotifier(api);

    const manager = new ApprovalHandoffManager({
      config,
      waitInvoker,
      resumeInvoker,
      completionProbe,
      logger: api.logger,
      notifier,
    });

    const vaultCommandHandler = createVaultCommandHandler({
      api,
      manager,
      config,
      notifier,
    });

    api.registerCommand({
      name: "vault",
      description: "Deterministic Vaultclaw route + execute path.",
      acceptsArgs: true,
      requireAuth: false,
      handler: vaultCommandHandler,
    });

    api.on("before_dispatch", async (event: any, ctx: any) => {
      const args = parseVaultDispatchArgs(event);
      if (args === undefined) {
        return;
      }

      const channel = readNonEmptyString(event?.channel) ?? readNonEmptyString(ctx?.channelId) ?? "main";
      const commandCtx = buildCommandContext({
        api,
        args,
        channel,
        channelId: readNonEmptyString(ctx?.channelId),
        senderId: readNonEmptyString(ctx?.senderId) ?? readNonEmptyString(event?.senderId),
        accountId: readNonEmptyString(ctx?.accountId) ?? readNonEmptyString(event?.accountId),
        sessionKey: readNonEmptyString(ctx?.sessionKey),
        sessionId: readNonEmptyString(ctx?.sessionId),
        sessionFile: readNonEmptyString(ctx?.sessionFile),
        gatewayClientScopes: Array.isArray(ctx?.gatewayClientScopes)
          ? ctx.gatewayClientScopes.filter((entry: unknown): entry is string => typeof entry === "string")
          : undefined,
        from: readNonEmptyString(event?.from),
        to: readNonEmptyString(event?.to),
        messageThreadId:
          typeof event?.threadId === "string" || typeof event?.threadId === "number"
            ? event.threadId
            : undefined,
        threadParentId: readNonEmptyString(event?.parentConversationId),
        isAuthorizedSender:
          typeof event?.commandAuthorized === "boolean" ? event.commandAuthorized : true,
      });

      const result = await vaultCommandHandler(commandCtx);
      const text = readNonEmptyString((result as Record<string, unknown> | undefined)?.text);
      return text ? { handled: true, text } : { handled: true };
    });

    // HTTP /v1/chat* ingress (Controlplane path) lands in before_agent_reply with cleanedBody.
    // Keep /vault interception here so command handling remains deterministic even when
    // before_dispatch does not run for this transport path.
    api.on("before_agent_reply", async (event: any, ctx: any) => {
      const args = parseVaultArgsFromText(readNonEmptyString(event?.cleanedBody));
      if (args === undefined) {
        return;
      }

      const channel = readNonEmptyString(ctx?.channelId) ?? readNonEmptyString(ctx?.messageProvider) ?? "main";
      const commandCtx = buildCommandContext({
        api,
        args,
        channel,
        channelId: readNonEmptyString(ctx?.channelId),
        senderId: readNonEmptyString(ctx?.senderId),
        accountId: readNonEmptyString(ctx?.accountId),
        sessionKey: readNonEmptyString(ctx?.sessionKey),
        sessionId: readNonEmptyString(ctx?.sessionId),
        sessionFile: readNonEmptyString(ctx?.sessionFile),
        gatewayClientScopes: Array.isArray(ctx?.gatewayClientScopes)
          ? ctx.gatewayClientScopes.filter((entry: unknown): entry is string => typeof entry === "string")
          : undefined,
        isAuthorizedSender: true,
      });

      const result = await vaultCommandHandler(commandCtx);
      const text = readNonEmptyString((result as Record<string, unknown> | undefined)?.text);
      return {
        handled: true,
        reply: text ? { text } : { text: "Vault command processed." },
      };
    });

    api.on("after_tool_call", (event: any, ctx: any) => {
      const session = resolveSessionContext(ctx);
      if (!session.sessionKey && !session.sessionId) {
        api.logger.debug?.(
          "[vaultclaw-approval-handoff] skipped after_tool_call; no sessionKey/sessionId in hook context",
        );
        return;
      }
      manager.onAfterToolCall(
        {
          toolName: event.toolName,
          result: event.result,
          runId: event.runId,
        },
        {
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          runId: ctx.runId,
        },
      );
    });

    api.on("tool_result_persist", (event: any, ctx: any) => {
      const session = resolveSessionContext(ctx);
      if (!session.sessionKey && !session.sessionId) {
        return;
      }
      const fallbackToolName =
        typeof ctx?.toolName === "string" && ctx.toolName.trim().length > 0 ? ctx.toolName.trim() : "tool";
      manager.onAfterToolCall(
        {
          toolName: extractToolResultToolName({
            event,
            message: event?.message,
            fallback: fallbackToolName,
          }),
          result: event?.message,
        },
        {
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
        },
      );
    });

    api.on("before_reset", (event: any, ctx: any) => {
      const session = resolveSessionContext(ctx);
      manager.onBeforeReset(event, {
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
      });
    });

    api.on("session_end", (event: any, ctx: any) => {
      const session = resolveSessionContext(ctx);
      manager.onSessionEnd(event, {
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
      });
    });

    // OpenClaw plugin loading is synchronous; never block command registration on async config writes.
    void maybeDisableTelegramNativeCommands({ api, config });
  },
};

export default plugin;
