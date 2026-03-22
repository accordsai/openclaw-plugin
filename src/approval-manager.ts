import { retryWithBackoff } from "./backoff.js";
import { parseApprovalRequiredResult } from "./approval-payload.js";
import { buildApprovalWorkerKey } from "./dedupe.js";
import { logStructured } from "./logging.js";
import {
  approvalAllowMessage,
  approvalCompletedMessage,
  approvalDenyMessage,
  approvalResumeFailedMessage,
  approvalRequiredMessage,
  approvalTimeoutMessage,
  approvalUnknownTerminalMessage,
  approvalWaitErrorMessage,
  invalidApprovalPayloadMessage,
} from "./messages.js";
import type {
  ApprovalHandoffConfig,
  ApprovalNotifier,
  ResumeInvoker,
  ApprovalSignal,
  CorrelationKeys,
  StructuredLogger,
  WaitCallError,
  WaitInvoker,
  WaitSuccess,
  CompletionProbe,
} from "./types.js";

type ToolEvent = {
  toolName: string;
  result?: unknown;
  runId?: string;
};

type ToolContext = {
  sessionId?: string;
  sessionKey?: string;
  deliverySessionId?: string;
  deliverySessionKey?: string;
  deliveryTargetReason?: string;
  runId?: string;
  skipInitialRequiredNotification?: boolean;
};

type SessionContext = {
  sessionId?: string;
  sessionKey?: string;
};

type WorkerState = {
  key: string;
  signal: ApprovalSignal;
  executionSessionId?: string;
  executionSessionKey?: string;
  deliverySessionId?: string;
  deliverySessionKey?: string;
  controller: AbortController;
  terminalSent: boolean;
};

const CHANNEL_SESSION_KINDS = new Set([
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "webchat",
  "signal",
  "imessage",
  "googlechat",
  "irc",
  "line",
  "msteams",
]);

type SessionTarget = {
  sessionId?: string;
  sessionKey?: string;
};

function normalizeSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSessionKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function deriveSessionKeyFromSessionId(sessionId: string | undefined): string | undefined {
  const normalized = normalizeSessionId(sessionId);
  return normalized?.startsWith("agent:") ? normalized : undefined;
}

function resolveExecutionTarget(ctx: ToolContext): SessionTarget {
  const sessionKey = normalizeSessionKey(ctx.sessionKey) ?? deriveSessionKeyFromSessionId(ctx.sessionId);
  const sessionId = normalizeSessionId(ctx.sessionId) ?? sessionKey;
  return {
    sessionKey,
    sessionId,
  };
}

function resolveDeliveryTarget(ctx: ToolContext, execution: SessionTarget): SessionTarget {
  const sessionKey =
    normalizeSessionKey(ctx.deliverySessionKey) ??
    normalizeSessionKey(execution.sessionKey) ??
    deriveSessionKeyFromSessionId(ctx.deliverySessionId);
  const sessionId =
    normalizeSessionId(ctx.deliverySessionId) ??
    normalizeSessionId(execution.sessionId) ??
    sessionKey;
  return {
    sessionKey,
    sessionId,
  };
}

function classifyDeliveryTarget(target: SessionTarget): string {
  const key = target.sessionKey;
  if (!key) {
    return target.sessionId ? "session-id-only" : "unknown";
  }
  const parts = key.split(":");
  if (parts.length < 3 || parts[0]?.toLowerCase() !== "agent") {
    return "non-agent-session";
  }
  const kind = parts[2]?.toLowerCase() ?? "";
  if (kind === "main") {
    return "local-main";
  }
  if (kind.startsWith("main-fresh-")) {
    return "ephemeral-main-fresh";
  }
  if (CHANNEL_SESSION_KINDS.has(kind)) {
    return `channel:${kind}`;
  }
  return `agent:${kind || "unknown"}`;
}

function hasActionableInvalidIdentifiers(parsed: {
  runId?: string;
  jobId?: string;
}): boolean {
  return Boolean(parsed.runId || parsed.jobId);
}

export class ApprovalHandoffManager {
  private readonly config: ApprovalHandoffConfig;
  private readonly waitInvoker: WaitInvoker;
  private readonly resumeInvoker?: ResumeInvoker;
  private readonly completionProbe?: CompletionProbe;
  private readonly notifier: ApprovalNotifier;
  private readonly logger: StructuredLogger;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly workers = new Map<string, WorkerState>();
  private readonly pendingRuns = new Set<Promise<void>>();

