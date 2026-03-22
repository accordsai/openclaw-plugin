import { describe, expect, it, vi } from "vitest";
import { ApprovalHandoffManager } from "../src/approval-manager.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { WaitSuccess } from "../src/types.js";
import { WaitCallError } from "../src/types.js";

function approvalRequiredResult() {
  return {
    ok: false,
    error: {
      code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: "ach_1",
            pending_id: "apj_1",
            run_id: "run_1",
            job_id: "job_1",
            remote_attestation_url: "https://alerts.accords.ai/a/req_1?t=abc",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                kind: "PLAN_RUN",
                run_id: "run_1",
                job_id: "job_1",
                challenge_id: "ach_1",
                pending_id: "apj_1",
              },
            },
          },
        },
      },
    },
  };
}

function createHarness(
  waitImpl: Parameters<typeof vi.fn>[0],
  resumeImpl?: Parameters<typeof vi.fn>[0],
  completionProbeImpl?: Parameters<typeof vi.fn>[0],
) {
  const notifications: Array<{ text: string; reason: string; sessionKey?: string; sessionId?: string }> = [];
  const waitInvoker = vi.fn(waitImpl);
  const resumeInvoker = vi.fn(
    resumeImpl ??
      (async () => {
        // no-op
      }),
  );
  const completionProbe = vi.fn(
    completionProbeImpl ??
      (async () => undefined),
  );
  const manager = new ApprovalHandoffManager({
    config: { ...DEFAULT_CONFIG },
    waitInvoker,
    resumeInvoker,
    completionProbe,
    notifier: {
      post: (entry) => {
        notifications.push({
          text: entry.text,
          reason: entry.reason,
          sessionKey: entry.sessionKey,
          sessionId: entry.sessionId,
        });
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    sleep: async () => {},
  });

  return { manager, waitInvoker, resumeInvoker, completionProbe, notifications };
}

describe("ApprovalHandoffManager integration", () => {
  it("posts approval-required handoff before wait starts", async () => {
    let notificationsAtWaitStart = 0;
    const { manager, notifications } = createHarness(async () => {
      notificationsAtWaitStart = notifications.length;
      return {
        done: true,
        terminalStatus: "DENIED",
        decisionOutcome: "DENY",
        raw: {},
      };
    });

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-order",
      },
    );

    await manager.waitForIdle();
    expect(notificationsAtWaitStart).toBe(1);
    expect(notifications[0]?.reason).toBe("approval-required");
  });

  it("can skip initial approval-required notification while still emitting terminal outcome", async () => {
    const { manager, notifications, resumeInvoker } = createHarness(async () => ({
      done: true,
      terminalStatus: "SUCCEEDED",
      decisionOutcome: "ALLOW",
      raw: {},
    }));

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-skip-required",
        skipInitialRequiredNotification: true,
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual(["approval-allow"]);
    expect(notifications[0]?.text).toContain("Approval allowed");
    expect(resumeInvoker).toHaveBeenCalledTimes(1);
  });

  it("handles APPROVAL_REQUIRED -> ALLOW", async () => {
    const { manager, notifications, resumeInvoker } = createHarness(async () => ({
      done: true,
      terminalStatus: "SUCCEEDED",
      decisionOutcome: "ALLOW",
      raw: {},
    }));

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-1",
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-allow",
    ]);
    expect(notifications[0]?.text).toContain("https://alerts.accords.ai/a/req_1?t=abc");
    expect(notifications[1]?.text).toContain("Approval allowed");
    expect(resumeInvoker).toHaveBeenCalledTimes(1);
  });

  it("posts fast completion callback and skips resume when completion probe confirms success", async () => {
    const executionSessionKey = "agent:main:main-fresh-1774145368";
    const deliverySessionKey = "agent:main:main";
    const { manager, notifications, resumeInvoker, completionProbe } = createHarness(
      async () => ({
        done: true,
        terminalStatus: "SUCCEEDED",
        decisionOutcome: "ALLOW",
        raw: {},
      }),
      undefined,
      async () => ({
        terminal: true,
        terminalStatus: "SUCCEEDED",
        decisionOutcome: "ALLOW",
        runId: "run_fast",
        jobId: "job_fast",
        executedSteps: 2,
        lastStep: "send_draft",
      }),
    );

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: executionSessionKey,
        sessionId: executionSessionKey,
        deliverySessionKey,
        deliverySessionId: deliverySessionKey,
        deliveryTargetReason: "route_session_candidate",
      },
    );

    await manager.waitForIdle();
    expect(completionProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: executionSessionKey,
      }),
    );
    expect(completionProbe).toHaveBeenCalledTimes(1);
    expect(resumeInvoker).toHaveBeenCalledTimes(0);
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-allow",
      "approval-complete",
    ]);
    for (const entry of notifications) {
      expect(entry.sessionKey).toBe(deliverySessionKey);
      expect(entry.sessionId).toBe(deliverySessionKey);
    }
    expect(notifications[2]?.text).toContain("Done");
    expect(notifications[2]?.text).toContain("executed_steps=2");
    expect(notifications[2]?.text).toContain("last_step=send_draft");
  });

  it("falls back to resume when completion probe is inconclusive", async () => {
    const executionSessionKey = "agent:main:main-fresh-1774145368";
    const deliverySessionKey = "agent:main:main";
    const { manager, notifications, waitInvoker, resumeInvoker, completionProbe } = createHarness(
      async () => ({
        done: true,
        terminalStatus: "SUCCEEDED",
        decisionOutcome: "ALLOW",
        raw: {},
      }),
      undefined,
      async () => ({
        terminal: false,
        terminalStatus: "RUNNING",
        decisionOutcome: "ALLOW",
      }),
    );

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: executionSessionKey,
        sessionId: executionSessionKey,
        deliverySessionKey,
        deliverySessionId: deliverySessionKey,
        deliveryTargetReason: "route_session_candidate",
      },
    );

    await manager.waitForIdle();
    expect(waitInvoker).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: executionSessionKey,
      }),
    );
    expect(completionProbe).toHaveBeenCalledTimes(1);
    expect(completionProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: executionSessionKey,
      }),
    );
    expect(resumeInvoker).toHaveBeenCalledTimes(1);
    expect(resumeInvoker).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: executionSessionKey,
      }),
    );
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-allow",
    ]);
    for (const entry of notifications) {
      expect(entry.sessionKey).toBe(deliverySessionKey);
      expect(entry.sessionId).toBe(deliverySessionKey);
    }
  });

  it("emits explicit handoff for direct/TUI session with only sessionId", async () => {
    const { manager, notifications } = createHarness(async () => ({
      done: true,
      terminalStatus: "DENIED",
      decisionOutcome: "DENY",
      raw: {},
    }));

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionId: "0d2f0d3b-66cc-42a2-83fe-d6d39ad631f8",
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-deny",
    ]);
    expect(notifications[0]?.sessionKey).toBeUndefined();
    expect(notifications[0]?.sessionId).toBe("0d2f0d3b-66cc-42a2-83fe-d6d39ad631f8");
    expect(notifications[0]?.text).toContain("Approval required in Vaultclaw UI. Waiting up to");
    expect(notifications[0]?.text).toContain("challenge_id=ach_1");
    expect(notifications[0]?.text).toContain("pending_id=apj_1");
    expect(notifications[0]?.text).toContain("run_id=run_1");
    expect(notifications[0]?.text).toContain("job_id=job_1");
    expect(notifications[0]?.text).toContain("Attestation link:");
  });

  it("handles APPROVAL_REQUIRED -> DENY", async () => {
    const { manager, notifications, resumeInvoker } = createHarness(async () => ({
      done: true,
      terminalStatus: "DENIED",
      decisionOutcome: "DENY",
      raw: {},
    }));

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-2",
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-deny",
    ]);
    expect(notifications[1]?.text).toContain("Denied by attestation");
    expect(resumeInvoker).toHaveBeenCalledTimes(0);
  });

  it("handles APPROVAL_REQUIRED -> TIMEOUT", async () => {
    const { manager, notifications, resumeInvoker } = createHarness(async () => {
      throw new WaitCallError({
        message: "timed out while waiting for approval resolution",
        code: "MCP_WAIT_TIMEOUT",
        retryable: false,
        category: "timeout",
      });
    });

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-3",
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-timeout",
    ]);
    expect(notifications[1]?.text).toContain("Retry with same handle");
    expect(resumeInvoker).toHaveBeenCalledTimes(0);
  });

  it("handles APPROVAL_REQUIRED -> UNKNOWN terminal without timeout message", async () => {
    const { manager, notifications, resumeInvoker } = createHarness(async () => ({
      done: true,
      terminalStatus: "FAILED",
      decisionOutcome: "UNKNOWN",
      raw: { source: "wait_primary", reconciled: false },
    }));

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-3b",
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-unknown",
    ]);
    expect(notifications[1]?.text).toContain("unknown outcome");
    expect(notifications[1]?.text).not.toContain("timed out");
    expect(resumeInvoker).toHaveBeenCalledTimes(0);
  });

  it("posts monitoring-failed guidance when wait errors", async () => {
    const { manager, notifications, resumeInvoker } = createHarness(async () => {
      throw new WaitCallError({
        message: "transport failure",
        code: "TRANSPORT_ERROR",
        retryable: true,
        category: "transport",
      });
    });

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-3c",
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-error",
    ]);
    expect(notifications[1]?.text).toContain("monitoring failed");
    expect(notifications[1]?.text).toContain("may still complete");
    expect(resumeInvoker).toHaveBeenCalledTimes(0);
  });

  it("posts resume failure guidance after ALLOW when auto-resume fails", async () => {
    const { manager, notifications, resumeInvoker } = createHarness(
      async () => ({
        done: true,
        terminalStatus: "SUCCEEDED",
        decisionOutcome: "ALLOW",
        raw: { source: "reconcile_pending_get", reconciled: true },
      }),
      async () => {
        throw new Error("gateway call failed");
      },
    );

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-3c",
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual([
      "approval-required",
      "approval-allow",
      "approval-resume-failed",
    ]);
    expect(notifications[2]?.text).toContain("Reply approved or rerun the request");
    expect(resumeInvoker).toHaveBeenCalledTimes(1);
  });

  it("deduplicates duplicate approval events without repeating handoff message", async () => {
    let resolveWait: ((result: WaitSuccess) => void) | undefined;

    const { manager, waitInvoker, notifications } = createHarness(
      async ({ signal }) =>
        await new Promise<WaitSuccess>((resolve, reject) => {
          resolveWait = resolve;
          signal?.addEventListener("abort", () => {
            reject(
              new WaitCallError({
                message: "approval wait canceled",
                code: "ABORTED",
                retryable: false,
                category: "unknown",
              }),
            );
          });
        }),
    );

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-4",
      },
    );

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-4",
      },
    );

    expect(waitInvoker).toHaveBeenCalledTimes(1);
    expect(notifications.filter((entry) => entry.reason === "approval-required")).toHaveLength(1);
    resolveWait?.({
      done: true,
      terminalStatus: "SUCCEEDED",
      decisionOutcome: "ALLOW",
      raw: {},
    });

    await manager.waitForIdle();
  });

  it("cancels worker on session reset", async () => {
    const { manager, notifications } = createHarness(
      async ({ signal }) =>
        await new Promise<WaitSuccess>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(
              new WaitCallError({
                message: "approval wait canceled",
                code: "ABORTED",
                retryable: false,
                category: "unknown",
              }),
            );
          });
        }),
    );

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: approvalRequiredResult(),
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-5",
      },
    );

    manager.onBeforeReset(
      {},
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-5",
      },
    );

    await manager.waitForIdle();
    expect(notifications.map((entry) => entry.reason)).toEqual(["approval-required"]);
    expect(manager.activeWorkerCount()).toBe(0);
  });

  it("suppresses non-actionable invalid approval payload warnings", async () => {
    const { manager, notifications, waitInvoker } = createHarness(async () => ({
      done: true,
      terminalStatus: "SUCCEEDED",
      decisionOutcome: "ALLOW",
      raw: {},
    }));

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: {
          details: {
            aggregated:
              "{\"ok\":false,\"error\":{\"code\":\"MCP_APPROVAL_REQUIRED\",\"details\":{\"approval\":{\"challenge_id\":\"ach_only\"",
          },
        },
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-invalid-suppressed",
      },
    );

    await manager.waitForIdle();
    expect(waitInvoker).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });
});
