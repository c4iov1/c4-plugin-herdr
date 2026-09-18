# Autonomous Agent Instructions for Herdr Plugins

> **Notice to AI Agents:** You are working in a monorepo containing plugins for **Herdr** (a modern terminal workspace and agent manager). All plugins must strictly adhere to the rules in this document and [docs/PLUGIN_SPECIFICATION.md](file:///Users/caio/C4work/c4-plugin-herdr/docs/PLUGIN_SPECIFICATION.md).

---

## 1. Core Directives

1. **Folder Placement:**
   * Every new plugin MUST reside in its own dedicated directory under `plugins/<plugin-name>/`.
   * Never create plugin files directly at the repository root.
2. **Language Policy:**
   * User interaction language: Match user request (e.g. Portuguese / pt-br when prompted).
   * File documentation, READMEs, manifests, code comments, and non-code docs: **Must always be in English**.
3. **No Phantom Dependencies:**
   * Rely on lightweight standard libraries when possible (e.g. standard Node.js libraries, Python standard library, or clean Bash).
   * If third-party dependencies are required (e.g. `npm` packages), declare `[[build]]` commands in `herdr-plugin.toml` so `herdr plugin install` builds them properly.

---

## 2. Manifest (`herdr-plugin.toml`) Mandatory Rules

When generating `herdr-plugin.toml`:

* **Required Top-Level Keys:**
  ```toml
  id = "c4.<plugin-name>"
  name = "Human Readable Name"
  version = "0.1.0"
  min_herdr_version = "0.9.1"
  description = "Concise description of the plugin's purpose."
  platforms = ["linux", "macos", "windows"]
  ```
* **ID Formatting:**
  * Top-level `id`: Use namespace `c4.<plugin-name>`.
  * Local IDs (`[[actions]]`, `[[panes]]`, `[[link_handlers]]`): **MUST NOT contain dots (`.`)**. Dots are used by Herdr for qualification (`<plugin-id>.<action-id>`). Use hyphens or underscores (e.g., `id = "toggle-view"`).
* **Command Arrays:**
  * `command` fields must **ALWAYS** be argv arrays of strings, e.g.:
    ```toml
    command = ["node", "index.js"] # CORRECT
    # command = "node index.js"     # FORBIDDEN (will fail)
    ```
  * Herdr runs commands directly via `execvp` without a shell. Do NOT rely on shell features (`&&`, `|`, `$VAR`) in `command` unless explicitly invoking a shell:
    ```toml
    command = ["bash", "-c", "echo $HERDR_PLUGIN_ID"]
    ```
* **Startup Hooks:**
  * `[[startup]]` hooks are one-shot async scripts executed when Herdr boots. They **must exit promptly**. Never start an infinite loop or background daemon in a startup hook.

---

## 3. Runtime Integration Rules

When writing code that interacts with Herdr:

* **Herdr CLI Execution:**
  * **NEVER hardcode `"herdr"`** directly in process spawns without checking `HERDR_BIN_PATH`.
  * Always use the binary path provided by Herdr:
    * **Node.js:** `process.env.HERDR_BIN_PATH || "herdr"`
    * **Python:** `os.environ.get("HERDR_BIN_PATH", "herdr")`
    * **Bash:** `"${HERDR_BIN_PATH:-herdr}"`
* **JSON Output Parsing:**
  * Herdr CLI outputs structured JSON. Always parse JSON outputs from Herdr CLI commands rather than regex-scraping text.
* **Storage & Directory Isolation:**
  * `HERDR_PLUGIN_ROOT`: Read-only code directory. **DO NOT write cache, logs, state, or user files here.**
  * `HERDR_PLUGIN_CONFIG_DIR`: User configuration files (e.g. `.env`).
  * `HERDR_PLUGIN_STATE_DIR`: Plugin persistent state, database files, and caches.

---

## 4. Verification Checklist

Before reporting completion of any plugin creation or modification task, you MUST:

1. [ ] Check that `plugins/<plugin-name>/herdr-plugin.toml` exists and contains all required fields.
2. [ ] Check that local action and pane IDs do not have dots.
3. [ ] Check that script files have appropriate executable permissions (`chmod +x` for shell scripts).
4. [ ] Run the validator script:
   ```bash
   python3 scripts/validate-plugins.py
   ```
   Ensure it exits with `0 errors`.
5. [ ] Provide the user with instructions to link and test the plugin locally:
   ```bash
   herdr plugin link "$(pwd)/plugins/<plugin-name>"
   herdr plugin list
   ```