  constructor(params: {
    config: ApprovalHandoffConfig;
    waitInvoker: WaitInvoker;
    resumeInvoker?: ResumeInvoker;
    completionProbe?: CompletionProbe;
    notifier: ApprovalNotifier;
    logger: StructuredLogger;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.config = params.config;
    this.waitInvoker = params.waitInvoker;
    this.resumeInvoker = params.resumeInvoker;
    this.completionProbe = params.completionProbe;
    this.notifier = params.notifier;
    this.logger = params.logger;
    this.sleep =
      params.sleep ??
      (async (ms: number) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      });
  }

  onAfterToolCall(event: ToolEvent, ctx: ToolContext) {
    if (!this.config.enabled) {
      return;
    }

    const executionTarget = resolveExecutionTarget(ctx);
    const deliveryTarget = resolveDeliveryTarget(ctx, executionTarget);
    const executionCorrelationId = executionTarget.sessionId ?? executionTarget.sessionKey;

    const parsed = parseApprovalRequiredResult(event.result);
    if (parsed.type === "not_approval") {
      return;
    }

    if (parsed.type === "invalid") {
      const correlation: CorrelationKeys = {
        session_id: executionCorrelationId,
        challenge_id: parsed.challengeId,
        pending_id: parsed.pendingId,
        run_id: parsed.runId,
        job_id: parsed.jobId,
      };
      logStructured({
        logger: this.logger,
        level: "warn",
        event: "approval_detected_invalid",
        correlation,
        extra: { reason: parsed.message },
      });
      if (!hasActionableInvalidIdentifiers(parsed)) {
        logStructured({
          logger: this.logger,
          level: "debug",
          event: "approval_detected_invalid_suppressed",
          correlation,
          extra: {
            reason: parsed.message,
            suppression_reason: "missing_actionable_run_or_job_identifier",
          },
        });
        return;
      }
      this.notifier.post({
        sessionKey: deliveryTarget.sessionKey,
        sessionId: deliveryTarget.sessionId,
        reason: "approval-invalid",
        text: invalidApprovalPayloadMessage({
          reason: parsed.message,
          challengeId: parsed.challengeId,
          pendingId: parsed.pendingId,
          runId: parsed.runId,
          jobId: parsed.jobId,
        }),
      });
      return;
    }

    const signal = parsed.signal;
    const workerKey = buildApprovalWorkerKey({
      sessionId: executionCorrelationId,
      challengeId: signal.challengeId,
      pendingId: signal.pendingId,
      runId: signal.runId,
      jobId: signal.jobId,
    });

    const correlation = this.correlation(signal, executionCorrelationId);
    const sameTarget =
      executionTarget.sessionKey === deliveryTarget.sessionKey &&
      executionTarget.sessionId === deliveryTarget.sessionId;
    logStructured({
      logger: this.logger,
      level: "info",
      event: "approval_delivery_target_selected",
      correlation,
      extra: {
        execution_session_key: executionTarget.sessionKey,
        execution_session_id: executionTarget.sessionId,
        delivery_session_key: deliveryTarget.sessionKey,
        delivery_session_id: deliveryTarget.sessionId,
        delivery_target_kind: classifyDeliveryTarget(deliveryTarget),
        selection_reason: ctx.deliveryTargetReason ?? "unspecified",
        same_target: sameTarget,
      },
    });
    logStructured({
      logger: this.logger,
      level: "info",
      event: "approval_detected",
      correlation,
      extra: {
        tool_name: event.toolName,
        wait_tool: signal.tool,
      },
    });

    if (this.workers.has(workerKey)) {
      logStructured({
        logger: this.logger,
        level: "debug",
        event: "wait_deduplicated",
        correlation,
      });
      return;
    }

    if (this.workers.size >= this.config.maxConcurrentWaits) {
      this.notifier.post({
        sessionKey: deliveryTarget.sessionKey,
        sessionId: deliveryTarget.sessionId,
        reason: "approval-over-capacity",
        text: "Approval auto-wait capacity reached. Try again after existing waits complete.",
      });
      logStructured({
        logger: this.logger,
        level: "warn",
        event: "wait_rejected_capacity",
        correlation,
        extra: {
          max_concurrent_waits: this.config.maxConcurrentWaits,
        },
      });
      return;
    }

    if (!ctx.skipInitialRequiredNotification) {
      this.notifier.post({
        sessionKey: deliveryTarget.sessionKey,
        sessionId: deliveryTarget.sessionId,
        reason: "approval-required",
        contextKey: `approval:${workerKey}`,
        text: approvalRequiredMessage(signal, this.config.maxWaitMs),
      });
    }

    const state: WorkerState = {
      key: workerKey,
      signal,
      executionSessionId: executionTarget.sessionId,
      executionSessionKey: executionTarget.sessionKey,
      deliverySessionId: deliveryTarget.sessionId,
      deliverySessionKey: deliveryTarget.sessionKey,
      controller: new AbortController(),
      terminalSent: false,
    };
    this.workers.set(workerKey, state);

    const pending = this.runWaitWorker(state)
      .catch((error) => {
        logStructured({
          logger: this.logger,
          level: "error",
          event: "wait_worker_uncaught",
          correlation,
          extra: {
            error: String(error),
          },
        });
      })
      .finally(() => {
        this.pendingRuns.delete(pending);
      });

    this.pendingRuns.add(pending);
  }

