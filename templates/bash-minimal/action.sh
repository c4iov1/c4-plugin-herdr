#!/usr/bin/env bash
set -euo pipefail

# 1. Resolve Herdr CLI binary
HERDR="${HERDR_BIN_PATH:-herdr}"

echo "🚀 Running c4.template-bash action..."
echo "Plugin ID: ${HERDR_PLUGIN_ID:-unknown}"
echo "Current Workspace ID: ${HERDR_WORKSPACE_ID:-none}"
echo "Config Directory: ${HERDR_PLUGIN_CONFIG_DIR:-none}"
echo "State Directory: ${HERDR_PLUGIN_STATE_DIR:-none}"

# 2. Invoke Herdr CLI safely
echo "Querying active workspaces from Herdr..."
"$HERDR" workspace list || true

echo "✅ Action completed successfully."
