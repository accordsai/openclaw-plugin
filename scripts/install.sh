#!/usr/bin/env sh
set -eu

PLUGIN_ID="vaultclaw-mcp-approval-handoff"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="${HOME}/.openclaw/extensions/${PLUGIN_ID}"

SPEC="${1:-$ROOT_DIR}"

echo "Installing plugin from: $SPEC"
if openclaw plugins info "$PLUGIN_ID" >/dev/null 2>&1; then
  echo "Existing plugin detected, uninstalling old copy..."
  openclaw plugins uninstall "$PLUGIN_ID" --force || true
fi
if [ -d "$EXT_DIR" ]; then
  echo "Removing stale extension directory: $EXT_DIR"
  rm -rf "$EXT_DIR"
fi

openclaw plugins install "$SPEC"
openclaw plugins enable "$PLUGIN_ID" || true

openclaw config set "plugins.entries.$PLUGIN_ID.config.enabled" true
openclaw config set "plugins.entries.$PLUGIN_ID.config.pollIntervalMs" 1500
openclaw config set "plugins.entries.$PLUGIN_ID.config.maxWaitMs" 600000
openclaw config set "plugins.entries.$PLUGIN_ID.config.commandTimeoutMs" 720000
openclaw config set "plugins.entries.$PLUGIN_ID.config.maxConcurrentWaits" 10

echo "Plugin installed and configured: $PLUGIN_ID"
echo "Restart the gateway to apply config if it is already running: openclaw gateway restart"
