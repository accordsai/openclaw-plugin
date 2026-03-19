import { describe, expect, it } from "vitest";
import { extractToolResultToolName, resolveSessionContext } from "../src/session-context.js";

describe("resolveSessionContext", () => {
  it("prefers explicit sessionKey", () => {
    expect(
      resolveSessionContext({
        sessionKey: "agent:main:main-linkfix",
        sessionId: "0d2f0d3b-66cc-42a2-83fe-d6d39ad631f8",
      }),
    ).toEqual({
      sessionKey: "agent:main:main-linkfix",
      sessionId: "0d2f0d3b-66cc-42a2-83fe-d6d39ad631f8",
    });
  });

  it("uses sessionId as sessionKey only when it is an agent session key", () => {
    expect(
      resolveSessionContext({
        sessionId: "agent:main:main",
      }),
    ).toEqual({
      sessionKey: "agent:main:main",
      sessionId: "agent:main:main",
    });
  });

  it("does not invent fallback keys when only ephemeral sessionId is present", () => {
    expect(
      resolveSessionContext({
        sessionId: "0d2f0d3b-66cc-42a2-83fe-d6d39ad631f8",
      }),
    ).toEqual({
      sessionKey: undefined,
      sessionId: "0d2f0d3b-66cc-42a2-83fe-d6d39ad631f8",
    });
  });
});

describe("extractToolResultToolName", () => {
  it("prefers event.toolName", () => {
    expect(
      extractToolResultToolName({
        event: { toolName: "exec" },
        message: { toolName: "fallback-message" },
        fallback: "fallback",
      }),
    ).toBe("exec");
  });

  it("falls back to persisted message.toolName", () => {
    expect(
      extractToolResultToolName({
        event: {},
        message: { toolName: "mcporter" },
        fallback: "fallback",
      }),
    ).toBe("mcporter");
  });

  it("uses caller fallback when neither event nor message has toolName", () => {
    expect(
      extractToolResultToolName({
        event: {},
        message: {},
        fallback: "tool",
      }),
    ).toBe("tool");
  });
});
