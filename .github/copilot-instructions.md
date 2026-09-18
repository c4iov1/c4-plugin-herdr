# GitHub Copilot Instructions for Herdr Plugins Monorepo

* **Architecture:** This repository is a monorepo for Herdr plugins. Each plugin lives in `plugins/<plugin-name>/`.
* **Manifests:** Every plugin must contain `herdr-plugin.toml` with `id`, `name`, `version`, and `min_herdr_version`.
* **Command Arrays:** All manifest commands (`[[build]]`, `[[startup]]`, `[[actions]]`, `[[events]]`, `[[panes]]`) must be argv arrays (e.g. `["node", "index.js"]`).
* **Herdr CLI Invocations:** Always use `process.env.HERDR_BIN_PATH` (Node), `os.environ.get("HERDR_BIN_PATH")` (Python), or `"${HERDR_BIN_PATH:-herdr}"` (Bash).
* **State & Config:** Never write to `HERDR_PLUGIN_ROOT`. Use `HERDR_PLUGIN_CONFIG_DIR` for user config and `HERDR_PLUGIN_STATE_DIR` for state/caches.
* **Validation:** Always validate manifests with `python3 scripts/validate-plugins.py`.
* **Language:** Documentation and code comments must be in English.
