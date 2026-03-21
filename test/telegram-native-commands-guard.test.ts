import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  __resetTelegramNativeCommandsGuardForTest,
  maybeDisableTelegramNativeCommands,
} from "../src/telegram-native-commands-guard.js";
import type { PluginConfig } from "../src/types.js";

function buildApi(params: {
  liveConfig: Record<string, unknown>;
  diskConfig?: Record<string, unknown>;
  writeImpl?: (cfg: unknown) => Promise<void>;
}) {
  const warn = vi.fn();
  const info = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();

  const loadConfig = vi.fn(() => params.diskConfig ?? params.liveConfig);
  const writeConfigFile = vi.fn(async (cfg: unknown) => {
    if (params.writeImpl) {
      await params.writeImpl(cfg);
    }
  });

  const api = {
    config: params.liveConfig,
    runtime: {
      config: {
        loadConfig,
        writeConfigFile,
      },
    },
    logger: {
      warn,
      info,
      error,
      debug,
    },
  } as unknown as OpenClawPluginApi;

  return {
    api,
    loadConfig,
    writeConfigFile,
    logger: {
      warn,
      info,
      error,
      debug,
    },
  };
}

function buildPluginConfig(overrides?: Partial<PluginConfig["vaultCommand"]>): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    vaultCommand: {
      ...DEFAULT_CONFIG.vaultCommand,
      ...overrides,
    },
  };
}

describe("maybeDisableTelegramNativeCommands", () => {
  beforeEach(() => {
    __resetTelegramNativeCommandsGuardForTest();
  });

  it("sets channels.telegram.commands.native=false when enabled and not already disabled", async () => {
    const { api, writeConfigFile, logger } = buildApi({
      liveConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });

    await maybeDisableTelegramNativeCommands({
      api,
      config: buildPluginConfig(),
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, any>;
    expect(written.channels.telegram.commands.native).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Set channels.telegram.commands.native=false"),
    );
  });

  it("does nothing when native command mode is already disabled", async () => {
    const { api, writeConfigFile, logger } = buildApi({
      liveConfig: {
        channels: {
          telegram: {
            enabled: true,
            commands: {
              native: false,
            },
          },
        },
      },
    });

    await maybeDisableTelegramNativeCommands({
      api,
      config: buildPluginConfig(),
    });

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does nothing when guard is disabled in plugin config", async () => {
    const { api, writeConfigFile, logger } = buildApi({
      liveConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });

    await maybeDisableTelegramNativeCommands({
      api,
      config: buildPluginConfig({
        autoDisableTelegramNativeCommands: false,
      }),
    });

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does nothing when telegram channel is not enabled", async () => {
    const { api, writeConfigFile } = buildApi({
      liveConfig: {},
    });

    await maybeDisableTelegramNativeCommands({
      api,
      config: buildPluginConfig(),
    });

    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("logs a warning when config write fails", async () => {
    const { api, writeConfigFile, logger } = buildApi({
      liveConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
      writeImpl: async () => {
        throw new Error("disk write failed");
      },
    });

    await maybeDisableTelegramNativeCommands({
      api,
      config: buildPluginConfig(),
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to set channels.telegram.commands.native=false"),
    );
  });

  it("attempts config write only once per process to avoid reload races", async () => {
    const { api, writeConfigFile } = buildApi({
      liveConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });

    await maybeDisableTelegramNativeCommands({
      api,
      config: buildPluginConfig(),
    });
    await maybeDisableTelegramNativeCommands({
      api,
      config: buildPluginConfig(),
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
  });
});
