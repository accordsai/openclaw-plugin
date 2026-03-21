import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizePluginConfig } from "../src/config.js";

describe("normalizePluginConfig", () => {
  it("uses defaults", () => {
    expect(normalizePluginConfig(undefined)).toEqual(DEFAULT_CONFIG);
  });

  it("accepts valid overrides", () => {
    const cfg = normalizePluginConfig({
      enabled: false,
      pollIntervalMs: 250,
      maxWaitMs: 120000,
      commandTimeoutMs: 180000,
      maxConcurrentWaits: 3,
      allowMcporterFallback: true,
      reconcileOnValidationError: false,
      reconcileOnUnknownTerminal: false,
      reconcileOnWaitError: false,
      reconcileTimeoutMs: 4000,
      vaultCommand: {
        enabled: true,
        defaultEnabled: false,
        defaultMode: "strict",
        autoDisableTelegramNativeCommands: false,
        sessionModeTtlMs: 3600000,
        maxConcurrentRuns: 9,
        enableCoreFallback: false,
        coreFallbackTimeoutMs: 12000,
        resolverTool: "vaultclaw_route_resolve",
        resolverTimeoutMs: 9000,
        enrichmentGlobalTimeoutMs: 11000,
        enrichmentTaskTimeoutMs: 7000,
        deterministicDomains: ["google.gmail"],
      },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.pollIntervalMs).toBe(250);
    expect(cfg.maxWaitMs).toBe(120000);
    expect(cfg.commandTimeoutMs).toBe(180000);
    expect(cfg.maxConcurrentWaits).toBe(3);
    expect(cfg.allowMcporterFallback).toBe(true);
    expect(cfg.reconcileOnValidationError).toBe(false);
    expect(cfg.reconcileOnUnknownTerminal).toBe(false);
    expect(cfg.reconcileOnWaitError).toBe(false);
    expect(cfg.reconcileTimeoutMs).toBe(4000);
    expect(cfg.vaultCommand.enabled).toBe(true);
    expect(cfg.vaultCommand.defaultEnabled).toBe(false);
    expect(cfg.vaultCommand.defaultMode).toBe("strict");
    expect(cfg.vaultCommand.autoDisableTelegramNativeCommands).toBe(false);
    expect(cfg.vaultCommand.sessionModeTtlMs).toBe(3600000);
    expect(cfg.vaultCommand.maxConcurrentRuns).toBe(9);
    expect(cfg.vaultCommand.enableCoreFallback).toBe(false);
    expect(cfg.vaultCommand.coreFallbackTimeoutMs).toBe(12000);
    expect(cfg.vaultCommand.resolverTool).toBe("vaultclaw_route_resolve");
    expect(cfg.vaultCommand.resolverTimeoutMs).toBe(9000);
    expect(cfg.vaultCommand.enrichmentGlobalTimeoutMs).toBe(11000);
    expect(cfg.vaultCommand.enrichmentTaskTimeoutMs).toBe(7000);
    expect(cfg.vaultCommand.deterministicDomains).toEqual(["google.gmail"]);
  });

  it("rejects out-of-range poll interval", () => {
    expect(() => normalizePluginConfig({ pollIntervalMs: 100 })).toThrow(
      /pollIntervalMs must be within 250\.\.10000/,
    );
  });

  it("rejects command timeout <= max wait", () => {
    expect(() =>
      normalizePluginConfig({
        maxWaitMs: 2000,
        commandTimeoutMs: 2000,
      }),
    ).toThrow(/commandTimeoutMs must be greater than maxWaitMs/);
  });

  it("rejects out-of-range reconcile timeout", () => {
    expect(() => normalizePluginConfig({ reconcileTimeoutMs: 500 })).toThrow(
      /reconcileTimeoutMs must be within 1000\.\.60000/,
    );
  });

  it("rejects invalid vault command ttl", () => {
    expect(() => normalizePluginConfig({ vaultCommand: { sessionModeTtlMs: 500 } })).toThrow(
      /vaultCommand\.sessionModeTtlMs must be within 60000\.\.2592000000/,
    );
  });

  it("rejects enrichment task timeout above global timeout", () => {
    expect(() =>
      normalizePluginConfig({
        vaultCommand: {
          enrichmentGlobalTimeoutMs: 6000,
          enrichmentTaskTimeoutMs: 7000,
        },
      }),
    ).toThrow(/vaultCommand\.enrichmentTaskTimeoutMs must be <= enrichmentGlobalTimeoutMs/);
  });
});