  onBeforeReset(_event: unknown, ctx: SessionContext) {
    this.cancelSessionWorkers(ctx, "before_reset");
  }

  onSessionEnd(_event: unknown, ctx: SessionContext) {
    this.cancelSessionWorkers(ctx, "session_end");
  }

  activeWorkerCount() {
    return this.workers.size;
  }

  async waitForIdle() {
    await Promise.allSettled(Array.from(this.pendingRuns));
  }

  private cancelSessionWorkers(ctx: SessionContext, reason: string) {
    const sessionId = ctx.sessionId?.trim();
    const sessionKey = ctx.sessionKey?.trim();
    if (!sessionId && !sessionKey) {
      return;
    }

    for (const state of Array.from(this.workers.values())) {
      const isSessionMatch =
        (sessionId &&
          (state.executionSessionId === sessionId || state.deliverySessionId === sessionId)) ||
        (sessionKey &&
          (state.executionSessionKey === sessionKey || state.deliverySessionKey === sessionKey));
      if (!isSessionMatch) {
        continue;
      }
      state.controller.abort();
      this.workers.delete(state.key);
      logStructured({
        logger: this.logger,
        level: "info",
        event: "cleanup",
        correlation: this.correlation(
          state.signal,
          state.executionSessionId ?? state.executionSessionKey ?? sessionId ?? sessionKey,
        ),
        extra: {
          reason,
        },
      });
    }
  }

  private async runWaitWorker(state: WorkerState) {
    const correlation = this.correlation(
      state.signal,
      state.executionSessionId ?? state.executionSessionKey,
    );

    logStructured({
      logger: this.logger,
      level: "info",
      event: "wait_started",
      correlation,
      extra: {
        poll_interval_ms: this.config.pollIntervalMs,
        max_wait_ms: this.config.maxWaitMs,
        command_timeout_ms: this.config.commandTimeoutMs,
      },
    });

    try {
      const waitResult = await retryWithBackoff({
        run: async () =>
          await this.waitInvoker({
            sessionKey: state.executionSessionKey,
            handle: state.signal.handle,
            pollIntervalMs: this.config.pollIntervalMs,
            maxWaitMs: this.config.maxWaitMs,
            commandTimeoutMs: this.config.commandTimeoutMs,
            allowMcporterFallback: this.config.allowMcporterFallback,
            reconcile: {
              onValidationError: this.config.reconcileOnValidationError,
              onUnknownTerminal: this.config.reconcileOnUnknownTerminal,
              onWaitError: this.config.reconcileOnWaitError,
              timeoutMs: this.config.reconcileTimeoutMs,
            },
            signal: state.controller.signal,
          }),
        shouldRetry: (error) => this.shouldRetry(error, state.controller.signal),
        sleep: this.sleep,
        onRetry: (error, nextAttempt, delayMs) => {
          logStructured({
            logger: this.logger,
            level: "warn",
            event: "wait_retry",
            correlation,
            extra: {
              next_attempt: nextAttempt,
              delay_ms: delayMs,
              error: String(error),
            },
          });
        },
      });

      if (state.controller.signal.aborted) {
        logStructured({
          logger: this.logger,
          level: "info",
          event: "wait_canceled",
          correlation,
          extra: {
            phase: "after_wait",
          },
        });
        return;
      }

      logStructured({
        logger: this.logger,
        level: "info",
        event: "wait_completed",
        correlation,
        extra: {
          done: waitResult.done,
          terminal_status: waitResult.terminalStatus,
          decision_outcome: waitResult.decisionOutcome,
          terminal_source: asRecord(waitResult.raw)?.source,
          reconciled: asRecord(waitResult.raw)?.reconciled,
        },
      });

      await this.handleTerminalSuccess(state, waitResult);
    } catch (error) {
      if (state.controller.signal.aborted) {
        logStructured({
          logger: this.logger,
          level: "info",
          event: "wait_canceled",
          correlation,
          extra: {
            phase: "after_error",
            error: String(error),
          },
        });
        return;
      }
      logStructured({
        logger: this.logger,
        level: "info",
        event: "wait_failed",
        correlation,
        extra: {
          error: String(error),
        },
      });
      await this.handleTerminalError(state, error);
    } finally {
      this.workers.delete(state.key);
      logStructured({
        logger: this.logger,
        level: "info",
        event: "cleanup",
        correlation,
      });
    }
  }

