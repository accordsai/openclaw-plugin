import { describe, expect, it } from "vitest";
import { retryWithBackoff } from "../src/backoff.js";

describe("retryWithBackoff", () => {
  it("retries with exponential delays", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await retryWithBackoff({
      run: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`fail-${attempts}`);
        }
        return "ok";
      },
      shouldRetry: () => true,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("stops when shouldRetry returns false", async () => {
    await expect(
      retryWithBackoff({
        run: async () => {
          throw new Error("boom");
        },
        shouldRetry: () => false,
      }),
    ).rejects.toThrow("boom");
  });
});
