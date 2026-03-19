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
) {
  const notifications: Array<{ text: string; reason: string; sessionKey?: string }> = [];
  const waitInvoker = vi.fn(waitImpl);
  const resumeInvoker = vi.fn(
    resumeImpl ??
      (async () => {
        // no-op
      }),
  );
  const manager = new ApprovalHandoffManager({
    config: { ...DEFAULT_CONFIG },
    waitInvoker,
    resumeInvoker,
    notifier: {
      post: (entry) => {
        notifications.push({ text: entry.text, reason: entry.reason, sessionKey: entry.sessionKey });
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

  return { manager, waitInvoker, resumeInvoker, notifications };
}

describe("ApprovalHandoffManager integration", () => {
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

  it("deduplicates duplicate approval events", async () => {
    let resolveWait: ((result: WaitSuccess) => void) | undefined;

    const { manager, waitInvoker } = createHarness(
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
});
