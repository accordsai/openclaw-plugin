import { describe, expect, it } from "vitest";
import type { VaultPluginCommandContext } from "../src/vault-command-types.js";
import { buildVaultRouteContext } from "../src/vault-route-key.js";

function baseCtx(overrides: Partial<VaultPluginCommandContext> = {}): VaultPluginCommandContext {
  return {
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: "/vault status",
    config: {} as any,
    ...overrides,
  };
}

describe("buildVaultRouteContext", () => {
  it("builds stable route key from channel/account/sender/thread", () => {
    const context = buildVaultRouteContext(baseCtx({
      accountId: "primary",
      senderId: "12345",
      messageThreadId: 42,
    }));

    expect(context.key).toBe("vault:telegram:primary:12345:42");
  });

  it("derives channel session candidate from from address", () => {
    const context = buildVaultRouteContext(baseCtx({
      from: "telegram:98765",
      accountId: "primary",
    }));

    expect(context.sessionCandidates).toContain("agent:main:telegram:primary:direct:98765");
  });

  it("prefers channel session candidates over generic agent sessions when both exist", () => {
    const context = buildVaultRouteContext(baseCtx({
      from: "agent:main:main",
      to: "telegram:123",
    }));

    expect(context.sessionCandidates[0]).toBe("agent:main:telegram:direct:123");
    expect(context.sessionCandidates).toContain("agent:main:main");
  });

  it("prefers sender peer over direct-chat bot target when deriving session candidate", () => {
    const context = buildVaultRouteContext(baseCtx({
      senderId: "509928323",
      to: "telegram:BOT_00001",
      accountId: "primary",
    }));

    expect(context.sessionCandidates).toContain("agent:main:telegram:primary:direct:509928323");
    expect(context.sessionCandidates).not.toContain("agent:main:telegram:primary:direct:BOT_00001");
  });

  it("maps local main/tui channel commands to the main agent session", () => {
    const context = buildVaultRouteContext(baseCtx({
      channel: "main",
      senderId: "sam",
      from: "main",
      to: "main",
    }));

    expect(context.sessionCandidates[0]).toBe("agent:main:main");
  });

  it("maps local tui channel commands to the main agent session even without peer metadata", () => {
    const context = buildVaultRouteContext(baseCtx({
      channel: "tui",
    }));

    expect(context.sessionCandidates[0]).toBe("agent:main:main");
  });

  it("falls back to sender-derived peer when from/to are not channel addresses", () => {
    const context = buildVaultRouteContext(baseCtx({
      channel: "webchat",
      senderId: "gateway-client",
      from: "gateway-client",
      to: "gateway-client",
    }));

    expect(context.sessionCandidates).toContain("agent:main:webchat:direct:gateway-client");
  });
});
