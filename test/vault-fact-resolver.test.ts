import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFactWithScopedProviders } from "../src/vault-fact-resolver.js";

const TEST_CONFIG = {
  gateway: {
    bind: "loopback",
    port: 18789,
    auth: {
      mode: "none",
    },
  },
} as any;

describe("resolveFactWithScopedProviders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves weather_forecast facts with Open-Meteo data", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                name: "Irvine",
                admin1: "California",
                country_code: "US",
                latitude: 33.6846,
                longitude: -117.8265,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            current: {
              temperature_2m: 73.2,
              weather_code: 1,
            },
            daily: {
              weather_code: [0, 3],
              temperature_2m_max: [76.0, 72.0],
              temperature_2m_min: [59.0, 55.0],
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const value = await resolveFactWithScopedProviders({
      config: TEST_CONFIG,
      task: {
        factKey: "weather_summary",
        kind: "weather_forecast",
        requestText: "weather in irvine tomorrow",
        rawRequest: {
          location: "Irvine, California",
          timeframe: "tomorrow",
        },
      },
      timeoutMs: 5000,
      signal: new AbortController().signal,
    });

    expect(typeof value).toBe("string");
    expect(String(value)).toContain("Tomorrow in Irvine");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses /v1/responses with tool_choice=none for safe text fact generation", async () => {
    const onResolutionEvent = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "{\"email_body\":\"Hi there.\"}",
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const value = await resolveFactWithScopedProviders({
      config: TEST_CONFIG,
      sessionKey: "agent:main:webchat:direct:user1",
      task: {
        factKey: "email_body",
        kind: "email_body_generation",
        requestText: "send an email saying hi",
        rawRequest: {},
      },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      onResolutionEvent,
    });

    expect(value).toBe("Hi there.");
    expect(onResolutionEvent).toHaveBeenCalledWith("safe_text_primary_used");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/v1/responses");
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as Record<string, unknown>;
    expect(body.tool_choice).toBe("none");
    expect(JSON.stringify(body)).not.toContain("sessions_send");
  });

  it("falls back to /v1/chat/completions when /v1/responses is unavailable", async () => {
    const onResolutionEvent = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "Not Found",
            },
          }),
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "{\"email_subject\":\"Hello\"}",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const value = await resolveFactWithScopedProviders({
      config: TEST_CONFIG,
      sessionKey: "agent:main:webchat:direct:user1",
      task: {
        factKey: "email_subject",
        kind: "email_subject_generation",
        requestText: "send an email saying hello",
        rawRequest: {},
      },
      timeoutMs: 4000,
      signal: new AbortController().signal,
      onResolutionEvent,
    });

    expect(value).toBe("Hello");
    expect(onResolutionEvent).toHaveBeenCalledWith("safe_text_fallback_used");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstURL = String(fetchMock.mock.calls[0]?.[0] ?? "");
    const secondURL = String(fetchMock.mock.calls[1]?.[0] ?? "");
    expect(firstURL).toContain("/v1/responses");
    expect(secondURL).toContain("/v1/chat/completions");
  });

  it("supports generic text_field_generation fact kinds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "{\"custom_message\":\"Hello from generic text.\"}",
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const value = await resolveFactWithScopedProviders({
      config: TEST_CONFIG,
      sessionKey: "agent:main:webchat:direct:user1",
      task: {
        factKey: "custom_message",
        kind: "text_field_generation",
        requestText: "generate a short custom message",
        rawRequest: {},
      },
      timeoutMs: 3000,
      signal: new AbortController().signal,
    });

    expect(value).toBe("Hello from generic text.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("/v1/responses");
  });

  it("retries transient /v1/responses failures before succeeding", async () => {
    const onResolutionEvent = vi.fn();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "{\"email_body\":\"Retry succeeded.\"}",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const value = await resolveFactWithScopedProviders({
      config: TEST_CONFIG,
      sessionKey: "agent:main:webchat:direct:user1",
      task: {
        factKey: "email_body",
        kind: "email_body_generation",
        requestText: "send an email saying hi",
        rawRequest: {},
      },
      timeoutMs: 5000,
      signal: new AbortController().signal,
      onResolutionEvent,
    });

    expect(value).toBe("Retry succeeded.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onResolutionEvent).toHaveBeenCalledWith("safe_text_primary_used");
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("/v1/responses");
    expect(String(fetchMock.mock.calls[1]?.[0] ?? "")).toContain("/v1/responses");
  });

  it("retries transient fallback completion failure after /v1/responses unavailability", async () => {
    const onResolutionEvent = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "Not Found",
            },
          }),
          { status: 404 },
        ),
      )
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "{\"email_subject\":\"Hello after retry\"}",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const value = await resolveFactWithScopedProviders({
      config: TEST_CONFIG,
      sessionKey: "agent:main:webchat:direct:user1",
      task: {
        factKey: "email_subject",
        kind: "email_subject_generation",
        requestText: "send an email saying hello",
        rawRequest: {},
      },
      timeoutMs: 4000,
      signal: new AbortController().signal,
      onResolutionEvent,
    });

    expect(value).toBe("Hello after retry");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onResolutionEvent).toHaveBeenCalledWith("safe_text_fallback_used");
    expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("/v1/responses");
    expect(String(fetchMock.mock.calls[1]?.[0] ?? "")).toContain("/v1/chat/completions");
    expect(String(fetchMock.mock.calls[2]?.[0] ?? "")).toContain("/v1/chat/completions");
  });

  it("asks user when fallback safe text output is malformed JSON", async () => {
    const onResolutionEvent = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "Not Found",
            },
          }),
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Just say hi.",
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveFactWithScopedProviders({
        config: TEST_CONFIG,
        sessionKey: "agent:main:webchat:direct:user1",
        task: {
          factKey: "email_body",
          kind: "email_body_generation",
          requestText: "send an email saying hi",
          rawRequest: {},
        },
        timeoutMs: 4000,
        signal: new AbortController().signal,
        onResolutionEvent,
      }),
    ).rejects.toMatchObject({
      reasonCode: "safe_text_unavailable",
    });
    expect(onResolutionEvent).toHaveBeenCalledWith("safe_text_fallback_failed");
  });

  it("returns deterministic URL for connector_input_generation only when explicit URL exists", async () => {
    const value = await resolveFactWithScopedProviders({
      config: TEST_CONFIG,
      task: {
        factKey: "url",
        kind: "connector_input_generation",
        requestText: "call https://api.example.com/weather now",
        rawRequest: {},
      },
      timeoutMs: 1000,
      signal: new AbortController().signal,
    });
    expect(value).toBe("https://api.example.com/weather");
  });

  it("fails unsupported fact kinds with structured reason", async () => {
    await expect(
      resolveFactWithScopedProviders({
        config: TEST_CONFIG,
        task: {
          factKey: "api_key",
          kind: "connector_input_generation",
          requestText: "call partner endpoint",
          rawRequest: {},
        },
        timeoutMs: 1000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      reasonCode: "unsupported_fact_kind",
    });
  });
});
