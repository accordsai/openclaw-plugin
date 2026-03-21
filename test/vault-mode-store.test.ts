import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { VaultModeStore } from "../src/vault-mode-store.js";

describe("VaultModeStore", () => {
  it("uses defaults for unknown route keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-mode-store-"));
    const store = new VaultModeStore({
      filePath: join(dir, "state.json"),
      defaultEnabled: true,
      defaultMode: "hybrid",
      ttlMs: 1000,
    });

    const state = await store.get("vault:test");
    expect(state.enabled).toBe(true);
    expect(state.mode).toBe("hybrid");
  });

  it("persists updates and reloads them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-mode-store-"));
    const filePath = join(dir, "state.json");

    const store1 = new VaultModeStore({
      filePath,
      defaultEnabled: true,
      defaultMode: "hybrid",
      ttlMs: 60_000,
    });

    await store1.set("vault:test", { enabled: false, mode: "strict" }, 10_000);

    const store2 = new VaultModeStore({
      filePath,
      defaultEnabled: true,
      defaultMode: "hybrid",
      ttlMs: 60_000,
    });

    const state = await store2.get("vault:test", 10_500);
    expect(state.enabled).toBe(false);
    expect(state.mode).toBe("strict");
  });

  it("prunes expired entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-mode-store-"));
    const filePath = join(dir, "state.json");

    const store = new VaultModeStore({
      filePath,
      defaultEnabled: true,
      defaultMode: "hybrid",
      ttlMs: 100,
    });

    await store.set("vault:test", { enabled: true, mode: "hybrid" }, 1_000);
    await store.prune(1_200);

    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(raw.entries["vault:test"]).toBeUndefined();
  });

  it("recovers from corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-mode-store-"));
    const filePath = join(dir, "state.json");
    await writeFile(filePath, "{invalid json", "utf8");

    const store = new VaultModeStore({
      filePath,
      defaultEnabled: false,
      defaultMode: "strict",
      ttlMs: 1000,
    });

    const state = await store.get("vault:test");
    expect(state.enabled).toBe(false);
    expect(state.mode).toBe("strict");
  });
});
