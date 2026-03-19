import { describe, expect, it } from "vitest";
import { ApprovalHandoffManager } from "../src/approval-manager.js";
import { DEFAULT_CONFIG } from "../src/config.js";

function createManager() {
  const notifications: Array<{ reason: string; text: string }> = [];
  const manager = new ApprovalHandoffManager({
    config: { ...DEFAULT_CONFIG },
    waitInvoker: async () => ({ done: true, decisionOutcome: "ALLOW", raw: {} }),
    notifier: {
      post: (entry) => {
        notifications.push({ reason: entry.reason, text: entry.text });
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

  return { manager, notifications };
}

describe("regression behavior", () => {
  it("leaves non-approval tool errors unchanged", async () => {
    const { manager, notifications } = createManager();

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: {
          ok: false,
          error: {
            code: "MCP_VALIDATION_ERROR",
            message: "bad args",
          },
        },
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-6",
      },
    );

    await manager.waitForIdle();
    expect(notifications).toHaveLength(0);
  });

  it("leaves normal successful tool calls unchanged", async () => {
    const { manager, notifications } = createManager();

    manager.onAfterToolCall(
      {
        toolName: "vaultclaw_plan_execute",
        result: {
          ok: true,
          result: {
            status: "SUCCEEDED",
          },
        },
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "sess-7",
      },
    );

    await manager.waitForIdle();
    expect(notifications).toHaveLength(0);
  });
});
