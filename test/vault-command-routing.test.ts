import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { PluginConfig, VaultCommandMode } from "../src/types.js";
import { createVaultCommandHandler } from "../src/vault-command.js";
import { executeResolvedVaultRoute } from "../src/vault-executor.js";
import { resolveAndEnrichVaultRoute } from "../src/vault-route-orchestrator.js";
import { runCoreFallback } from "../src/vault-core-fallback.js";

vi.mock("../src/vault-route-orchestrator.js", async () => {
  const actual = await vi.importActual<typeof import("../src/vault-route-orchestrator.js")>(
    "../src/vault-route-orchestrator.js",
  );
  return {
    ...actual,
    resolveAndEnrichVaultRoute: vi.fn(),
  };
});

vi.mock("../src/vault-core-fallback.js", async () => {
  const actual = await vi.importActual<typeof import("../src/vault-core-fallback.js")>(
    "../src/vault-core-fallback.js",
  );
  return {
    ...actual,
    runCoreFallback: vi.fn(),
  };
});

vi.mock("../src/vault-executor.js", async () => {
  const actual = await vi.importActual<typeof import("../src/vault-executor.js")>(
    "../src/vault-executor.js",
  );
  return {
    ...actual,
    executeResolvedVaultRoute: vi.fn(),
  };
});

function buildConfig(mode: VaultCommandMode): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    vaultCommand: {
      ...DEFAULT_CONFIG.vaultCommand,
      defaultEnabled: true,
      defaultMode: mode,
      enableCoreFallback: true,
    },
  };
}

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

function buildMainContext(args: string) {
  return {
    channel: "main",
    channelId: "main",
    isAuthorizedSender: true,
    commandBody: `/vault ${args}`,
    args,
    config: {},
    senderId: "main",
    from: "main",
    to: "main",
  } as any;
}

function buildWebchatContext(args: string, overrides: Record<string, unknown> = {}) {
  return {
    channel: "webchat",
    channelId: "webchat",
    isAuthorizedSender: true,
    commandBody: `/vault ${args}`,
    args,
    config: {},
    senderId: "gateway-client",
    from: "gateway-client",
    to: "gateway-client",
    ...overrides,
  } as any;
}

