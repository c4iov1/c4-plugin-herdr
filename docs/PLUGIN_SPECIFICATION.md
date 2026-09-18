# Herdr Plugin Specification Reference

> **Official Source:** [Herdr Plugin Documentation](https://herdr.dev/docs/plugins/) & Herdr CLI v0.9.1+

This document serves as the canonical technical reference for creating and maintaining Herdr plugins within this repository.

---

## 1. Overview & Architecture

Herdr plugins are shareable, executable workflow packages. A plugin can be implemented in any language or runtime supported by the host machine (e.g., Bash, Node.js, Python, Rust, Go, Bun, Lua).

### Key Architectural Principles
* **Lean Core:** Herdr focuses on terminal workspaces, panes, agents, and a stable CLI/socket API. Plugins encapsulate reusable workflows without bloating the core.
* **No Separate SDK:** The **entire Herdr CLI is the plugin API**. Plugins communicate with Herdr by calling the binary pointed to by the `HERDR_BIN_PATH` environment variable or through the low-level socket API at `HERDR_SOCKET_PATH`.
* **Manifest Contract:** All capabilities (actions, event hooks, panes, link handlers, startup hooks) are statically declared in `herdr-plugin.toml`. Runtime dynamic registration is not part of the v1 architecture.
* **Direct Execution:** Commands in the manifest are executed as argv arrays directly (not through a shell), inheriting the caller's environment with injected Herdr context.

---

## 2. Manifest (`herdr-plugin.toml`) Schema

The `herdr-plugin.toml` manifest is the contract between Herdr and the plugin.

### 2.1 Top-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | String | **Yes** | Globally unique plugin ID. Allowed characters: ASCII letters, digits, dots (`.`), colons (`:`), underscores (`_`), hyphens (`-`). Example: `"c4.workspace-tools"` |
| `name` | String | **Yes** | Human-readable plugin name. Example: `"Workspace Tools"` |
| `version` | String | **Yes** | Semantic version string. Example: `"0.1.0"` |
| `min_herdr_version` | String | **Yes** | Oldest Herdr version supported. Herdr refuses to link/install if the running version is older than this. Example: `"0.7.0"` or `"0.9.1"` |
| `description` | String | No | Short explanation of what the plugin does. |
| `platforms` | Array of Strings | Recommended | Platforms supported: `["linux", "macos", "windows"]`. Local plugins linked without this will trigger a warning. |

### 2.2 Sections

#### `[[build]]` (Optional, Multiple)
Build commands run during GitHub-managed installation (`herdr plugin install`) after user approval and before plugin registration.
* **Note:** `herdr plugin link` does **not** run build commands; developers build local trees themselves.
* Build commands do not receive Herdr runtime socket or context environment.
* Build commands may generate build artifacts (e.g., `dist/`), but altering `herdr-plugin.toml` will abort installation.

```toml
[[build]]
command = ["npm", "ci"]

[[build]]
command = ["npm", "run", "build"]
platforms = ["linux", "macos"]
```

#### `[[startup]]` (Optional, Multiple)
One-shot initialization commands executed asynchronously once per session when Herdr restores state and the API socket is ready.
* They run again during live server handoff, but **not** on client attach, config reload, or initial plugin link.
* **Must be one-shot tasks that exit quickly.** They are not persistent daemons.
* Injected environment: `HERDR_PLUGIN_EVENT="startup"`, standard runtime context.

```toml
[[startup]]
command = ["node", "dist/restore.js"]
```

#### `[[actions]]` (Optional, Multiple)
User-invocable actions accessible via CLI (`herdr plugin action invoke <id>`), command palette, or keybindings.
* `id`: Local action identifier (ASCII letters, digits, colons, underscores, hyphens; **no dots**). Herdr qualifies the action globally as `<plugin-id>.<action-id>`.
* `title`: Human-readable title for menus and UI.
* `contexts`: Context filter array, e.g. `["workspace"]`.
* `command`: Argv array to execute.

```toml
[[actions]]
id = "apply-layout"
title = "Apply Layout"
contexts = ["workspace"]
command = ["node", "dist/apply.js"]
```

#### `[[events]]` (Optional, Multiple)
Hooks that trigger when system or workspace events occur in Herdr.
* `on`: Event name to listen for (e.g., `"worktree.created"`, `"workspace.created"`, `"workspace.closed"`).
* `command`: Argv array to execute.
* Injected environment: `HERDR_PLUGIN_EVENT` and `HERDR_PLUGIN_EVENT_JSON`.

```toml
[[events]]
on = "worktree.created"
command = ["bash", "scripts/on-worktree.sh"]
```

#### `[[panes]]` (Optional, Multiple)
Declares terminal panes managed by the plugin.
* `id`: Local pane ID (**no dots**).
* `title`: Title displayed in pane header.
* `placement`: One of:
  * `"overlay"` (Default): Temporary zoomed overlay over active pane. Restores previous layout on close.
  * `"popup"`: Modal terminal popup without modifying tiled layout. Receives all input (including Esc) until exited.
  * `"split"`: Adds as a split pane in current layout.
  * `"tab"`: Opens as a new tab.
  * `"zoomed"`: Opens as a zoomed pane.
* `width` & `height` (Popup only): Optional dimensions. Can be numbers (cells) or strings (percentages, e.g. `"80%"`).
* `command`: Argv array for the pane process.

```toml
[[panes]]
id = "picker"
title = "Layout Picker"
placement = "popup"
width = "80%"
height = 20
command = ["node", "dist/picker.js"]
```

#### `[[link_handlers]]` (Optional, Multiple)
Routes modified clicks (`Ctrl + Click` on all platforms, including macOS) on terminal URLs to a plugin action instead of opening the browser.
* `id`: Local link handler ID (**no dots**).
* `title`: Handler title.
* `pattern`: Rust regular expression matched against the clicked URL.
* `action`: ID of an action declared in the **same** plugin.
* Injected environment: `HERDR_PLUGIN_CLICKED_URL` and `HERDR_PLUGIN_LINK_HANDLER_ID` (also available in `HERDR_PLUGIN_CONTEXT_JSON`).

```toml
[[link_handlers]]
id = "github-issue"
title = "Open GitHub Issue"
pattern = "^https://github\\.com/[^/]+/[^/]+/(issues|pull)/[0-9]+$"
action = "apply-layout"
```

---

## 3. Runtime Environment Variables

When Herdr invokes any plugin command (actions, hooks, panes), it sets the plugin root as the working directory (`cwd`) and injects the following environment variables:

| Variable | Description |
|---|---|
| `HERDR_BIN_PATH` | Path to the running Herdr binary (e.g. `/opt/homebrew/bin/herdr`). **Always use this to call Herdr CLI.** |
| `HERDR_SOCKET_PATH` | Path to the active API socket (Unix domain socket or Windows named pipe). |
| `HERDR_ENV` | Set to `1` indicating the process is running under Herdr. |
| `HERDR_PLUGIN_ID` | The ID of the executing plugin. |
| `HERDR_PLUGIN_ROOT` | Absolute path to the plugin directory. |
| `HERDR_PLUGIN_CONFIG_DIR` | Directory reserved for user configuration (e.g. `.env` files). |
| `HERDR_PLUGIN_STATE_DIR` | Directory reserved for plugin-owned durable/runtime state. |
| `HERDR_PLUGIN_CONTEXT_JSON` | JSON payload containing active workspace, tab, pane, worktree, agent, selected text, etc. |
| `HERDR_WORKSPACE_ID` | ID of the current workspace, if applicable. |
| `HERDR_TAB_ID` | ID of the current tab, if applicable. |
| `HERDR_PANE_ID` | ID of the current pane, if applicable. (Note: popups do not have a pane ID). |
| `HERDR_PLUGIN_ACTION_ID` | Present when invoked as an action. |
| `HERDR_PLUGIN_EVENT` | Present for startup (`"startup"`) and event hooks. |
| `HERDR_PLUGIN_EVENT_JSON` | Present for event hooks containing event payload. |
| `HERDR_PLUGIN_ENTRYPOINT_ID` | Present when opening a declared pane. |
| `HERDR_PLUGIN_CLICKED_URL` | Present for link handler action invocations. |
| `HERDR_PLUGIN_LINK_HANDLER_ID` | Present for link handler action invocations. |

---

## 4. Storage & State Best Practices

1. **NEVER store state or credentials in `HERDR_PLUGIN_ROOT`:**
   * When installed via `herdr plugin install`, the plugin directory is a managed git checkout. Reinstallation or updates will overwrite or delete local files in that directory.
2. **User Configuration (`HERDR_PLUGIN_CONFIG_DIR`):**
   * Store user-editable configuration (like `.env`, API tokens, user preferences) here.
   * Obtain the path via `$HERDR_PLUGIN_CONFIG_DIR` or by running `herdr plugin config-dir <plugin-id>`.
3. **Persistent State & Databases (`HERDR_PLUGIN_STATE_DIR`):**
   * Store persistent files, SQLite databases, caches, or session backups here.
   * Herdr automatically ensures this directory exists, but does not manage or delete its contents.

---

## 5. Command Execution Rules

1. **Argv Execution (No Shell):**
   * Herdr executes `command = ["arg1", "arg2"]` directly via `execvp` or Windows equivalent.
   * Variables like `$VAR` or wildcards `*` are **not** expanded by Herdr.
   * To use shell features, explicitly invoke the shell:
     ```toml
     command = ["bash", "-c", "echo $HERDR_PLUGIN_ID"]
     ```
2. **Calling Herdr CLI:**
   * Do **not** assume `herdr` is in the system `$PATH`.
   * Always read `process.env.HERDR_BIN_PATH` (Node), `os.environ.get("HERDR_BIN_PATH")` (Python), or `"$HERDR_BIN_PATH"` (Bash), with a fallback to `"herdr"`.
3. **Parse JSON for Automation:**
   * Most Herdr CLI subcommands support `--json` or output structured JSON by default.
   * Always parse structured JSON rather than relying on regex parsing of human-oriented CLI tables.

---

## 6. Keybindings

Users or plugins can bind keys to plugin actions in Herdr's main configuration:

```toml
[[keys.command]]
key = "prefix+l"
type = "plugin_action"
command = "c4.workspace-tools.apply-layout"
description = "apply layout"
```

---

## 7. Marketplace & Discovery

Community plugins are automatically indexed on [herdr.dev/plugins](https://herdr.dev/plugins):
* The GitHub repository must have the topic: `herdr-plugin`.
* Manifest files must be located on the default branch either at repository root or inside subdirectories.
* Multiple plugins in subdirectories are discovered and presented on a single repository card.
* Users can install directly via:
  ```bash
  herdr plugin install <owner>/<repo>/<subdir>
  ```
