import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export type VaultPluginCommandHandler = Parameters<OpenClawPluginApi["registerCommand"]>[0]["handler"];
export type VaultPluginCommandContext = Parameters<VaultPluginCommandHandler>[0];
