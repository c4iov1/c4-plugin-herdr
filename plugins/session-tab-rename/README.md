# Session Tab Rename

This plugin names Herdr tabs using the following priority:

1. Native agent session name.
2. Agent transcript or history title.
3. First user prompt.
4. Terminal title, foreground process, project, and branch context.

Supported session sources include Codex, Pi, Claude Code, Antigravity CLI
(`agy`), and OpenCode. The provider-specific parsing follows the session
history logic used by the local KAI repository.

The plugin reads agent history and metadata but does not modify agent files.
Runtime state is stored in `HERDR_PLUGIN_STATE_DIR`.

Install and test locally:

```bash
herdr plugin link "$(pwd)/plugins/session-tab-rename"
herdr plugin list
herdr plugin action invoke c4.session-tab-rename.rename-now
```

For native session IDs, install the corresponding Herdr agent integrations.
The Codex fallback can use `sqlite3` when its rollout and JSONL metadata do
not contain the first prompt. OpenCode can use its session CLI or local
`opencode.db` through the same read-only fallback.
