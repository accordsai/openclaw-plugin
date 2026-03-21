import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { VaultCommandMode } from "./types.js";

export type VaultModeState = {
  enabled: boolean;
  mode: VaultCommandMode;
  updatedAtMs: number;
  expiresAtMs: number;
};

type StateFile = {
  version: number;
  entries: Record<string, VaultModeState>;
};

export class VaultModeStore {
  private readonly filePath: string;
  private readonly defaultEnabled: boolean;
  private readonly defaultMode: VaultCommandMode;
  private readonly ttlMs: number;

  private loaded = false;
  private entries = new Map<string, VaultModeState>();
  private writeQueue = Promise.resolve();

  constructor(params: {
    filePath: string;
    defaultEnabled: boolean;
    defaultMode: VaultCommandMode;
    ttlMs: number;
  }) {
    this.filePath = params.filePath;
    this.defaultEnabled = params.defaultEnabled;
    this.defaultMode = params.defaultMode;
    this.ttlMs = params.ttlMs;
  }

  async get(routeKey: string, nowMs = Date.now()): Promise<VaultModeState> {
    await this.ensureLoaded(nowMs);
    this.pruneExpired(nowMs);

    const existing = this.entries.get(routeKey);
    if (existing) {
      return existing;
    }

    return {
      enabled: this.defaultEnabled,
      mode: this.defaultMode,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
  }

  async set(
    routeKey: string,
    next: {
      enabled: boolean;
      mode: VaultCommandMode;
    },
    nowMs = Date.now(),
  ): Promise<VaultModeState> {
    await this.ensureLoaded(nowMs);
    this.pruneExpired(nowMs);

    const state: VaultModeState = {
      enabled: next.enabled,
      mode: next.mode,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };

    this.entries.set(routeKey, state);
    await this.persist();
    return state;
  }

  async prune(nowMs = Date.now()): Promise<void> {
    await this.ensureLoaded(nowMs);
    if (!this.pruneExpired(nowMs)) {
      return;
    }
    await this.persist();
  }

  private async ensureLoaded(nowMs: number) {
    if (this.loaded) {
      return;
    }

    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      const entries = parsed.entries;
      if (!entries || typeof entries !== "object") {
        return;
      }

      for (const [routeKey, value] of Object.entries(entries)) {
        if (!value || typeof value !== "object") {
          continue;
        }

        const candidate = value as Partial<VaultModeState>;
        if (typeof candidate.enabled !== "boolean") {
          continue;
        }
        const mode = candidate.mode === "strict" ? "strict" : "hybrid";
        const updatedAtMs =
          typeof candidate.updatedAtMs === "number" && Number.isFinite(candidate.updatedAtMs)
            ? Math.trunc(candidate.updatedAtMs)
            : nowMs;
        const expiresAtMs =
          typeof candidate.expiresAtMs === "number" && Number.isFinite(candidate.expiresAtMs)
            ? Math.trunc(candidate.expiresAtMs)
            : updatedAtMs + this.ttlMs;

        this.entries.set(routeKey, {
          enabled: candidate.enabled,
          mode,
          updatedAtMs,
          expiresAtMs,
        });
      }
    } catch {
      // Treat missing/corrupt state as empty.
    }
  }

  private pruneExpired(nowMs: number): boolean {
    let removed = false;
    for (const [routeKey, state] of this.entries.entries()) {
      if (state.expiresAtMs > nowMs) {
        continue;
      }
      this.entries.delete(routeKey);
      removed = true;
    }
    return removed;
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const payload: StateFile = {
        version: 1,
        entries: Object.fromEntries(this.entries.entries()),
      };
      await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    });

    await this.writeQueue;
  }
}
