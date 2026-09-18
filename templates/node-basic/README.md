# Node.js Basic Plugin Template

A starter template for creating Node.js-based Herdr plugins.

## Structure
* `herdr-plugin.toml`: The plugin manifest declaring metadata and actions.
* `package.json`: Node package configuration.
* `index.js`: Main entrypoint demonstrating `HERDR_BIN_PATH` resolution and context JSON parsing.

## How to use
Copy this directory into `plugins/<your-plugin-name>` and update `id` and `name` in `herdr-plugin.toml`.
