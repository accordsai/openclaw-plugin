export type ResolvedSessionContext = {
  sessionKey?: string;
  sessionId?: string;
};

export function resolveSessionContext(ctx: unknown): ResolvedSessionContext {
  const record = (ctx ?? {}) as Record<string, unknown>;
  const rawSessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
  const rawSessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";

  const sessionKey = rawSessionKey || (rawSessionId.startsWith("agent:") ? rawSessionId : undefined);
  const sessionId = rawSessionId || sessionKey;

  return {
    sessionKey: sessionKey || undefined,
    sessionId: sessionId || undefined,
  };
}

export function extractToolResultToolName(params: {
  event: unknown;
  message: unknown;
  fallback: string;
}): string {
  const eventRecord = (params.event ?? {}) as Record<string, unknown>;
  const messageRecord = (params.message ?? {}) as Record<string, unknown>;
  const fromEvent = typeof eventRecord.toolName === "string" ? eventRecord.toolName.trim() : "";
  if (fromEvent) {
    return fromEvent;
  }
  const fromMessage = typeof messageRecord.toolName === "string" ? messageRecord.toolName.trim() : "";
  if (fromMessage) {
    return fromMessage;
  }
  return params.fallback;
}
