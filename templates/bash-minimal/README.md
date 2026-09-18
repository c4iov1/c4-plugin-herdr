# Minimal Bash Plugin Template

A lightweight starter template for creating shell-based Herdr plugins.

## Structure
* `herdr-plugin.toml`: The plugin manifest declaring metadata and action entrypoints.
* `action.sh`: Sample script invoking Herdr CLI via `$HERDR_BIN_PATH`.

## How to use
Copy this directory into `plugins/<your-plugin-name>` and update `id` and `name` in `herdr-plugin.toml`.