describe("createVaultCommandHandler missing-input routing", () => {
  const resolveMock = vi.mocked(resolveAndEnrichVaultRoute);
  const fallbackMock = vi.mocked(runCoreFallback);
  const executeMock = vi.mocked(executeResolvedVaultRoute);
  const stateDirs: string[] = [];
  const notifier = {
    post: vi.fn(),
  };

  beforeEach(() => {
    resolveMock.mockReset();
    fallbackMock.mockReset();
    executeMock.mockReset();
    notifier.post.mockReset();
    fallbackMock.mockResolvedValue({
      ok: true,
      message: "Fallback routed to standard OpenClaw flow.",
    });
  });

  afterEach(() => {
    while (stateDirs.length > 0) {
      const dir = stateDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("Case A: weather enrichment success path emits interim progress before approval message", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-hybrid-"));
    stateDirs.push(stateDir);

    resolveMock.mockImplementation(async (params: any) => {
      params.onAutoFillStart?.({
        tasks: [
          {
            factKey: "weather_summary",
            kind: "weather",
          },
        ],
      });
      return {
        rawEnvelope: {},
        payload: {
          status: "RESOLVED_EXECUTABLE",
          execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
          inputs: {
            subject: "Daily weather",
            text_plain: "Sunny in Irvine",
          },
        },
        telemetry: {
          usedGuidance: true,
          guidanceCount: 1,
          askUserCount: 0,
          autoRetryCount: 1,
          autoRetryAttempted: true,
          factTasksStarted: 1,
          factTasksCompleted: 1,
          factTasksFailed: 0,
          factTasksTimedOut: 0,
          retryStatus: "RESOLVED_EXECUTABLE",
          elapsedMs: 10,
        },
      };
    });
    executeMock.mockResolvedValue({
      kind: "approval_required",
      toolName: "vaultclaw_approval_wait",
      envelope: { ok: true },
    } as any);
    const manager = {
      onAfterToolCall: vi.fn(),
    };

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: manager as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const result = await handler(buildContext("send an email to skl83@cornell.edu with the weather for irvine, ca"));
    expect(notifier.post).toHaveBeenCalledTimes(1);
    expect(notifier.post.mock.calls[0]?.[0]?.text).toBe(
      "I found the Vault action. I am now gathering the missing details and will continue automatically. I am fetching weather details now.",
    );
    expect(result.text).toBe(
      "I got what I needed and I am continuing with Vault now. Approval required in Vaultclaw UI. Waiting asynchronously for terminal outcome.",
    );
    expect(manager.onAfterToolCall).toHaveBeenCalledTimes(1);
    expect(notifier.post.mock.invocationCallOrder[0]).toBeLessThan(
      manager.onAfterToolCall.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(fallbackMock).not.toHaveBeenCalled();
  });

  it("routes approval waits to the main session when /vault runs in local main channel", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-main-session-"));
    stateDirs.push(stateDir);

    resolveMock.mockResolvedValue({
      rawEnvelope: {},
      payload: {
        status: "RESOLVED_EXECUTABLE",
        execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
        inputs: {
          subject: "Test",
          text_plain: "Test body",
        },
      },
      telemetry: {
        usedGuidance: false,
        guidanceCount: 0,
        askUserCount: 0,
        autoRetryCount: 0,
        autoRetryAttempted: false,
        factTasksStarted: 0,
        factTasksCompleted: 0,
        factTasksFailed: 0,
        factTasksTimedOut: 0,
        elapsedMs: 5,
      },
    });
    executeMock.mockResolvedValue({
      kind: "approval_required",
      toolName: "vaultclaw_plan_execute",
      envelope: { ok: true },
    } as any);
    const manager = {
      onAfterToolCall: vi.fn(),
    };

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: manager as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const result = await handler(buildMainContext("send an email to skl83@cornell.edu"));
    expect(result.text).toBe("Approval required in Vaultclaw UI. Waiting asynchronously for terminal outcome.");
    expect(manager.onAfterToolCall).toHaveBeenCalledTimes(1);
    expect(manager.onAfterToolCall.mock.calls[0]?.[1]).toEqual({
      sessionKey: "agent:main:main",
      sessionId: "agent:main:main",
      deliverySessionKey: "agent:main:main",
      deliverySessionId: "agent:main:main",
      deliveryTargetReason: "route_session_candidate",
      skipInitialRequiredNotification: true,
    });
  });

  it("returns attestation details in immediate approval response when available", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-attestation-response-"));
    stateDirs.push(stateDir);

    resolveMock.mockResolvedValue({
      rawEnvelope: {},
      payload: {
        status: "RESOLVED_EXECUTABLE",
        execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
        inputs: {
          subject: "Wine",
          text_plain: "Bouzeron notes",
        },
      },
      telemetry: {
        usedGuidance: false,
        guidanceCount: 0,
        askUserCount: 0,
        autoRetryCount: 0,
        autoRetryAttempted: false,
        factTasksStarted: 0,
        factTasksCompleted: 0,
        factTasksFailed: 0,
        factTasksTimedOut: 0,
        elapsedMs: 5,
      },
    });
    executeMock.mockResolvedValue({
      kind: "approval_required",
      toolName: "vaultclaw_plan_execute",
      envelope: {
        ok: false,
        error: {
          code: "MCP_APPROVAL_REQUIRED",
          details: {
            approval: {
              challenge_id: "ach_42",
              pending_id: "apj_42",
              run_id: "run_42",
              job_id: "job_42",
              remote_attestation_url: "https://alerts.accords.ai/a/test/ach_42/token",
              next_action: {
                tool: "vaultclaw_approval_wait",
                arguments: {
                  handle: {
                    kind: "PLAN_RUN",
                    challenge_id: "ach_42",
                    pending_id: "apj_42",
                    run_id: "run_42",
                    job_id: "job_42",
                  },
                },
              },
            },
          },
        },
      },
    } as any);

    const manager = {
      onAfterToolCall: vi.fn(),
    };

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: manager as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const result = await handler(buildMainContext("send an email to skl83@cornell.edu"));
    expect(result.text).toBe(
      "Approval required in Vaultclaw UI. Waiting up to 10 minutes... (challenge_id=ach_42, pending_id=apj_42, run_id=run_42, job_id=job_42)\nAttestation link: [https://alerts.accords.ai/a/test/ach_42/token](https://alerts.accords.ai/a/test/ach_42/token)",
    );
    expect(manager.onAfterToolCall).toHaveBeenCalledTimes(1);
    expect(manager.onAfterToolCall.mock.calls[0]?.[1]).toEqual({
      sessionKey: "agent:main:main",
      sessionId: "agent:main:main",
      deliverySessionKey: "agent:main:main",
      deliverySessionId: "agent:main:main",
      deliveryTargetReason: "route_session_candidate",
      skipInitialRequiredNotification: true,
    });
  });

  it("uses runtime sessionId for approval follow-up delivery when present", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-webchat-sessionid-"));
    stateDirs.push(stateDir);

    resolveMock.mockResolvedValue({
      rawEnvelope: {},
      payload: {
        status: "RESOLVED_EXECUTABLE",
        execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
        inputs: {
          subject: "Test",
          text_plain: "Body",
        },
      },
      telemetry: {
        usedGuidance: false,
        guidanceCount: 0,
        askUserCount: 0,
        autoRetryCount: 0,
        autoRetryAttempted: false,
        factTasksStarted: 0,
        factTasksCompleted: 0,
        factTasksFailed: 0,
        factTasksTimedOut: 0,
        elapsedMs: 5,
      },
    });
    executeMock.mockResolvedValue({
      kind: "approval_required",
      toolName: "vaultclaw_plan_execute",
      envelope: { ok: true },
    } as any);

    const manager = {
      onAfterToolCall: vi.fn(),
    };

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: manager as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const result = await handler(
      buildWebchatContext("send an email to skl83@cornell.edu", {
        sessionId: "sess-webchat-123",
      }),
    );
    expect(result.text).toBe("Approval required in Vaultclaw UI. Waiting asynchronously for terminal outcome.");
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0]?.[0]?.sessionKey).toBe("agent:main:webchat:direct:gateway-client");
    expect(manager.onAfterToolCall).toHaveBeenCalledTimes(1);
    expect(manager.onAfterToolCall.mock.calls[0]?.[1]).toEqual({
      sessionKey: "agent:main:webchat:direct:gateway-client",
      sessionId: "sess-webchat-123",
      deliverySessionKey: "agent:main:webchat:direct:gateway-client",
      deliverySessionId: "sess-webchat-123",
      deliveryTargetReason: "route_session_candidate",
      skipInitialRequiredNotification: true,
    });
  });

  it("uses runtime sessionKey when available for webchat command execution and follow-up", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-webchat-sessionkey-"));
    stateDirs.push(stateDir);

    resolveMock.mockResolvedValue({
      rawEnvelope: {},
      payload: {
        status: "RESOLVED_EXECUTABLE",
        execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
        inputs: {
          subject: "Test",
          text_plain: "Body",
        },
      },
      telemetry: {
        usedGuidance: false,
        guidanceCount: 0,
        askUserCount: 0,
        autoRetryCount: 0,
        autoRetryAttempted: false,
        factTasksStarted: 0,
        factTasksCompleted: 0,
        factTasksFailed: 0,
        factTasksTimedOut: 0,
        elapsedMs: 5,
      },
    });
    executeMock.mockResolvedValue({
      kind: "approval_required",
      toolName: "vaultclaw_plan_execute",
      envelope: { ok: true },
    } as any);

    const manager = {
      onAfterToolCall: vi.fn(),
    };

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: manager as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const runtimeSessionKey = "agent:main:webchat:default:direct:gateway-client";
    const result = await handler(
      buildWebchatContext("send an email to skl83@cornell.edu", {
        sessionKey: runtimeSessionKey,
        sessionId: "sess-webchat-abc",
      }),
    );
    expect(result.text).toBe("Approval required in Vaultclaw UI. Waiting asynchronously for terminal outcome.");
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0]?.[0]?.sessionKey).toBe(runtimeSessionKey);
    expect(manager.onAfterToolCall).toHaveBeenCalledTimes(1);
    expect(manager.onAfterToolCall.mock.calls[0]?.[1]).toEqual({
      sessionKey: runtimeSessionKey,
      sessionId: "sess-webchat-abc",
      deliverySessionKey: runtimeSessionKey,
      deliverySessionId: "sess-webchat-abc",
      deliveryTargetReason: "runtime_session_key_channel_routable",
      skipInitialRequiredNotification: true,
    });
  });

  it("uses main-fresh execution session for webchat local follow-up delivery", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-webchat-mainfresh-"));
    stateDirs.push(stateDir);

    resolveMock.mockResolvedValue({
      rawEnvelope: {},
      payload: {
        status: "RESOLVED_EXECUTABLE",
        execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
        inputs: {
          subject: "Test",
          text_plain: "Body",
        },
      },
      telemetry: {
        usedGuidance: false,
        guidanceCount: 0,
        askUserCount: 0,
        autoRetryCount: 0,
        autoRetryAttempted: false,
        factTasksStarted: 0,
        factTasksCompleted: 0,
        factTasksFailed: 0,
        factTasksTimedOut: 0,
        elapsedMs: 5,
      },
    });
    executeMock.mockResolvedValue({
      kind: "approval_required",
      toolName: "vaultclaw_plan_execute",
      envelope: { ok: true },
    } as any);

    const manager = {
      onAfterToolCall: vi.fn(),
    };

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: manager as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const runtimeSessionKey = "agent:main:main-fresh-1774139507";
    const result = await handler(
      buildWebchatContext("send an email to skl83@cornell.edu", {
        sessionKey: runtimeSessionKey,
      }),
    );
    expect(result.text).toBe("Approval required in Vaultclaw UI. Waiting asynchronously for terminal outcome.");
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0]?.[0]?.sessionKey).toBe(runtimeSessionKey);
    expect(manager.onAfterToolCall).toHaveBeenCalledTimes(1);
    expect(manager.onAfterToolCall.mock.calls[0]?.[1]).toEqual({
      sessionKey: runtimeSessionKey,
      sessionId: runtimeSessionKey,
      deliverySessionKey: runtimeSessionKey,
      deliverySessionId: runtimeSessionKey,
      deliveryTargetReason: "execution_main_fresh_webchat_local",
      skipInitialRequiredNotification: true,
    });
  });

  it("keeps main-fresh as execution target but routes local main follow-up delivery to agent:main:main", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-main-mainfresh-"));
    stateDirs.push(stateDir);

    resolveMock.mockResolvedValue({
      rawEnvelope: {},
      payload: {
        status: "RESOLVED_EXECUTABLE",
        execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
        inputs: {
          subject: "Test",
          text_plain: "Body",
        },
      },
      telemetry: {
        usedGuidance: false,
        guidanceCount: 0,
        askUserCount: 0,
        autoRetryCount: 0,
        autoRetryAttempted: false,
        factTasksStarted: 0,
        factTasksCompleted: 0,
        factTasksFailed: 0,
        factTasksTimedOut: 0,
        elapsedMs: 5,
      },
    });
    executeMock.mockResolvedValue({
      kind: "approval_required",
      toolName: "vaultclaw_plan_execute",
      envelope: { ok: true },
    } as any);

    const manager = {
      onAfterToolCall: vi.fn(),
    };

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: manager as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const runtimeSessionKey = "agent:main:main-fresh-1774140091";
    const result = await handler({
      ...buildMainContext("send an email to skl83@cornell.edu"),
      sessionKey: runtimeSessionKey,
    });

    expect(result.text).toBe("Approval required in Vaultclaw UI. Waiting asynchronously for terminal outcome.");
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock.mock.calls[0]?.[0]?.sessionKey).toBe(runtimeSessionKey);
    expect(manager.onAfterToolCall).toHaveBeenCalledTimes(1);
    expect(manager.onAfterToolCall.mock.calls[0]?.[1]).toEqual({
      sessionKey: runtimeSessionKey,
      sessionId: runtimeSessionKey,
      deliverySessionKey: "agent:main:main",
      deliverySessionId: "agent:main:main",
      deliveryTargetReason: "route_session_candidate",
      skipInitialRequiredNotification: true,
    });
  });

  it("Case B: enrichment failure path emits interim progress and asks user in HYBRID mode", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-failure-"));
    stateDirs.push(stateDir);

    resolveMock.mockImplementation(async (params: any) => {
      params.onAutoFillStart?.({
        tasks: [{ factKey: "subject", kind: "text" }],
      });
      return {
        rawEnvelope: {},
        payload: {
          status: "RESOLVED_MISSING_INPUTS",
          missing_inputs: ["subject"],
        },
        telemetry: {
          usedGuidance: true,
          guidanceCount: 1,
          askUserCount: 0,
          autoRetryCount: 1,
          autoRetryAttempted: true,
          factTasksStarted: 1,
          factTasksCompleted: 0,
          factTasksFailed: 1,
          factTasksTimedOut: 0,
          retryStatus: "RESOLVED_MISSING_INPUTS",
          fallbackToUserReason: "retry_still_missing_inputs",
          elapsedMs: 10,
        },
      };
    });

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const result = await handler(buildContext("send an email to skl83@cornell.edu with the weather for irvine, ca"));
    expect(notifier.post).toHaveBeenCalledTimes(1);
    expect(notifier.post.mock.calls[0]?.[0]?.text).toBe(
      "I found the Vault action. I am now gathering the missing details and will continue automatically. I am gathering the requested details now.",
    );
    expect(result.text).toBe("I could not get the missing details automatically. Please provide: subject.");
    expect(executeMock).not.toHaveBeenCalled();
    expect(fallbackMock).not.toHaveBeenCalled();
  });

  it("Case B2: enrichment failure path asks user in STRICT mode after auto-enrichment attempt", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-failure-strict-"));
    stateDirs.push(stateDir);

    resolveMock.mockImplementation(async (params: any) => {
      params.onAutoFillStart?.({
        tasks: [{ factKey: "subject", kind: "text" }],
      });
      return {
        rawEnvelope: {},
        payload: {
          status: "RESOLVED_MISSING_INPUTS",
          missing_inputs: ["subject"],
        },
        telemetry: {
          usedGuidance: true,
          guidanceCount: 1,
          askUserCount: 0,
          autoRetryCount: 1,
          autoRetryAttempted: true,
          factTasksStarted: 1,
          factTasksCompleted: 0,
          factTasksFailed: 1,
          factTasksTimedOut: 0,
          retryStatus: "RESOLVED_MISSING_INPUTS",
          fallbackToUserReason: "retry_still_missing_inputs",
          elapsedMs: 10,
        },
      };
    });

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: buildConfig("strict"),
      notifier,
    });

    const result = await handler(buildContext("send an email to skl83@cornell.edu with the weather for irvine, ca"));
    expect(notifier.post).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("I could not get the missing details automatically. Please provide: subject.");
    expect(executeMock).not.toHaveBeenCalled();
    expect(fallbackMock).not.toHaveBeenCalled();
  });

  it("Case C: multiple parallel fact requests emit one interim message and HYBRID asks user for remaining fields", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-parallel-"));
    stateDirs.push(stateDir);

    resolveMock.mockImplementation(async (params: any) => {
      params.onAutoFillStart?.({
        tasks: [
          { factKey: "weather_summary", kind: "weather_forecast" },
          { factKey: "email_body", kind: "text" },
        ],
      });
      return {
        rawEnvelope: {},
        payload: {
          status: "RESOLVED_MISSING_INPUTS",
          missing_inputs: ["subject"],
        },
        telemetry: {
          usedGuidance: true,
          guidanceCount: 2,
          askUserCount: 0,
          autoRetryCount: 2,
          autoRetryAttempted: true,
          factTasksStarted: 2,
          factTasksCompleted: 1,
          factTasksFailed: 1,
          factTasksTimedOut: 0,
          retryStatus: "RESOLVED_MISSING_INPUTS",
          fallbackToUserReason: "retry_still_missing_inputs",
          elapsedMs: 10,
        },
      };
    });
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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const result = await handler(buildContext("send an email"));
    expect(notifier.post).toHaveBeenCalledTimes(1);
    expect(notifier.post.mock.calls[0]?.[0]?.text).toBe(
      "I found the Vault action. I am now gathering the missing details and will continue automatically. I am fetching weather details now.",
    );
    expect(result.text).toBe("I found some of what I need, but I still need one more detail from you: subject.");
    expect(executeMock).not.toHaveBeenCalled();
    expect(fallbackMock).not.toHaveBeenCalled();
  });

  it("Case D: ASK_USER mode does not emit auto-enrichment progress message", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-no-autofill-"));
    stateDirs.push(stateDir);

    resolveMock.mockResolvedValue({
      rawEnvelope: {},
      payload: {
        status: "RESOLVED_MISSING_INPUTS",
        missing_inputs: ["text_plain"],
        progress_hint: {
          mode: "ASK_USER",
        },
      },
      telemetry: {
        usedGuidance: true,
        guidanceCount: 1,
        askUserCount: 1,
        autoRetryCount: 0,
        autoRetryAttempted: false,
        factTasksStarted: 0,
        factTasksCompleted: 0,
        factTasksFailed: 0,
        factTasksTimedOut: 0,
        fallbackToUserReason: "ask_user_guidance_present",
        elapsedMs: 10,
      },
    });

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: buildConfig("hybrid"),
      notifier,
    });

    const result = await handler(buildContext("send an email to skl83@cornell.edu with the weather for irvine, ca"));
    expect(result.text).toBe("I still need one more detail before I can continue: message body. What should I use?");
    expect(notifier.post).not.toHaveBeenCalled();
    expect(fallbackMock).not.toHaveBeenCalled();
  });

  it("Case D2: STRICT mode still asks user when no auto-enrichment attempt is available", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-no-autofill-strict-"));
    stateDirs.push(stateDir);

    resolveMock.mockResolvedValue({
      rawEnvelope: {},
      payload: {
        status: "RESOLVED_MISSING_INPUTS",
        missing_inputs: ["text_plain"],
        progress_hint: {
          mode: "ASK_USER",
        },
      },
      telemetry: {
        usedGuidance: true,
        guidanceCount: 1,
        askUserCount: 1,
        autoRetryCount: 0,
        autoRetryAttempted: false,
        factTasksStarted: 0,
        factTasksCompleted: 0,
        factTasksFailed: 0,
        factTasksTimedOut: 0,
        fallbackToUserReason: "ask_user_guidance_present",
        elapsedMs: 10,
      },
    });

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
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: buildConfig("strict"),
      notifier,
    });

    const result = await handler(buildContext("send an email to skl83@cornell.edu with the weather for irvine, ca"));
    expect(result.text).toBe("I still need one more detail before I can continue: message body. What should I use?");
    expect(notifier.post).not.toHaveBeenCalled();
    expect(fallbackMock).not.toHaveBeenCalled();
  });

  it("emits interim progress via direct channel send when command session key is unavailable", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-direct-send-"));
    stateDirs.push(stateDir);

    resolveMock.mockImplementation(async (params: any) => {
      params.onAutoFillStart?.({
        tasks: [{ factKey: "weather_summary", kind: "weather_forecast" }],
      });
      return {
        rawEnvelope: {},
        payload: {
          status: "RESOLVED_MISSING_INPUTS",
          missing_inputs: ["subject"],
        },
        telemetry: {
          usedGuidance: true,
          guidanceCount: 1,
          askUserCount: 0,
          autoRetryCount: 1,
          autoRetryAttempted: true,
          factTasksStarted: 1,
          factTasksCompleted: 0,
          factTasksFailed: 1,
          factTasksTimedOut: 0,
          retryStatus: "RESOLVED_MISSING_INPUTS",
          fallbackToUserReason: "retry_still_missing_inputs",
          elapsedMs: 10,
        },
      };
    });
    const sendMessageTelegram = vi.fn().mockResolvedValue(undefined);

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
          channel: {
            telegram: {
              sendMessageTelegram,
            },
          },
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: buildConfig("strict"),
      notifier,
    });

    await handler(buildContext("send an email"));
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("509928323");
    expect(sendMessageTelegram.mock.calls[0]?.[1]).toBe(
      "I found the Vault action. I am now gathering the missing details and will continue automatically. I am fetching weather details now.",
    );
    expect(notifier.post).not.toHaveBeenCalled();
  });

  it("prefers sender peer over bot target in direct chats", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-direct-peer-"));
    stateDirs.push(stateDir);

    resolveMock.mockImplementation(async (params: any) => {
      params.onAutoFillStart?.({
        tasks: [{ factKey: "weather_summary", kind: "weather_forecast" }],
      });
      return {
        rawEnvelope: {},
        payload: {
          status: "RESOLVED_MISSING_INPUTS",
          missing_inputs: ["subject"],
        },
        telemetry: {
          usedGuidance: true,
          guidanceCount: 1,
          askUserCount: 0,
          autoRetryCount: 1,
          autoRetryAttempted: true,
          factTasksStarted: 1,
          factTasksCompleted: 0,
          factTasksFailed: 1,
          factTasksTimedOut: 0,
          retryStatus: "RESOLVED_MISSING_INPUTS",
          fallbackToUserReason: "retry_still_missing_inputs",
          elapsedMs: 10,
        },
      };
    });
    const sendMessageTelegram = vi.fn().mockResolvedValue(undefined);

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
          channel: {
            telegram: {
              sendMessageTelegram,
            },
          },
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: buildConfig("strict"),
      notifier,
    });

    await handler({
      ...buildContext("send an email"),
      senderId: "509928323",
      from: "telegram:509928323",
      to: "telegram:BOT_00001",
    } as any);
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("509928323");
  });

  it("targets group/channel peer for interim progress when command runs in a group", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vault-cmd-group-target-"));
    stateDirs.push(stateDir);

    resolveMock.mockImplementation(async (params: any) => {
      params.onAutoFillStart?.({
        tasks: [{ factKey: "weather_summary", kind: "weather_forecast" }],
      });
      return {
        rawEnvelope: {},
        payload: {
          status: "RESOLVED_MISSING_INPUTS",
          missing_inputs: ["subject"],
        },
        telemetry: {
          usedGuidance: true,
          guidanceCount: 1,
          askUserCount: 0,
          autoRetryCount: 1,
          autoRetryAttempted: true,
          factTasksStarted: 1,
          factTasksCompleted: 0,
          factTasksFailed: 1,
          factTasksTimedOut: 0,
          retryStatus: "RESOLVED_MISSING_INPUTS",
          fallbackToUserReason: "retry_still_missing_inputs",
          elapsedMs: 10,
        },
      };
    });
    const sendMessageTelegram = vi.fn().mockResolvedValue(undefined);

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
          channel: {
            telegram: {
              sendMessageTelegram,
            },
          },
          system: {
            runCommandWithTimeout: vi.fn(),
          },
        },
      } as any,
      manager: {
        onAfterToolCall: vi.fn(),
      } as any,
      config: buildConfig("strict"),
      notifier,
    });

    await handler({
      ...buildContext("send an email"),
      senderId: "509928323",
      from: "telegram:509928323",
      to: "group:-1001234567890",
    } as any);
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram.mock.calls[0]?.[0]).toBe("-1001234567890");
  });
});
