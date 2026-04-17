import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeGatewayOpenResponse } from "../src/vault-gateway-client.js";

const TOKEN_CONFIG = {
  gateway: {
    bind: "loopback",
    port: 18789,
    auth: {
      mode: "token",
      token: "test-token",
    },
  },
} as any;

describe("invokeGatewayOpenResponse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns parsed body on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: [],
            id: "resp_1",
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await invokeGatewayOpenResponse({
      config: TOKEN_CONFIG,
      body: {
        model: "agent:main",
        input: "hello",
        stream: false,
      },
      timeoutMs: 1000,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.id).toBe("resp_1");
  });

  it("maps disabled endpoint responses to RESPONSES_ENDPOINT_UNAVAILABLE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "Not Found",
            },
          }),
          { status: 404 },
        ),
      ),
    );

    await expect(
      invokeGatewayOpenResponse({
        config: TOKEN_CONFIG,
        body: {
          model: "agent:main",
          input: "hello",
        },
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      code: "RESPONSES_ENDPOINT_UNAVAILABLE",
    });
  });

  it("maps auth failures to auth category", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "AUTH_ERROR",
              message: "unauthorized",
            },
          }),
          { status: 401 },
        ),
      ),
    );

    await expect(
      invokeGatewayOpenResponse({
        config: TOKEN_CONFIG,
        body: {
          model: "agent:main",
          input: "hello",
        },
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      category: "auth",
    });
  });

  it("maps request timeout to COMMAND_TIMEOUT", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new Error("AbortError"));
            });
          }
        })),
    );

    await expect(
      invokeGatewayOpenResponse({
        config: TOKEN_CONFIG,
        body: {
          model: "agent:main",
          input: "hello",
        },
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({
      code: "COMMAND_TIMEOUT",
    });
  });
});
