import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ApprovalHandoffManager } from "./src/approval-manager.js";
import { createGatewayCompletionProbe } from "./src/completion-probe.js";
import { normalizePluginConfig } from "./src/config.js";
import { createApprovalNotifier } from "./src/notifier.js";
import { createGatewayAgentResumeInvoker } from "./src/resume-invoker.js";
import { extractToolResultToolName, resolveSessionContext } from "./src/session-context.js";
import { maybeDisableTelegramNativeCommands } from "./src/telegram-native-commands-guard.js";
import { createVaultCommandHandler } from "./src/vault-command.js";
import { createGatewayToolsInvokeWaitInvoker } from "./src/wait-invoker.js";

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

    api.registerCommand({
      name: "vault",
      description: "Deterministic Vaultclaw route + execute path.",
      acceptsArgs: true,
      requireAuth: false,
      handler: createVaultCommandHandler({
        api,
        manager,
        config,
        notifier,
      }),
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
