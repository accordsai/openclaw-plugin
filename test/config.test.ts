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
      reconcileOnValidationError: false,
      reconcileOnUnknownTerminal: false,
      reconcileTimeoutMs: 4000,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.pollIntervalMs).toBe(250);
    expect(cfg.maxWaitMs).toBe(120000);
    expect(cfg.commandTimeoutMs).toBe(180000);
    expect(cfg.maxConcurrentWaits).toBe(3);
    expect(cfg.reconcileOnValidationError).toBe(false);
    expect(cfg.reconcileOnUnknownTerminal).toBe(false);
    expect(cfg.reconcileTimeoutMs).toBe(4000);
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
});
