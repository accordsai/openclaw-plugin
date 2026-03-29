import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createVaultCommandHandler } from "../src/vault-command.js";

function buildContext(args: string) {
  return {
    channel: "telegram",
    channelId: "telegram",
    isAuthorizedSender: true,
    commandBody: `/vault ${args}`,
    args,
    config: {},
    senderId: "509928323",
    from: "509928323",
    to: "509928323",
  } as any;
}

describe("vault token update command", () => {
  const stateDirs: string[] = [];

  afterEach(() => {
    while (stateDirs.length > 0) {
      const dir = stateDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("persists VC_AGENT_TOKEN to OpenClaw config", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-token-update-"));
    stateDirs.push(stateDir);
    const writeConfigFile = vi.fn(async () => undefined);
    const loadConfig = vi.fn(() => ({}));

    const handler = createVaultCommandHandler({
      api: {
        config: {},
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
          config: {
            loadConfig,
            writeConfigFile,
          },
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: DEFAULT_CONFIG,
      notifier: {
        post: vi.fn(),
      },
    });

    const result = await handler(buildContext("update token ses_abcd1234efgh5678"));
    expect(result.text).toContain("Vaultclaw token saved");
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).toHaveBeenCalledTimes(1);

    const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, any>;
    expect(written?.env?.VC_AGENT_TOKEN).toBe("ses_abcd1234efgh5678");
    expect(written?.env?.vars?.VC_AGENT_TOKEN).toBe("ses_abcd1234efgh5678");
    expect(written?.skills?.entries?.vaultclaw?.env?.VC_AGENT_TOKEN).toBe("ses_abcd1234efgh5678");
    expect(written?.skills?.entries?.vaultclaw_google?.env?.VC_AGENT_TOKEN).toBe("ses_abcd1234efgh5678");
  });

  it("rejects malformed token and does not write config", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-token-update-invalid-"));
    stateDirs.push(stateDir);
    const writeConfigFile = vi.fn(async () => undefined);

    const handler = createVaultCommandHandler({
      api: {
        config: {},
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
          config: {
            loadConfig: vi.fn(() => ({})),
            writeConfigFile,
          },
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: DEFAULT_CONFIG,
      notifier: {
        post: vi.fn(),
      },
    });

    const result = await handler(buildContext("update token not_a_session_token"));
    expect(result.text).toContain("format looks invalid");
    expect(writeConfigFile).not.toHaveBeenCalled();
  });
});
