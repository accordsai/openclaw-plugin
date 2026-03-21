import type { VaultPluginCommandContext } from "./vault-command-types.js";

export type VaultRouteContext = {
  key: string;
  sessionCandidates: string[];
};

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
  const account = params.accountId?.trim();
  if (account) {
    return `agent:main:${channel}:${account}:direct:${params.peerId}`;
  }
  return `agent:main:${channel}:direct:${params.peerId}`;
}

export function buildVaultRouteContext(ctx: VaultPluginCommandContext): VaultRouteContext {
  const channel = compact(ctx.channel.toLowerCase());
  const account = compact(ctx.accountId);
  const sender = compact(ctx.senderId ?? parsePeerFromAddress(ctx.from, ctx.channel) ?? parsePeerFromAddress(ctx.to, ctx.channel));
  const thread = typeof ctx.messageThreadId === "number" ? String(ctx.messageThreadId) : "-";

  const key = `vault:${channel}:${account}:${sender}:${thread}`;

  const rawAgentCandidates = unique([
    typeof ctx.from === "string" && ctx.from.trim().startsWith("agent:") ? ctx.from.trim() : undefined,
    typeof ctx.to === "string" && ctx.to.trim().startsWith("agent:") ? ctx.to.trim() : undefined,
  ]);

  const senderPeer = ctx.senderId?.trim() || undefined;
  const fromPeer = parsePeerFromAddress(ctx.from, ctx.channel);
  const toPeer = parsePeerFromAddress(ctx.to, ctx.channel);
  const peer =
    (isGroupOrChannelAddress(ctx.to) ? toPeer : undefined) ??
    (isGroupOrChannelAddress(ctx.from) ? fromPeer : undefined) ??
    senderPeer ??
    fromPeer ??
    toPeer;

  const channelCandidates = peer
    ? unique([
      buildChannelSessionKey({ channel: ctx.channel, accountId: ctx.accountId, peerId: peer }),
      buildChannelSessionKey({ channel: ctx.channel, peerId: peer }),
    ])
    : [];

  const sessionCandidates = unique([...channelCandidates, ...rawAgentCandidates]);
  return { key, sessionCandidates };
}
