# Usage Quote Subs

Usage Quote Subs shows subscription quota for Claude Code, Codex, and
Gemini/Antigravity in Herdr. It provides a compact tab-bar status command and
an interactive detail popup.

The plugin uses Python's standard library and does not require an additional
usage application.

## Data Sources

| Provider | Credential or session | Usage source |
|---|---|---|
| Claude | `CLAUDE_CODE_OAUTH_TOKEN`, Claude Code macOS Keychain item, or `~/.claude/.credentials.json` | Anthropic OAuth usage endpoint |
| Codex | `$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json` | ChatGPT Codex usage endpoint |
| Gemini | Existing Antigravity CLI login or running Antigravity process | `agy /usage` structured output, with the local quota service as fallback |

The Gemini adapter converts `remaining_fraction` to percent used. It recognizes
explicit five-hour and weekly buckets. When the provider reports only a weekly
bucket, the status line labels it `7d` rather than presenting it as a five-hour
limit.

The detail popup keeps Antigravity pools separate. Current versions commonly
report `Gemini Models` and `Claude and GPT models`; each pool is shown with the
windows and reset times returned by the provider.

## Install Locally

```bash
herdr plugin link "$(pwd)/plugins/usage-quote-subs"
herdr plugin list
herdr plugin action invoke c4.usage-quote-subs.setup
```

The setup action opens a popup containing the Herdr configuration snippet.
Press `c` to copy it, add it to your Herdr `config.toml`, then reload:

```bash
herdr server reload-config
```

If the file already contains a `[ui]` table, merge the generated keys into
that table instead of adding a second `[ui]`. If `tab_bar_right` already
exists, append the generated command entry instead of replacing the array.

The snippet binds `prefix+u` to the dashboard and adds the status command to
`ui.tab_bar_right`. Herdr runs the status command automatically; it is not a
command the user must run while an agent is working.

Example status output:

```text
Claude 21%/5h->14:35 | Codex 4%/5h->16:10 | Gemini 64%/7d->Fri 14:09
```

## Dashboard

Press `prefix+u` after applying the setup snippet.

- `Tab`: toggle detail and compact views.
- `r`: refresh usage.
- `q` or `Esc`: close the popup.

The popup is independent of the active agent pane. Opening or closing it does
not stop the agent process.

## Refresh Behavior

- The status command checks for updates every five minutes.
- `pane.agent_status_changed` refreshes after an agent leaves the working state,
  at most once every two minutes.
- Manual refresh is limited to once every 30 seconds.
- Failed refreshes retain the last successful reading and mark stale data.

Runtime cache and locks are stored in `HERDR_PLUGIN_STATE_DIR`. User settings
and the generated status command are stored in `HERDR_PLUGIN_CONFIG_DIR`.

Optional settings in the plugin config directory:

```toml
icons = "text" # text | nerd
```

## Requirements

- Herdr 0.9.1 or newer.
- Python 3.9 or newer.
- macOS, Linux, or Windows. Antigravity loopback process discovery is available
  on macOS and Linux; Windows uses the structured `agy /usage` path.
- At least one supported provider CLI signed in with a subscription.

Some Claude Code releases use credential storage that the macOS `security`
command cannot read from a background plugin. In that case, start Herdr with
`CLAUDE_CODE_OAUTH_TOKEN` available or use a Claude configuration directory
containing `.credentials.json`. The token is used in memory and is never added
to the plugin cache.

Use demo mode without provider credentials:

```bash
USAGE_QUOTE_SUBS_DEMO=1 python3 plugins/usage-quote-subs/usage.py dashboard
```

## License

MIT. See `LICENSE` and `NOTICE`.
