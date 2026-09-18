# C4 Herdr Plugins Monorepo

Welcome to the **C4 Herdr Plugins** repository. This repository is a monorepo containing custom workflow plugins for [Herdr](https://herdr.dev) (modern terminal workspaces and agent manager).

Every plugin in this repository resides in its own isolated directory under `plugins/<plugin-name>/`.

---

## 📁 Repository Structure

```text
c4-plugin-herdr/
├── .gitignore
├── AGENTS.md                  # Strict rules for autonomous AI coding agents
├── README.md                  # This file
├── docs/
│   ├── PLUGIN_SPECIFICATION.md# Complete Herdr plugin technical reference
│   └── DEVELOPMENT_WORKFLOW.md# Step-by-step developer workflow
├── scripts/
│   ├── scaffold-plugin.sh     # CLI generator to bootstrap a new plugin
│   └── validate-plugins.py    # Automated manifest and integrity validator
├── templates/
│   ├── bash-minimal/          # Starter template in pure Bash
│   └── node-basic/            # Starter template in Node.js
└── plugins/
    └── <plugin-name>/         # Individual plugins (each with herdr-plugin.toml)
```

---

## ⚡ Quick Start: Creating a Plugin

### 1. Scaffold a New Plugin
Use the scaffolding script to create a new plugin from a starter template:

```bash
# Using Node.js template (default):
./scripts/scaffold-plugin.sh my-tool node-basic

# OR using minimal Bash template:
./scripts/scaffold-plugin.sh my-tool bash-minimal
```

### 2. Configure the Manifest
Edit `plugins/my-tool/herdr-plugin.toml`:

```toml
id = "c4.my-tool"
name = "My Tool"
version = "0.1.0"
min_herdr_version = "0.9.1"
description = "Description of what this plugin does."
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "run-check"
title = "Run Check"
contexts = ["workspace"]
command = ["node", "index.js"]
```

### 3. Validate
Run the validation script to verify all manifests and integrity:

```bash
python3 scripts/validate-plugins.py
```

### 4. Link & Test Locally with Herdr
Link your plugin directly into your local Herdr runtime:

```bash
# Link local plugin (use absolute path)
herdr plugin link "$(pwd)/plugins/my-tool"

# Verify registration
herdr plugin list

# Inspect actions
herdr plugin action list --plugin c4.my-tool

# Execute an action
herdr plugin action invoke c4.my-tool.run-check

# Inspect execution logs
herdr plugin log list --plugin c4.my-tool
```

To unlink when testing is done:
```bash
herdr plugin unlink c4.my-tool
```

---

## 🛡️ Core Rules & Best Practices

1. **Manifest Integrity (`herdr-plugin.toml`):**
   * Top-level required fields: `id`, `name`, `version`, `min_herdr_version`.
   * Global ID convention: `c4.<plugin-name>`.
   * Local IDs (`[[actions]]`, `[[panes]]`, `[[link_handlers]]`): **MUST NOT contain dots (`.`)**. Herdr qualifies them as `<plugin-id>.<action-id>`.
2. **Commands are Argv Arrays:**
   * `command = ["node", "index.js"]` (Herdr runs via `execvp` directly without a shell).
   * For shell expansion or pipes, explicitly invoke a shell: `command = ["bash", "-c", "..."]`.
3. **Herdr CLI Integration:**
   * **Never hardcode `"herdr"`**. Always inspect `HERDR_BIN_PATH` environment variable:
     * Node.js: `process.env.HERDR_BIN_PATH || "herdr"`
     * Bash: `"${HERDR_BIN_PATH:-herdr}"`
     * Python: `os.environ.get("HERDR_BIN_PATH", "herdr")`
4. **Storage Isolation:**
   * `HERDR_PLUGIN_ROOT`: Read-only source code. **Never write runtime state or user credentials here.**
   * `HERDR_PLUGIN_CONFIG_DIR`: User configuration files (e.g. `.env`).
   * `HERDR_PLUGIN_STATE_DIR`: Plugin persistent state, caches, databases.
5. **Startup Hooks:**
   * `[[startup]]` hooks run once per session boot. They must be fast, one-shot initialization tasks that exit promptly (not daemons).

---

## 📚 Detailed Documentation

* [Plugin Specification Reference](docs/PLUGIN_SPECIFICATION.md) — Comprehensive technical reference on manifest fields, injected environment variables, placement options, link handlers, and socket API.
* [Development Workflow](docs/DEVELOPMENT_WORKFLOW.md) — Step-by-step developer workflow from scaffolding to marketplace distribution.
* [Autonomous Agent Rules](AGENTS.md) — Mandatory guidelines and checklist for AI agents working in this repository.
