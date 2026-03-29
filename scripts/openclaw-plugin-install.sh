#!/usr/bin/env sh
set -eu

BRIDGE_PLUGIN_ID="vaultclaw-openclaw-bridge"
HANDOFF_PLUGIN_ID="vaultclaw-mcp-approval-handoff"

BRIDGE_SPEC="${BRIDGE_SPEC:-@vaultclaw/vaultclaw-openclaw-bridge@0.1.1}"
HANDOFF_SPEC="${HANDOFF_SPEC:-@vaultclaw/vaultclaw-mcp-approval-handoff@0.1.10}"
MCP_BIN="${MCP_BIN:-$HOME/.openclaw/bin/accords-mcp}"
HANDOFF_EXT_DIR="${HOME}/.openclaw/extensions/${HANDOFF_PLUGIN_ID}"
HANDOFF_PATCH_SCRIPT="${HANDOFF_PATCH_SCRIPT:-${HANDOFF_EXT_DIR}/scripts/patch-openclaw-core.mjs}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: missing required command: $1" >&2
    exit 1
  }
}

uninstall_if_present() {
  plugin_id="$1"
  if openclaw plugins info "$plugin_id" >/dev/null 2>&1; then
    echo "Existing plugin detected, uninstalling: $plugin_id"
    openclaw plugins uninstall "$plugin_id" --force || true
  fi
}

remove_stale_extension_dir() {
  plugin_id="$1"
  ext_dir="${HOME}/.openclaw/extensions/${plugin_id}"
  if [ -d "$ext_dir" ]; then
    echo "Removing stale extension directory: $ext_dir"
    rm -rf "$ext_dir"
  fi
}

echo "Installing OpenClaw Vaultclaw plugins..."
need_cmd openclaw
need_cmd node

if [ ! -x "$MCP_BIN" ]; then
  echo "error: MCP binary not found or not executable: $MCP_BIN" >&2
  exit 1
fi

echo "Installing bridge plugin from: $BRIDGE_SPEC"
uninstall_if_present "$BRIDGE_PLUGIN_ID"
remove_stale_extension_dir "$BRIDGE_PLUGIN_ID"
openclaw plugins install "$BRIDGE_SPEC"
openclaw plugins enable "$BRIDGE_PLUGIN_ID" || true
openclaw config set "plugins.entries.$BRIDGE_PLUGIN_ID.config.command" "$MCP_BIN"

echo "Installing handoff plugin from: $HANDOFF_SPEC"
uninstall_if_present "$HANDOFF_PLUGIN_ID"
remove_stale_extension_dir "$HANDOFF_PLUGIN_ID"
openclaw plugins install "$HANDOFF_SPEC"
openclaw plugins enable "$HANDOFF_PLUGIN_ID" || true

openclaw config set "plugins.entries.$HANDOFF_PLUGIN_ID.config.enabled" true
openclaw config set "plugins.entries.$HANDOFF_PLUGIN_ID.config.pollIntervalMs" 1500
openclaw config set "plugins.entries.$HANDOFF_PLUGIN_ID.config.maxWaitMs" 600000
openclaw config set "plugins.entries.$HANDOFF_PLUGIN_ID.config.commandTimeoutMs" 720000
openclaw config set "plugins.entries.$HANDOFF_PLUGIN_ID.config.maxConcurrentWaits" 10

if [ ! -f "$HANDOFF_PATCH_SCRIPT" ]; then
  echo "error: expected patch script not found: $HANDOFF_PATCH_SCRIPT" >&2
  exit 1
fi
echo "Applying OpenClaw core patch for Telegram plugin command stability..."
node "$HANDOFF_PATCH_SCRIPT"

echo "Restarting OpenClaw gateway to apply plugin + core patch updates..."
if ! openclaw gateway restart; then
  echo "Gateway restart failed; attempting install/start recovery..."
  openclaw gateway install --json >/dev/null 2>&1 || true
  openclaw gateway start >/dev/null 2>&1 || true
fi

if openclaw gateway health >/dev/null 2>&1; then
  echo "Gateway health check: OK"
else
  echo "Gateway health check could not be confirmed. Run: openclaw gateway status"
fi

echo "Plugin install complete."
echo "Bridge plugin: $BRIDGE_PLUGIN_ID ($BRIDGE_SPEC)"
echo "Handoff plugin: $HANDOFF_PLUGIN_ID ($HANDOFF_SPEC)"
