# Session-Based Tab Rename Research

## Scope

This note records the implementation research for a Herdr plugin that prefers the
native conversation/session name of Codex, Claude Code, Antigravity CLI (`agy`),
and OpenCode, then falls back to Herdr terminal context.

## Findings

- `herdr-automatic-rename` uses Herdr snapshots, pane process information,
  terminal titles, agent detection, and Claude transcript data. It renames with
  `herdr tab rename`, reacts to lifecycle events, and keeps state so manual names
  are not overwritten.
- `herdr-tab-smart-rename` resolves the focused pane, reads bounded recent pane
  output and process information, optionally reads user-message context, then
  applies heuristic or model-backed names. It also tracks manual ownership and
  uses a background event-driven worker.
- Herdr exposes `agent_session` as a native session reference containing an agent,
  kind, and value. The value is an identifier for restore, not the human-readable
  session title.
- Current Herdr integrations cover native session references for Codex, Claude
  Code, OpenCode, and Antigravity CLI. The integration documentation identifies
  `agy --conversation <id>` and `opencode --session <id>` as resume forms.
- Codex persists an optional user-facing `thread_name`; its CLI also supports
  renaming the current thread with `/rename`.
- OpenCode exposes `opencode session list --format json` and a session API whose
  session object contains a title, making it the least invasive adapter.
- Antigravity CLI stores conversation summaries, including titles, in its local
  `conversation_summaries.db`.
- Claude Code exposes `/rename` and stores full JSONL transcripts under
  `~/.claude/projects/<project>/<session>.jsonl`. Herdr's Claude integration
  reports the session identity, but the plugin will need a best-effort local
  metadata/transcript lookup for a title; otherwise it should use context
  fallback.

## Local KAI implementation

The local `/Users/caio/C4work/kai` repository already implements most of the
required provider-specific logic:

- `src/history/agent_sources.rs` maps agent roots, normalizes agent labels,
  extracts display names, and extracts the first user prompt for Pi, Codex,
  Claude, and Antigravity CLI.
- `src/history/session_list.rs` scans transcripts, associates session IDs,
  loads Codex `session_index.jsonl`, reads Codex SQLite history, parses Agy
  `history.jsonl` plus annotation titles, and deduplicates Codex entries.
- The KAI integrations report native session identity for Claude, Codex, Agy,
  OpenCode, and Pi through `pane.report_agent_session`; Claude also reports its
  transcript path.
- KAI's plugin invocation context exposes workspace/tab/pane basics, but not
  `agent_session`. The plugin must therefore call the Herdr snapshot/pane API
  and join `pane.agent_session.value` with the provider-specific session
  scanner.
- KAI intentionally treats presentation (`display_name`/`first_prompt`) as
  separate from identity (`AgentSessionRef`), which should be preserved in the
  plugin design.

## Sources

- [herdr-automatic-rename README](https://github.com/qu8n/herdr-automatic-rename)
- [herdr-automatic-rename manifest](https://raw.githubusercontent.com/qu8n/herdr-automatic-rename/main/herdr-plugin.toml)
- [herdr-automatic-rename engine](https://raw.githubusercontent.com/qu8n/herdr-automatic-rename/main/automatic-rename.sh)
- [herdr-tab-smart-rename README](https://github.com/iurysza/herdr-tab-smart-rename)
- [herdr-tab-smart-rename service](https://raw.githubusercontent.com/iurysza/herdr-tab-smart-rename/main/src/service.ts)
- [herdr-tab-smart-rename Herdr adapter](https://raw.githubusercontent.com/iurysza/herdr-tab-smart-rename/main/src/herdr.ts)
- [Herdr Socket API](https://herdr.dev/docs/socket-api/)
- [Herdr integrations](https://herdr.dev/docs/integrations/)
- [Herdr session state and restore](https://herdr.dev/docs/session-state/)
- [Codex session state](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/session.rs)
- [OpenCode CLI](https://dev.opencode.ai/docs/cli/)
- [OpenCode server session API](https://dev.opencode.ai/docs/server/)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Claude Code local data](https://code.claude.com/docs/en/claude-directory)
- Local KAI: `/Users/caio/C4work/kai/docs/architecture/agent-session/README.md`
- Local KAI: `/Users/caio/C4work/kai/src/history/agent_sources.rs`
- Local KAI: `/Users/caio/C4work/kai/src/history/session_list.rs`
- Local KAI integrations: `/Users/caio/C4work/kai/src/integration/assets/`
