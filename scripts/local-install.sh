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

echo "Applying OpenClaw core patch for Telegram plugin command stability..."
node "$SCRIPT_DIR/patch-openclaw-core.mjs"

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

echo "Plugin installed and configured: $PLUGIN_ID"
echo "Install complete."
