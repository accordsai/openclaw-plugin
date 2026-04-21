import type { VaultPluginCommandContext } from "./vault-command-types.js";

export type VaultRouteContext = {
  key: string;
  sessionCandidates: string[];
};

const LOCAL_SURFACES = new Set(["main", "tui", "cli", "terminal", "console"]);

function compact(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "-";
  }
  return trimmed.replace(/\s+/g, "_");
}

function parsePeerFromAddress(value: string | undefined, channel: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  const lowerChannel = channel.trim().toLowerCase();
  const prefix = `${lowerChannel}:`;
  if (trimmed.toLowerCase().startsWith(prefix)) {
    const peer = trimmed.slice(prefix.length).trim();
    return peer.length > 0 ? peer : undefined;
  }
  const groupMatch = trimmed.match(/^(?:group|channel):(.+)$/i);
  if (groupMatch?.[1]) {
    return groupMatch[1].trim();
  }
  return trimmed;
}

function readAgentSessionKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  return trimmed;
}

function parsePeerFromAgentSessionKey(value: string | undefined, channel: string): string | undefined {
  const sessionKey = readAgentSessionKey(value);
  if (!sessionKey) {
    return undefined;
  }
  const normalizedChannel = channel.trim().toLowerCase();
  const parts = sessionKey.split(":").filter((entry) => entry.length > 0);
  if (parts.length < 5 || parts[0]?.toLowerCase() !== "agent") {
    return undefined;
  }
  if (parts[2]?.toLowerCase() !== normalizedChannel) {
    return undefined;
  }
  const directIndex = parts.findIndex((entry, index) => index >= 3 && entry.toLowerCase() === "direct");
  if (directIndex < 0 || directIndex + 1 >= parts.length) {
    return undefined;
  }
  const peer = parts.slice(directIndex + 1).join(":").trim();
  return peer.length > 0 ? peer : undefined;
}

function isGroupOrChannelAddress(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^(group|channel):/i.test(value.trim());
}

function unique(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function buildChannelSessionKey(params: {
  channel: string;
  accountId?: string;
  peerId: string;
}): string {
  const channel = params.channel.trim().toLowerCase();
  if (LOCAL_SURFACES.has(channel)) {
    return "agent:main:main";
  }
  const account = params.accountId?.trim();
  if (account) {
    return `agent:main:${channel}:${account}:direct:${params.peerId}`;
  }
  return `agent:main:${channel}:direct:${params.peerId}`;
}

export function buildVaultRouteContext(ctx: VaultPluginCommandContext): VaultRouteContext {
  const normalizedChannel = ctx.channel.trim().toLowerCase();
  const sessionKeyCandidate = readAgentSessionKey(ctx.sessionKey);
  const sessionIDCandidate = readAgentSessionKey(ctx.sessionId);
  const sessionPeer = parsePeerFromAgentSessionKey(sessionKeyCandidate ?? sessionIDCandidate, ctx.channel);
  const preferredSessionPeer = normalizedChannel === "webchat" ? sessionPeer : undefined;
  const channel = compact(normalizedChannel);
  const account = compact(ctx.accountId);
  const keySender =
    preferredSessionPeer ??
    ctx.senderId ??
    parsePeerFromAddress(ctx.from, ctx.channel) ??
    parsePeerFromAddress(ctx.to, ctx.channel) ??
    sessionPeer;
  const sender = compact(
    keySender,
  );
  const thread = typeof ctx.messageThreadId === "number" ? String(ctx.messageThreadId) : "-";

  const key = `vault:${channel}:${account}:${sender}:${thread}`;

  const rawAgentCandidates = unique([
    sessionKeyCandidate,
    sessionIDCandidate,
    typeof ctx.from === "string" && ctx.from.trim().startsWith("agent:") ? ctx.from.trim() : undefined,
    typeof ctx.to === "string" && ctx.to.trim().startsWith("agent:") ? ctx.to.trim() : undefined,
  ]);

  const senderPeer = ctx.senderId?.trim() || undefined;
  const fromPeer = parsePeerFromAddress(ctx.from, ctx.channel);
  const toPeer = parsePeerFromAddress(ctx.to, ctx.channel);
  const peer =
    (isGroupOrChannelAddress(ctx.to) ? toPeer : undefined) ??
    (isGroupOrChannelAddress(ctx.from) ? fromPeer : undefined) ??
    preferredSessionPeer ??
    senderPeer ??
    fromPeer ??
    toPeer ??
    sessionPeer;

  const senderFallbackPeer = sender !== "-" ? sender : undefined;
  const candidatePeer = peer ?? senderFallbackPeer;
  const localSurfaceCandidate = LOCAL_SURFACES.has(normalizedChannel) ? "agent:main:main" : undefined;
  const channelCandidates = candidatePeer
    ? unique([
      localSurfaceCandidate,
      buildChannelSessionKey({ channel: ctx.channel, accountId: ctx.accountId, peerId: candidatePeer }),
      buildChannelSessionKey({ channel: ctx.channel, peerId: candidatePeer }),
    ])
    : unique([localSurfaceCandidate]);

  const sessionCandidates = unique([...channelCandidates, ...rawAgentCandidates]);
  return { key, sessionCandidates };
}
