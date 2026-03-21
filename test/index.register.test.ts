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
