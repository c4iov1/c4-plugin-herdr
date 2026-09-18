# Development Workflow Guide

This guide explains how to build, test, and manage Herdr plugins in this repository.

---

## 1. Repository Structure

This repository is organized as a monorepo containing multiple independent Herdr plugins:

```text
c4-plugin-herdr/
├── .gitignore
├── AGENTS.md                  # Autonomous Agent Guidelines & rules
├── README.md                  # Monorepo overview and quick reference
├── docs/
│   ├── PLUGIN_SPECIFICATION.md# Complete technical reference
│   └── DEVELOPMENT_WORKFLOW.md# Step-by-step developer workflow (this file)
├── scripts/
│   ├── scaffold-plugin.sh     # Interactive or scripted plugin generator
│   └── validate-plugins.py    # Automated manifest and integrity validator
├── templates/
│   ├── bash-minimal/          # Starter template using pure Bash
│   ├── node-basic/            # Starter template using Node.js
│   └── python-basic/          # Starter template using Python
└── plugins/
    ├── <plugin-a>/            # Independent plugin directory
    │   ├── herdr-plugin.toml
    │   └── ...
    └── <plugin-b>/
        ├── herdr-plugin.toml
        └── ...
```

---

## 2. Creating a New Plugin

### Step 1: Scaffold the Directory
You can use the helper script or copy one of the templates directly:

```bash
# Using the helper script:
./scripts/scaffold-plugin.sh my-plugin-name node-basic

# OR manually from templates:
cp -R templates/node-basic plugins/my-plugin-name
```

### Step 2: Configure the Manifest (`herdr-plugin.toml`)
Navigate to `plugins/<plugin-name>/herdr-plugin.toml` and configure:
1. `id`: Set a unique identifier (convention: `c4.<plugin-name>`).
2. `name`: Friendly title.
3. `version`: Start at `0.1.0`.
4. `min_herdr_version`: Minimum supported Herdr version (e.g. `"0.9.1"`).
5. `platforms`: Ensure supported OS targets are listed (`["linux", "macos", "windows"]`).
6. Declare actions, startup hooks, panes, or link handlers needed by your plugin.

### Step 3: Write the Code
* **Accessing Herdr:** Always use `$HERDR_BIN_PATH` (or fallback to `herdr`) to execute CLI commands.
* **Accessing Context:** Read `$HERDR_PLUGIN_CONTEXT_JSON` for active pane, workspace, or agent metadata.
* **Saving Config:** Read/write user settings to `$HERDR_PLUGIN_CONFIG_DIR`.
* **Saving State:** Store cache or persistent databases in `$HERDR_PLUGIN_STATE_DIR`.
* **Do not write state to the plugin source folder.**

---

## 3. Local Testing & Verification

### Step 1: Validate the Plugin
Run the automated validator to ensure the manifest conforms to the specification:

```bash
python3 scripts/validate-plugins.py
```

### Step 2: Link the Plugin Locally
Link your local plugin directory to your running Herdr instance:

```bash
# Link using absolute path:
herdr plugin link "$(pwd)/plugins/<plugin-name>"
```

### Step 3: Verify Plugin Registration
```bash
# Check that the plugin is listed:
herdr plugin list

# Check registered actions:
herdr plugin action list --plugin <plugin-id>
```

### Step 4: Test Actions & Panes
```bash
# Invoke an action:
herdr plugin action invoke <plugin-id>.<action-id>

# Open a declared pane:
herdr plugin pane open --plugin <plugin-id> --entrypoint <pane-id>
```

### Step 5: Check Logs
When debugging plugin commands, inspect the execution log:

```bash
herdr plugin log list --plugin <plugin-id>
```

### Step 6: Unlink When Done
```bash
herdr plugin unlink <plugin-id>
```

---

## 4. Publishing & Sharing

To make plugins discoverable in the community marketplace:
1. Ensure the repository has the GitHub topic: `herdr-plugin`.
2. Commit and push the plugin directory to the default branch (`main`).
3. Users can then install any plugin from this monorepo with:
   ```bash
   herdr plugin install <github-owner>/c4-plugin-herdr/plugins/<plugin-name>
   ```
