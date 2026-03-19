import type { ApprovalHandoffConfig } from "./types.js";

export const DEFAULT_CONFIG: ApprovalHandoffConfig = {
  enabled: true,
  pollIntervalMs: 1500,
  maxWaitMs: 600000,
  commandTimeoutMs: 720000,
  maxConcurrentWaits: 10,
  reconcileOnValidationError: true,
  reconcileOnUnknownTerminal: true,
  reconcileTimeoutMs: 15000,
};

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function normalizePluginConfig(raw: unknown): ApprovalHandoffConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

  const config: ApprovalHandoffConfig = {
    enabled: readBoolean(record.enabled, DEFAULT_CONFIG.enabled),
    pollIntervalMs: readNumber(record.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs),
    maxWaitMs: readNumber(record.maxWaitMs, DEFAULT_CONFIG.maxWaitMs),
    commandTimeoutMs: readNumber(record.commandTimeoutMs, DEFAULT_CONFIG.commandTimeoutMs),
    maxConcurrentWaits: readNumber(record.maxConcurrentWaits, DEFAULT_CONFIG.maxConcurrentWaits),
    reconcileOnValidationError: readBoolean(
      record.reconcileOnValidationError,
      DEFAULT_CONFIG.reconcileOnValidationError,
    ),
    reconcileOnUnknownTerminal: readBoolean(
      record.reconcileOnUnknownTerminal,
      DEFAULT_CONFIG.reconcileOnUnknownTerminal,
    ),
    reconcileTimeoutMs: readNumber(record.reconcileTimeoutMs, DEFAULT_CONFIG.reconcileTimeoutMs),
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

  return config;
}