  private shouldRetry(error: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) {
      return false;
    }
    if (!error || typeof error !== "object") {
      return true;
    }
    if ((error as { name?: string }).name !== "WaitCallError") {
      return true;
    }
    const waitError = error as WaitCallError;
    return waitError.retryable;
  }

  private async handleTerminalSuccess(state: WorkerState, wait: WaitSuccess) {
    const decision = (wait.decisionOutcome ?? "").toUpperCase();
    const correlation = this.correlation(
      state.signal,
      state.executionSessionId ?? state.executionSessionKey,
    );

    if (decision === "ALLOW") {
      this.emitTerminalMessage(state, {
        reason: "approval-allow",
        text: approvalAllowMessage(state.signal, wait),
      });
      logStructured({
        logger: this.logger,
        level: "info",
        event: "terminal_outcome",
        correlation,
        extra: {
          outcome: "ALLOW",
          terminal_status: wait.terminalStatus,
          terminal_source: asRecord(wait.raw)?.source,
          reconciled: asRecord(wait.raw)?.reconciled,
          resume_attempted: true,
        },
      });
      await this.triggerAutoResume(state, wait);
      return;
    }

    if (decision === "DENY") {
      this.emitTerminalMessage(state, {
        reason: "approval-deny",
        text: approvalDenyMessage(state.signal),
      });
      logStructured({
        logger: this.logger,
        level: "info",
        event: "terminal_outcome",
        correlation,
        extra: {
          outcome: "DENY",
          terminal_status: wait.terminalStatus,
          terminal_source: asRecord(wait.raw)?.source,
          reconciled: asRecord(wait.raw)?.reconciled,
          resume_attempted: false,
        },
      });
      return;
    }

    this.emitTerminalMessage(state, {
      reason: "approval-unknown",
      text: approvalUnknownTerminalMessage(state.signal, wait),
    });
    logStructured({
      logger: this.logger,
      level: "warn",
      event: "terminal_outcome",
      correlation,
      extra: {
        outcome: decision || "UNKNOWN",
        terminal_status: wait.terminalStatus,
        terminal_source: asRecord(wait.raw)?.source,
        reconciled: asRecord(wait.raw)?.reconciled,
        resume_attempted: false,
      },
    });
  }

  private async handleTerminalError(state: WorkerState, error: unknown) {
    const correlation = this.correlation(
      state.signal,
      state.executionSessionId ?? state.executionSessionKey,
    );
    const waitError =
      error && typeof error === "object" && (error as { name?: string }).name === "WaitCallError"
        ? (error as WaitCallError)
        : undefined;

    if (waitError?.code === "ABORTED") {
      logStructured({
        logger: this.logger,
        level: "info",
        event: "terminal_outcome",
        correlation,
        extra: {
          outcome: "ABORTED",
          code: waitError.code,
          resume_attempted: false,
        },
      });
      return;
    }

    if (waitError?.code === "MCP_WAIT_TIMEOUT" || waitError?.category === "timeout") {
      this.emitTerminalMessage(state, {
        reason: "approval-timeout",
        text: approvalTimeoutMessage(state.signal, this.config.maxWaitMs),
      });
      logStructured({
        logger: this.logger,
        level: "warn",
        event: "terminal_outcome",
        correlation,
        extra: {
          outcome: "TIMEOUT",
          code: waitError?.code,
          resume_attempted: false,
        },
      });
      return;
    }

    const reason = waitError ? waitError.message : String(error);
    this.emitTerminalMessage(state, {
      reason: "approval-error",
      text: approvalWaitErrorMessage(state.signal, reason),
    });
    logStructured({
      logger: this.logger,
      level: "warn",
      event: "terminal_outcome",
      correlation,
      extra: {
        outcome: "ERROR",
        code: waitError?.code,
        category: waitError?.category,
        error: reason,
        resume_attempted: false,
      },
    });
  }

  private emitTerminalMessage(
    state: WorkerState,
    params: {
      reason: string;
      text: string;
    },
  ) {
    if (state.terminalSent) {
      return;
    }
    state.terminalSent = true;
    this.notifier.post({
      sessionKey: state.deliverySessionKey,
      sessionId: state.deliverySessionId,
      reason: params.reason,
      contextKey: `approval:${state.key}`,
      text: params.text,
    });
  }

  private async triggerAutoResume(state: WorkerState, wait: WaitSuccess) {
    const correlation = this.correlation(
      state.signal,
      state.executionSessionId ?? state.executionSessionKey,
    );
    const completionProbeTimeoutMs = Math.max(1000, Math.min(this.config.reconcileTimeoutMs, 3000));

    if (this.completionProbe) {
      try {
        const completion = await this.completionProbe({
          sessionKey: state.executionSessionKey,
          signal: state.signal,
          timeoutMs: completionProbeTimeoutMs,
        });
        if (
          completion?.terminal === true &&
          completion.terminalStatus === "SUCCEEDED" &&
          (completion.decisionOutcome === "ALLOW" || completion.decisionOutcome === undefined)
        ) {
          this.notifier.post({
            sessionKey: state.deliverySessionKey,
            sessionId: state.deliverySessionId,
            reason: "approval-complete",
            contextKey: `approval:${state.key}:complete`,
            text: approvalCompletedMessage(state.signal, completion),
          });
          logStructured({
            logger: this.logger,
            level: "info",
            event: "completion_probe_succeeded",
            correlation,
            extra: {
              terminal_status: completion.terminalStatus,
              decision_outcome: completion.decisionOutcome,
              run_id: completion.runId,
              job_id: completion.jobId,
              executed_steps: completion.executedSteps,
              last_step: completion.lastStep,
              resume_attempted: false,
              wait_terminal_status: wait.terminalStatus,
            },
          });
          return;
        }
        logStructured({
          logger: this.logger,
          level: "debug",
          event: "completion_probe_inconclusive",
          correlation,
          extra: {
            terminal: completion?.terminal,
            terminal_status: completion?.terminalStatus,
            decision_outcome: completion?.decisionOutcome,
            resume_attempted: true,
            wait_terminal_status: wait.terminalStatus,
          },
        });
      } catch (error) {
        logStructured({
          logger: this.logger,
          level: "debug",
          event: "completion_probe_failed",
          correlation,
          extra: {
            error: String(error),
            resume_attempted: true,
            wait_terminal_status: wait.terminalStatus,
          },
        });
      }
    }

    if (!this.resumeInvoker) {
      return;
    }
    logStructured({
      logger: this.logger,
      level: "info",
      event: "resume_started",
      correlation,
      extra: {
        resume_attempted: true,
      },
    });

    try {
      await this.resumeInvoker({
        sessionKey: state.executionSessionKey,
        signal: state.signal,
      });
      logStructured({
        logger: this.logger,
        level: "info",
        event: "resume_completed",
        correlation,
        extra: {
          resume_attempted: true,
        },
      });
    } catch (error) {
      const reason = String(error);
      this.notifier.post({
        sessionKey: state.deliverySessionKey,
        sessionId: state.deliverySessionId,
        reason: "approval-resume-failed",
        contextKey: `approval:${state.key}:resume`,
        text: approvalResumeFailedMessage(state.signal, reason),
      });
      logStructured({
        logger: this.logger,
        level: "warn",
        event: "resume_failed",
        correlation,
        extra: {
          error: reason,
          resume_attempted: true,
        },
      });
    }
  }

  private correlation(signal: ApprovalSignal, sessionId: string | undefined): CorrelationKeys {
    return {
      session_id: sessionId,
      challenge_id: signal.challengeId,
      pending_id: signal.pendingId,
      run_id: signal.runId,
      job_id: signal.jobId,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
