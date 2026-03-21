import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginConfig } from "./types.js";

const TELEGRAM_NATIVE_DISABLE_GUARD = Symbol.for(
  "vaultclaw.approval-handoff.telegram-native-disable.attempt.v1",
);

type TelegramNativeDisableGuardState = {
  attemptedWrite: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function extractTelegramCommandsNative(cfg: unknown): unknown {
  const channels = asRecord(asRecord(cfg).channels);
  const telegram = asRecord(channels.telegram);
  const commands = asRecord(telegram.commands);
  return commands.native;
}

function getGuardState(): TelegramNativeDisableGuardState {
  const globalState = globalThis as typeof globalThis & {
    [TELEGRAM_NATIVE_DISABLE_GUARD]?: TelegramNativeDisableGuardState;
  };
  if (!globalState[TELEGRAM_NATIVE_DISABLE_GUARD]) {
    globalState[TELEGRAM_NATIVE_DISABLE_GUARD] = {
      attemptedWrite: false,
    };
  }
  return globalState[TELEGRAM_NATIVE_DISABLE_GUARD];
}

export function __resetTelegramNativeCommandsGuardForTest(): void {
  getGuardState().attemptedWrite = false;
}

export async function maybeDisableTelegramNativeCommands(params: {
  api: OpenClawPluginApi;
  config: PluginConfig;
}): Promise<void> {
  if (!params.config.vaultCommand.autoDisableTelegramNativeCommands) {
    return;
  }

  const channels = asRecord(asRecord(params.api.config).channels);
  const telegram = asRecord(channels.telegram);
  if (!readBoolean(telegram.enabled, false)) {
    return;
  }

  if (extractTelegramCommandsNative(params.api.config) === false) {
    return;
  }
  const guard = getGuardState();
  if (guard.attemptedWrite) {
    return;
  }
  guard.attemptedWrite = true;

  try {
    const loaded = params.api.runtime.config.loadConfig();
    if (extractTelegramCommandsNative(loaded) === false) {
      return;
    }

    const loadedRecord = loaded as unknown as Record<string, unknown>;
    const nextChannels = asRecord(loadedRecord.channels);
    const nextTelegram = asRecord(nextChannels.telegram);
    const nextCommands = asRecord(nextTelegram.commands);

    const nextConfig = {
      ...loadedRecord,
      channels: {
        ...nextChannels,
        telegram: {
          ...nextTelegram,
          commands: {
            ...nextCommands,
            native: false,
          },
        },
      },
    } as OpenClawConfig;

    await params.api.runtime.config.writeConfigFile(nextConfig);
    params.api.logger.warn(
      "[vaultclaw-approval-handoff] Set channels.telegram.commands.native=false to avoid intermittent '/vault' command misses on Telegram. Restart the gateway to apply.",
    );
  } catch (error) {
    guard.attemptedWrite = false;
    params.api.logger.warn(
      `[vaultclaw-approval-handoff] Failed to set channels.telegram.commands.native=false: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
