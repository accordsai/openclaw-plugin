import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ApprovalHandoffManager } from "./src/approval-manager.js";
import { normalizePluginConfig } from "./src/config.js";
import { createApprovalNotifier } from "./src/notifier.js";
import { createGatewayAgentResumeInvoker } from "./src/resume-invoker.js";
import { extractToolResultToolName, resolveSessionContext } from "./src/session-context.js";
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
      reconcileOnValidationError: {
        label: "Reconcile on Validation Error",
      },
      reconcileOnUnknownTerminal: {
        label: "Reconcile on Unknown Terminal",
      },
      reconcileTimeoutMs: {
        label: "Reconcile Timeout (ms)",
      },
    },
  },
  register(api: OpenClawPluginApi) {
    const config = normalizePluginConfig(api.pluginConfig);
    const waitInvoker = createGatewayToolsInvokeWaitInvoker(api.config);
    const resumeInvoker = typeof api.runtime?.system?.runCommandWithTimeout === "function"
      ? createGatewayAgentResumeInvoker({
        runCommandWithTimeout: api.runtime.system.runCommandWithTimeout,
      })
      : undefined;

    const manager = new ApprovalHandoffManager({
      config,
      waitInvoker,
      resumeInvoker,
      logger: api.logger,
      notifier: createApprovalNotifier(api),
    });

    api.on("after_tool_call", (event: any, ctx: any) => {
      const session = resolveSessionContext(ctx);
      if (!session.sessionKey) {
        api.logger.debug?.(
          "[vaultclaw-approval-handoff] skipped after_tool_call; no sessionKey in hook context",
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
          runId: ctx.runId,
        },
      );
    });

    api.on("tool_result_persist", (event: any, ctx: any) => {
      const session = resolveSessionContext(ctx);
      if (!session.sessionKey) {
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
  },
};

export default plugin;
