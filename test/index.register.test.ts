import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { __resetTelegramNativeCommandsGuardForTest } from "../src/telegram-native-commands-guard.js";

describe("plugin registration", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    __resetTelegramNativeCommandsGuardForTest();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("registers /vault command without auth gating", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-plugin-index-"));
    tempDirs.push(stateDir);

    const registerCommand = vi.fn();
    const on = vi.fn();

    await plugin.register({
      pluginConfig: {},
      config: {},
      registerCommand,
      on,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
        system: {
          runCommandWithTimeout: vi.fn(),
        },
        config: {
          loadConfig: vi.fn(() => ({})),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
    } as any);

    expect(registerCommand).toHaveBeenCalled();
    const vaultCall = registerCommand.mock.calls.find((call) => call[0]?.name === "vault");
    expect(vaultCall).toBeDefined();
    expect(vaultCall?.[0]?.requireAuth).toBe(false);
    expect(typeof vaultCall?.[0]?.handler).toBe("function");
  });

  it("short-circuits /vault messages in before_dispatch", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-plugin-index-dispatch-"));
    tempDirs.push(stateDir);

    const on = vi.fn();

    await plugin.register({
      pluginConfig: {},
      config: {},
      registerCommand: vi.fn(),
      on,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
        system: {
          runCommandWithTimeout: vi.fn(),
        },
        config: {
          loadConfig: vi.fn(() => ({})),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
    } as any);

    const beforeDispatchHandler = on.mock.calls.find((call) => call[0] === "before_dispatch")?.[1];
    expect(typeof beforeDispatchHandler).toBe("function");
    const beforeAgentReplyHandler = on.mock.calls.find((call) => call[0] === "before_agent_reply")?.[1];
    expect(typeof beforeAgentReplyHandler).toBe("function");

    const handled = await beforeDispatchHandler(
      {
        content: "/vault status",
        channel: "webchat",
      },
      {
        channelId: "webchat",
        senderId: "tester",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(handled?.handled).toBe(true);
    expect(handled?.text).toContain("Vault command mode:");

    const passThrough = await beforeDispatchHandler(
      {
        content: "hello world",
        channel: "webchat",
      },
      {
        channelId: "webchat",
        senderId: "tester",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(passThrough).toBeUndefined();

    const beforeAgentReply = await beforeAgentReplyHandler(
      {
        cleanedBody:
          "[Chat messages since your last reply - for context]\nUser: hello\n\n[Current message - respond to this]\nUser: /vault status",
      },
      {
        channelId: "webchat",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(beforeAgentReply?.handled).toBe(true);
    expect(beforeAgentReply?.reply?.text).toContain("Vault command mode:");
  });

  it("short-circuits /vault messages in before_agent_reply for HTTP chat paths", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-plugin-index-agent-reply-"));
    tempDirs.push(stateDir);

    const on = vi.fn();

    await plugin.register({
      pluginConfig: {},
      config: {},
      registerCommand: vi.fn(),
      on,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
        system: {
          runCommandWithTimeout: vi.fn(),
        },
        config: {
          loadConfig: vi.fn(() => ({})),
          writeConfigFile: vi.fn(async () => {}),
        },
      },
    } as any);

    const beforeAgentReplyHandler = on.mock.calls.find((call) => call[0] === "before_agent_reply")?.[1];
    expect(typeof beforeAgentReplyHandler).toBe("function");

    const direct = await beforeAgentReplyHandler(
      {
        cleanedBody: "/vault status",
      },
      {
        channelId: "webchat",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(direct?.handled).toBe(true);
    expect(direct?.reply?.text).toContain("Vault command mode:");

    const rewritten = await beforeAgentReplyHandler(
      {
        cleanedBody: "vault status",
      },
      {
        channelId: "webchat",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(rewritten?.handled).toBe(true);
    expect(rewritten?.reply?.text).toContain("Vault command mode:");

    const wrapped = await beforeAgentReplyHandler(
      {
        cleanedBody:
          "[Chat messages since your last reply - for context]\nUser: hello\n\n[Current message - respond to this]\nUser: /vault status",
      },
      {
        channelId: "webchat",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(wrapped?.handled).toBe(true);
    expect(wrapped?.reply?.text).toContain("Vault command mode:");

    const wrappedRewritten = await beforeAgentReplyHandler(
      {
        cleanedBody:
          "[Chat messages since your last reply - for context]\nUser: hello\n\n[Current message - respond to this]\nUser: vault status",
      },
      {
        channelId: "webchat",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(wrappedRewritten?.handled).toBe(true);
    expect(wrappedRewritten?.reply?.text).toContain("Vault command mode:");

    const fromMessages = await beforeAgentReplyHandler(
      {
        messages: [
          { role: "assistant", content: "Hello" },
          { role: "user", content: "/vault status" },
        ],
      },
      {
        channelId: "webchat",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(fromMessages?.handled).toBe(true);
    expect(fromMessages?.reply?.text).toContain("Vault command mode:");

    const fromBodyMessages = await beforeAgentReplyHandler(
      {
        body: {
          messages: [
            { role: "assistant", content: "context" },
            { role: "user", content: "vault status" },
          ],
        },
      },
      {
        channelId: "webchat",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(fromBodyMessages?.handled).toBe(true);
    expect(fromBodyMessages?.reply?.text).toContain("Vault command mode:");

    const passThrough = await beforeAgentReplyHandler(
      {
        cleanedBody: "hello world",
      },
      {
        channelId: "webchat",
        sessionKey: "agent:main:webchat:direct:tester",
      },
    );
    expect(passThrough).toBeUndefined();
  });

  it("registers /vault immediately without waiting for Telegram native-command guard", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-plugin-index-guard-"));
    tempDirs.push(stateDir);

    const registerCommand = vi.fn();
    let resolveWrite: (() => void) | undefined;
    const writeConfigFile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const registerResult = plugin.register({
      pluginConfig: {},
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
      registerCommand,
      on: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
        system: {
          runCommandWithTimeout: vi.fn(),
        },
        config: {
          loadConfig: vi.fn(() => ({
            channels: {
              telegram: {
                enabled: true,
              },
            },
          })),
          writeConfigFile,
        },
      },
    } as any);

    expect(registerResult).toBeUndefined();
    expect(registerCommand).toHaveBeenCalled();

    await Promise.resolve();
    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    resolveWrite?.();
    await Promise.resolve();
  });
});
