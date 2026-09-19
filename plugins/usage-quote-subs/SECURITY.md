# Security

Usage Quote Subs reads provider-owned credentials or local session metadata to
request quota information. It does not make model requests.

## Reads

- Claude Code OAuth access token from `CLAUDE_CODE_OAUTH_TOKEN`, its macOS
  Keychain item, or `$CLAUDE_CONFIG_DIR/.credentials.json`.
- Codex access token and account ID from `$CODEX_HOME/auth.json`.
- Antigravity quota through the signed-in `agy` CLI. If that command is not
  available, it may inspect a running Antigravity process, its listening ports,
  and its command-line CSRF token to query the loopback quota service.

## Network Destinations

- `https://api.anthropic.com/api/oauth/usage`
- `https://chatgpt.com/backend-api/wham/usage`
- Antigravity loopback endpoints on `127.0.0.1`

Public HTTP requests refuse redirects so bearer tokens cannot be forwarded to
another host.

## Writes

- `HERDR_PLUGIN_STATE_DIR`: quota cache, temporary cache files, and lock files.
- `HERDR_PLUGIN_CONFIG_DIR`: the generated `status.sh` command.

Tokens are never written to the plugin cache, logs, source directory, or Herdr
configuration. The plugin does not refresh or modify provider credentials.

Claude and Codex usage endpoints and the Antigravity local protocol may change
without notice. Parser failures are surfaced in the dashboard while the last
successful non-secret reading remains available.
