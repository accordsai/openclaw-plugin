import type { PluginConfig, VaultCommandMode } from "./types.js";

export const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  pollIntervalMs: 1500,
  maxWaitMs: 600000,
  commandTimeoutMs: 720000,
  maxConcurrentWaits: 10,
  allowMcporterFallback: false,
  reconcileOnValidationError: true,
  reconcileOnUnknownTerminal: true,
  reconcileOnWaitError: true,
  reconcileTimeoutMs: 15000,
  vaultCommand: {
    enabled: true,
    defaultEnabled: true,
    defaultMode: "hybrid",
    autoDisableTelegramNativeCommands: true,
    sessionModeTtlMs: 604800000,
    maxConcurrentRuns: 5,
    enableCoreFallback: true,
    coreFallbackTimeoutMs: 30000,
    resolverTool: "vaultclaw_route_resolve",
    resolverTimeoutMs: 3500,
    enrichmentGlobalTimeoutMs: 4500,
    enrichmentTaskTimeoutMs: 2200,
    deterministicDomains: ["google.gmail", "generic.http"],
  },
};

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function readString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : fallback;
}

function readMode(value: unknown, fallback: VaultCommandMode): VaultCommandMode {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "hybrid" || normalized === "strict") {
    return normalized;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function normalizePluginConfig(raw: unknown): PluginConfig {
  const record = asRecord(raw);
  const vaultRecord = asRecord(record.vaultCommand);

  const config: PluginConfig = {
    enabled: readBoolean(record.enabled, DEFAULT_CONFIG.enabled),
    pollIntervalMs: readNumber(record.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs),
    maxWaitMs: readNumber(record.maxWaitMs, DEFAULT_CONFIG.maxWaitMs),
    commandTimeoutMs: readNumber(record.commandTimeoutMs, DEFAULT_CONFIG.commandTimeoutMs),
    maxConcurrentWaits: readNumber(record.maxConcurrentWaits, DEFAULT_CONFIG.maxConcurrentWaits),
    allowMcporterFallback: readBoolean(
      record.allowMcporterFallback,
      DEFAULT_CONFIG.allowMcporterFallback,
    ),
    reconcileOnValidationError: readBoolean(
      record.reconcileOnValidationError,
      DEFAULT_CONFIG.reconcileOnValidationError,
    ),
    reconcileOnUnknownTerminal: readBoolean(
      record.reconcileOnUnknownTerminal,
      DEFAULT_CONFIG.reconcileOnUnknownTerminal,
    ),
    reconcileOnWaitError: readBoolean(record.reconcileOnWaitError, DEFAULT_CONFIG.reconcileOnWaitError),
    reconcileTimeoutMs: readNumber(record.reconcileTimeoutMs, DEFAULT_CONFIG.reconcileTimeoutMs),
    vaultCommand: {
      enabled: readBoolean(vaultRecord.enabled, DEFAULT_CONFIG.vaultCommand.enabled),
      defaultEnabled: readBoolean(vaultRecord.defaultEnabled, DEFAULT_CONFIG.vaultCommand.defaultEnabled),
      defaultMode: readMode(vaultRecord.defaultMode, DEFAULT_CONFIG.vaultCommand.defaultMode),
      autoDisableTelegramNativeCommands: readBoolean(
        vaultRecord.autoDisableTelegramNativeCommands,
        DEFAULT_CONFIG.vaultCommand.autoDisableTelegramNativeCommands,
      ),
      sessionModeTtlMs: readNumber(vaultRecord.sessionModeTtlMs, DEFAULT_CONFIG.vaultCommand.sessionModeTtlMs),
      maxConcurrentRuns: readNumber(vaultRecord.maxConcurrentRuns, DEFAULT_CONFIG.vaultCommand.maxConcurrentRuns),
      enableCoreFallback: readBoolean(
        vaultRecord.enableCoreFallback,
        DEFAULT_CONFIG.vaultCommand.enableCoreFallback,
      ),
      coreFallbackTimeoutMs: readNumber(
        vaultRecord.coreFallbackTimeoutMs,
        DEFAULT_CONFIG.vaultCommand.coreFallbackTimeoutMs,
      ),
      resolverTool: readString(vaultRecord.resolverTool, DEFAULT_CONFIG.vaultCommand.resolverTool),
      resolverTimeoutMs: readNumber(vaultRecord.resolverTimeoutMs, DEFAULT_CONFIG.vaultCommand.resolverTimeoutMs),
      enrichmentGlobalTimeoutMs: readNumber(
        vaultRecord.enrichmentGlobalTimeoutMs,
        DEFAULT_CONFIG.vaultCommand.enrichmentGlobalTimeoutMs,
      ),
      enrichmentTaskTimeoutMs: readNumber(
        vaultRecord.enrichmentTaskTimeoutMs,
        DEFAULT_CONFIG.vaultCommand.enrichmentTaskTimeoutMs,
      ),
      deterministicDomains: readStringArray(
        vaultRecord.deterministicDomains,
        DEFAULT_CONFIG.vaultCommand.deterministicDomains,
      ),
    },
  };

  if (config.pollIntervalMs < 250 || config.pollIntervalMs > 10000) {
    throw new Error("pollIntervalMs must be within 250..10000");
  }
  if (config.maxWaitMs < 1000 || config.maxWaitMs > 3600000) {
    throw new Error("maxWaitMs must be within 1000..3600000");
  }
  if (config.commandTimeoutMs <= config.maxWaitMs) {
    throw new Error("commandTimeoutMs must be greater than maxWaitMs");
  }
  if (config.maxConcurrentWaits < 1) {
    throw new Error("maxConcurrentWaits must be at least 1");
  }
  if (config.reconcileTimeoutMs < 1000 || config.reconcileTimeoutMs > 60000) {
    throw new Error("reconcileTimeoutMs must be within 1000..60000");
  }

  if (config.vaultCommand.sessionModeTtlMs < 60000 || config.vaultCommand.sessionModeTtlMs > 2592000000) {
    throw new Error("vaultCommand.sessionModeTtlMs must be within 60000..2592000000");
  }
  if (config.vaultCommand.maxConcurrentRuns < 1 || config.vaultCommand.maxConcurrentRuns > 100) {
    throw new Error("vaultCommand.maxConcurrentRuns must be within 1..100");
  }
  if (config.vaultCommand.coreFallbackTimeoutMs < 1000 || config.vaultCommand.coreFallbackTimeoutMs > 120000) {
    throw new Error("vaultCommand.coreFallbackTimeoutMs must be within 1000..120000");
  }
  if (config.vaultCommand.resolverTimeoutMs < 1000 || config.vaultCommand.resolverTimeoutMs > 60000) {
    throw new Error("vaultCommand.resolverTimeoutMs must be within 1000..60000");
  }
  if (
    config.vaultCommand.enrichmentGlobalTimeoutMs < 1000 ||
    config.vaultCommand.enrichmentGlobalTimeoutMs > 60000
  ) {
    throw new Error("vaultCommand.enrichmentGlobalTimeoutMs must be within 1000..60000");
  }
  if (
    config.vaultCommand.enrichmentTaskTimeoutMs < 1000 ||
    config.vaultCommand.enrichmentTaskTimeoutMs > 60000
  ) {
    throw new Error("vaultCommand.enrichmentTaskTimeoutMs must be within 1000..60000");
  }
  if (config.vaultCommand.enrichmentTaskTimeoutMs > config.vaultCommand.enrichmentGlobalTimeoutMs) {
    throw new Error("vaultCommand.enrichmentTaskTimeoutMs must be <= enrichmentGlobalTimeoutMs");
  }
  if (config.vaultCommand.resolverTool.trim().length === 0) {
    throw new Error("vaultCommand.resolverTool is required");
  }
  if (config.vaultCommand.deterministicDomains.length === 0) {
    throw new Error("vaultCommand.deterministicDomains must include at least one domain");
  }

  return config;
}
