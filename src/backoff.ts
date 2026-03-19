export const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;

export async function retryWithBackoff<T>(params: {
  maxAttempts?: number;
  backoffMs?: readonly number[];
  run: (attempt: number) => Promise<T>;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (error: unknown, nextAttempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const maxAttempts = params.maxAttempts ?? 5;
  const backoffMs = params.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep =
    params.sleep ??
    (async (ms: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    });

  let attempt = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await params.run(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !params.shouldRetry(error)) {
        throw error;
      }
      const delayMs = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 1000;
      params.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
