import type { CorrelationKeys, StructuredLogger } from "./types.js";

export function logStructured(params: {
  logger: StructuredLogger;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  correlation?: CorrelationKeys;
  extra?: Record<string, unknown>;
}) {
  const payload = {
    event: params.event,
    correlation: params.correlation ?? {},
    ...(params.extra ?? {}),
  };
  const line = `[vaultclaw-approval-handoff] ${JSON.stringify(payload)}`;
  if (params.level === "debug") {
    params.logger.debug?.(line);
    return;
  }
  params.logger[params.level](line);
}
