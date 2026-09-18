#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "Usage: $0 <plugin-name> [template]"
  echo ""
  echo "Arguments:"
  echo "  plugin-name   Directory name for the new plugin under plugins/"
  echo "  template      Template to use (default: node-basic)"
  echo ""
  echo "Available templates:"
  ls -1 "$REPO_ROOT/templates"
  exit 1
}

if [ $# -lt 1 ]; then
  usage
fi

PLUGIN_NAME="$1"
TEMPLATE="${2:-node-basic}"

TEMPLATE_DIR="$REPO_ROOT/templates/$TEMPLATE"
TARGET_DIR="$REPO_ROOT/plugins/$PLUGIN_NAME"

if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "❌ Error: Template '$TEMPLATE' does not exist in $REPO_ROOT/templates"
  exit 1
fi

if [ -d "$TARGET_DIR" ]; then
  echo "❌ Error: Target plugin directory '$TARGET_DIR' already exists."
  exit 1
fi

echo "📦 Creating plugin '$PLUGIN_NAME' from template '$TEMPLATE'..."
mkdir -p "$TARGET_DIR"
cp -R "$TEMPLATE_DIR/"* "$TARGET_DIR/"

# Update plugin ID and title in herdr-plugin.toml
MANIFEST="$TARGET_DIR/herdr-plugin.toml"
if [ -f "$MANIFEST" ]; then
  PLUGIN_ID="c4.$PLUGIN_NAME"
  HUMAN_NAME="$(echo "$PLUGIN_NAME" | awk -F'[-_]' '{for(i=1;i<=NF;i++)sub(/./,toupper(substr($i,1,1)),$i)}1')"

  # Replace specifically the template id and template name without touching action/pane IDs
  python3 -c "
import sys

manifest_file = sys.argv[1]
plugin_id = sys.argv[2]
human_name = sys.argv[3]

with open(manifest_file, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace template ID and Name only in the top-level section
lines = content.splitlines()
new_lines = []
for line in lines:
    if line.startswith('id = \"c4.template-'):
        new_lines.append(f'id = \"{plugin_id}\"')
    elif line.startswith('name = \"Template '):
        new_lines.append(f'name = \"{human_name}\"')
    else:
        new_lines.append(line)

with open(manifest_file, 'w', encoding='utf-8') as f:
    f.write('\n'.join(new_lines) + '\n')
" "$MANIFEST" "$PLUGIN_ID" "$HUMAN_NAME"
fi

# Update package.json if present
PKG_JSON="$TARGET_DIR/package.json"
if [ -f "$PKG_JSON" ]; then
  python3 -c "
import sys, json

pkg_path = sys.argv[1]
name = sys.argv[2]

with open(pkg_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

data['name'] = f'c4-{name}'
with open(pkg_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$PKG_JSON" "$PLUGIN_NAME"
fi

# Ensure shell scripts have executable permissions
find "$TARGET_DIR" -type f -name "*.sh" -exec chmod +x {} +

echo "✅ Plugin scaffolded successfully at: plugins/$PLUGIN_NAME"
echo ""
echo "Next steps:"
echo "  1. Review and edit plugins/$PLUGIN_NAME/herdr-plugin.toml"
echo "  2. Implement your logic in plugins/$PLUGIN_NAME"
echo "  3. Validate: python3 scripts/validate-plugins.py"
echo "  4. Link to Herdr: herdr plugin link \"\$(pwd)/plugins/$PLUGIN_NAME\""
echo "  5. Test actions: herdr plugin action list --plugin $PLUGIN_ID"
