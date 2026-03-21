import type { StructuredLogger } from "./types.js";
import { logStructured } from "./logging.js";

export function logVaultMetric(params: {
  logger: StructuredLogger;
  event: string;
  routeKey?: string;
  level?: "debug" | "info" | "warn" | "error";
  extra?: Record<string, unknown>;
}) {
  logStructured({
    logger: params.logger,
    level: params.level ?? "info",
    event: params.event,
    correlation: {
      session_id: params.routeKey,
    },
    extra: params.extra,
  });
}
