import { describe, expect, it, vi } from "vitest";
import type { ResolverPayload } from "../src/vault-resolver-client.js";
import { resolveAndEnrichVaultRoute } from "../src/vault-route-orchestrator.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function missingPayload(params: {
  missingInputs: string[];
  guidance: Array<Record<string, unknown>>;
  progressHintMode?: string;
}): ResolverPayload {
  return {
    status: "RESOLVED_MISSING_INPUTS",
    missing_inputs: params.missingInputs,
    missing_input_guidance: params.guidance as any,
    progress_hint: params.progressHintMode
      ? {
        mode: params.progressHintMode,
      }
      : undefined,
  };
}

describe("resolveAndEnrichVaultRoute", () => {
  it("Gmail weather+attachment: retries once with fetched fact and becomes executable", async () => {
    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["text_plain"],
          progressHintMode: "AUTO_ENRICH_AND_RETRY",
          guidance: [
            {
              input_key: "text_plain",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "weather_summary",
                kind: "weather",
                parallelizable: true,
                batch_group: "gmail_content",
                request_text: "Get weather summary for Irvine, CA",
              },
            },
          ],
        }),
      })
      .mockImplementationOnce(async (params) => {
        const facts = (params.context as Record<string, unknown> | undefined)?.facts as
          | Record<string, unknown>
          | undefined;
        expect(facts?.weather_summary).toBe("Sunny 72F in Irvine");
        return {
          rawEnvelope: {},
          payload: {
            status: "RESOLVED_EXECUTABLE",
            execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
            inputs: { text_plain: "Filled" },
          } satisfies ResolverPayload,
        };
      });

    const resolveFact = vi.fn().mockResolvedValue("Sunny 72F in Irvine");

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "email weather for irvine",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 5000,
      enrichmentTaskTimeoutMs: 2000,
      resolveRoute,
      resolveFact,
    });

    expect(result.payload?.status).toBe("RESOLVED_EXECUTABLE");
    expect(resolveRoute).toHaveBeenCalledTimes(2);
    expect(resolveFact).toHaveBeenCalledTimes(1);
    expect(result.telemetry.autoRetryAttempted).toBe(true);
    expect(result.telemetry.factTasksCompleted).toBe(1);
  });

  it("Gmail subject+body dual enrichment: runs AUTO_RETRY tasks in parallel and retry is executable", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["subject", "text_plain"],
          progressHintMode: "AUTO_ENRICH_AND_RETRY",
          guidance: [
            {
              input_key: "subject",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "email_subject",
                parallelizable: true,
                batch_group: "gmail_dual",
                request_text: "Draft email subject",
              },
            },
            {
              input_key: "text_plain",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "email_body",
                parallelizable: true,
                batch_group: "gmail_dual",
                request_text: "Draft email body",
              },
            },
          ],
        }),
      })
      .mockImplementationOnce(async (params) => {
        const facts = (params.context as Record<string, unknown> | undefined)?.facts as
          | Record<string, unknown>
          | undefined;
        expect(facts?.email_subject).toBe("Weekly weather update");
        expect(facts?.email_body).toBe("It is sunny in Irvine.");
        return {
          rawEnvelope: {},
          payload: {
            status: "RESOLVED_EXECUTABLE",
            execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
          } satisfies ResolverPayload,
        };
      });

    const resolveFact = vi.fn().mockImplementation(async ({ task }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(25);
      inFlight -= 1;
      return task.factKey === "email_subject" ? "Weekly weather update" : "It is sunny in Irvine.";
    });
    const onAutoFillStart = vi.fn();

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "send weather email",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 4000,
      enrichmentTaskTimeoutMs: 2000,
      resolveRoute,
      resolveFact,
      onAutoFillStart,
    });

    expect(result.payload?.status).toBe("RESOLVED_EXECUTABLE");
    expect(maxInFlight).toBeGreaterThan(1);
    expect(result.telemetry.factTasksCompleted).toBe(2);
    expect(onAutoFillStart).toHaveBeenCalledTimes(1);
    expect(onAutoFillStart.mock.calls[0]?.[0]?.tasks).toHaveLength(2);
  });

  it("Generic HTTP missing url: fills AUTO_RETRY fact and retry is executable", async () => {
    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["url"],
          progressHintMode: "AUTO_ENRICH_AND_RETRY",
          guidance: [
            {
              input_key: "url",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "url",
                kind: "http_endpoint",
                parallelizable: true,
                batch_group: "http_core",
                request_text: "Infer API URL from user request",
              },
            },
          ],
        }),
      })
      .mockImplementationOnce(async (params) => {
        const facts = (params.context as Record<string, unknown> | undefined)?.facts as
          | Record<string, unknown>
          | undefined;
        expect(facts?.url).toBe("https://api.example.com/v1/weather");
        return {
          rawEnvelope: {},
          payload: {
            status: "RESOLVED_EXECUTABLE",
            execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
            inputs: { url: "https://api.example.com/v1/weather" },
          } satisfies ResolverPayload,
        };
      });

    const resolveFact = vi.fn().mockResolvedValue("https://api.example.com/v1/weather");

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "call weather API",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 5000,
      enrichmentTaskTimeoutMs: 2000,
      resolveRoute,
      resolveFact,
    });

    expect(result.payload?.status).toBe("RESOLVED_EXECUTABLE");
    expect(result.telemetry.factTasksCompleted).toBe(1);
  });

  it("Mixed guidance (AUTO_RETRY + ASK_USER): asks user and does not auto-run facts", async () => {
    const resolveRoute = vi.fn().mockResolvedValue({
      rawEnvelope: {},
      payload: missingPayload({
        missingInputs: ["url", "api_key"],
        guidance: [
          {
            input_key: "url",
            resolution_mode: "AUTO_RETRY_WITH_FACTS",
            external_fact_request: {
              fact_key: "url",
              parallelizable: true,
              batch_group: "http_core",
              request_text: "Infer URL",
            },
          },
          {
            input_key: "api_key",
            resolution_mode: "ASK_USER",
          },
        ],
      }),
    });
    const resolveFact = vi.fn();

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "POST request with my key",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 5000,
      enrichmentTaskTimeoutMs: 2000,
      resolveRoute,
      resolveFact,
    });

    expect(result.payload?.status).toBe("RESOLVED_MISSING_INPUTS");
    expect(result.telemetry.fallbackToUserReason).toBe("ask_user_guidance_present");
    expect(result.telemetry.autoRetryAttempted).toBe(false);
    expect(resolveRoute).toHaveBeenCalledTimes(1);
    expect(resolveFact).not.toHaveBeenCalled();
  });

  it("Partial auto-enrich mode: runs AUTO_RETRY tasks even when ASK_USER guidance is present", async () => {
    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["url", "api_key"],
          progressHintMode: "PARTIAL_AUTO_ENRICH_THEN_ASK_USER",
          guidance: [
            {
              input_key: "url",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "url",
                parallelizable: true,
                batch_group: "http_core",
                request_text: "Infer URL",
              },
            },
            {
              input_key: "api_key",
              resolution_mode: "ASK_USER",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["api_key"],
          progressHintMode: "ASK_USER",
          guidance: [
            {
              input_key: "api_key",
              resolution_mode: "ASK_USER",
            },
          ],
        }),
      });

    const resolveFact = vi.fn().mockResolvedValue("https://api.example.com");
    const onAutoFillStart = vi.fn();

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "call API with key",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 5000,
      enrichmentTaskTimeoutMs: 2000,
      resolveRoute,
      resolveFact,
      onAutoFillStart,
    });

    expect(result.payload?.status).toBe("RESOLVED_MISSING_INPUTS");
    expect(result.payload?.missing_inputs).toEqual(["api_key"]);
    expect(resolveRoute).toHaveBeenCalledTimes(2);
    expect(resolveFact).toHaveBeenCalledTimes(1);
    expect(onAutoFillStart).toHaveBeenCalledTimes(1);
  });

  it("ASK_USER mode: does not start auto-enrichment tasks", async () => {
    const resolveRoute = vi.fn().mockResolvedValue({
      rawEnvelope: {},
      payload: missingPayload({
        missingInputs: ["url", "api_key"],
        progressHintMode: "ASK_USER",
        guidance: [
          {
            input_key: "url",
            resolution_mode: "AUTO_RETRY_WITH_FACTS",
            external_fact_request: {
              fact_key: "url",
              parallelizable: true,
              batch_group: "http_core",
              request_text: "Infer URL",
            },
          },
          {
            input_key: "api_key",
            resolution_mode: "ASK_USER",
          },
        ],
      }),
    });
    const resolveFact = vi.fn();
    const onAutoFillStart = vi.fn();

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "POST request with my key",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 5000,
      enrichmentTaskTimeoutMs: 2000,
      resolveRoute,
      resolveFact,
      onAutoFillStart,
    });

    expect(result.payload?.status).toBe("RESOLVED_MISSING_INPUTS");
    expect(resolveRoute).toHaveBeenCalledTimes(1);
    expect(resolveFact).not.toHaveBeenCalled();
    expect(onAutoFillStart).not.toHaveBeenCalled();
  });

  it("ASK_USER missing subject: performs one synthetic subject enrichment retry before asking user", async () => {
    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["subject"],
          progressHintMode: "ASK_USER",
          guidance: [
            {
              input_key: "subject",
              resolution_mode: "ASK_USER",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: {
          status: "RESOLVED_EXECUTABLE",
          execution: { strategy: "CONNECTOR_EXECUTE_JOB" },
          inputs: {
            subject: "bouzeron",
          },
        } satisfies ResolverPayload,
      });

    const resolveFact = vi.fn().mockResolvedValue("bouzeron");
    const onAutoFillStart = vi.fn();

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "send an email explaining bouzeron aligote",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 5000,
      enrichmentTaskTimeoutMs: 2000,
      resolveRoute,
      resolveFact,
      onAutoFillStart,
    });

    expect(result.payload?.status).toBe("RESOLVED_EXECUTABLE");
    expect(resolveRoute).toHaveBeenCalledTimes(2);
    expect(resolveFact).toHaveBeenCalledTimes(1);
    expect(result.telemetry.autoRetryAttempted).toBe(true);
    expect(result.telemetry.factTasksStarted).toBe(1);
    expect(result.telemetry.factTasksCompleted).toBe(1);
    expect(onAutoFillStart).toHaveBeenCalledTimes(1);
  });

  it("Timeout/partial failure: retries with partial facts and leaves unresolved fields for user", async () => {
    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["email_subject", "email_body", "weather_summary"],
          guidance: [
            {
              input_key: "subject",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "email_subject",
                parallelizable: true,
                batch_group: "gmail_triplet",
                request_text: "Create subject",
              },
            },
            {
              input_key: "text_plain",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "email_body",
                parallelizable: true,
                batch_group: "gmail_triplet",
                request_text: "Create body",
              },
            },
            {
              input_key: "weather_summary",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "weather_summary",
                parallelizable: true,
                batch_group: "gmail_triplet",
                request_text: "Get weather",
              },
            },
          ],
        }),
      })
      .mockImplementationOnce(async (params) => {
        const facts = (params.context as Record<string, unknown> | undefined)?.facts as
          | Record<string, unknown>
          | undefined;
        expect(facts?.email_subject).toBe("Subject");
        expect(facts?.weather_summary).toBe("Sunny");
        expect(facts?.email_body).toBeUndefined();
        return {
          rawEnvelope: {},
          payload: missingPayload({
            missingInputs: ["email_body"],
            guidance: [
              {
                input_key: "text_plain",
                resolution_mode: "ASK_USER",
              },
            ],
          }),
        };
      });

    const resolveFact = vi.fn().mockImplementation(async ({ task }) => {
      if (task.factKey === "email_subject") {
        return "Subject";
      }
      if (task.factKey === "weather_summary") {
        return "Sunny";
      }
      await sleep(120);
      return "Late body";
    });

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "email the weather",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 600,
      enrichmentTaskTimeoutMs: 40,
      resolveRoute,
      resolveFact,
    });

    expect(result.payload?.status).toBe("RESOLVED_MISSING_INPUTS");
    expect(result.payload?.missing_inputs).toEqual(["email_body"]);
    expect(result.telemetry.factTasksCompleted).toBe(2);
    expect(result.telemetry.factTasksTimedOut).toBe(1);
    expect(result.telemetry.fallbackToUserReason).toBe("retry_still_missing_inputs");
  });

  it("Safety: performs at most one AUTO_RETRY route-resolve retry", async () => {
    const resolveRoute = vi
      .fn()
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["url"],
          guidance: [
            {
              input_key: "url",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "url",
                parallelizable: true,
                batch_group: "http_only",
                request_text: "Infer URL",
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        rawEnvelope: {},
        payload: missingPayload({
          missingInputs: ["url"],
          guidance: [
            {
              input_key: "url",
              resolution_mode: "AUTO_RETRY_WITH_FACTS",
              external_fact_request: {
                fact_key: "url",
                parallelizable: true,
                batch_group: "http_only",
                request_text: "Infer URL",
              },
            },
          ],
        }),
      });

    const resolveFact = vi.fn().mockResolvedValue("https://still-not-accepted.example.com");

    const result = await resolveAndEnrichVaultRoute({
      config: {} as any,
      resolverTool: "vaultclaw_route_resolve",
      requestText: "call API",
      resolverTimeoutMs: 3000,
      sessionKey: "main",
      enrichmentGlobalTimeoutMs: 5000,
      enrichmentTaskTimeoutMs: 1500,
      resolveRoute,
      resolveFact,
    });

    expect(result.payload?.status).toBe("RESOLVED_MISSING_INPUTS");
    expect(resolveRoute).toHaveBeenCalledTimes(2);
    expect(result.telemetry.autoRetryAttempted).toBe(true);
    expect(result.telemetry.retryStatus).toBe("RESOLVED_MISSING_INPUTS");
  });
});
