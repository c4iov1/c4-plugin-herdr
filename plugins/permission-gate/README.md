# C4 Permission Gate

A centralized, uniform permission gate and safety policy plugin for **Herdr**, providing consistent permission behavior across **Claude Code**, **OpenAI Codex**, **Antigravity CLI (Agy)**, and **Pi** agents.

---

## Features

- **Natural File Modification (Auto-Approved):** Agents can create, read, and edit workspace files without asking for confirmation or halting turns.
- **Fail-Closed Safety Engine:** Protects sensitive paths (`.env`, `secrets.*`, `~/.ssh/`, etc.) from being read or modified by any agent.
- **Controlled Delegation (Anti-Workaround Protocol):** When a privileged command (`sudo`, `brew install`, `docker push`, `npm publish`, `git push --force`) is intercepted, the gate:
  1. Blocks the command from executing autonomously.
  2. Emits a real-time notification in Herdr.
  3. Returns a structured protocol directive instructing the agent **not to attempt workarounds**, explain the requirement, provide the command for manual execution, and wait for human confirmation.
- **Inherently Unsafe Hard Denial:** Prevents destructive commands (`rm -rf /`, `chmod 777`, `curl | sh`, `DROP TABLE`) and warns the agent not to suggest destructive operations to the user.
- **Workspace Confinement:** Prevents commands from altering paths outside the active project without explicit human approval.

---

## Policy Matrix

| Category | Policy State | Examples | Behavior |
| :--- | :--- | :--- | :--- |
| **Workspace Files** | `ALLOW` | `write_to_file`, `replace_file_content`, `edit`, `touch` | Silently auto-approved within the repository. |
| **Dev Commands** | `ALLOW` | `npm test`, `cargo build`, `git status`, `ls`, `cat`, `pytest` | Standard non-mutating project commands run immediately. |
| **Privileged Actions** | `DELEGATE_TO_USER` | `sudo *`, `brew install`, `npm publish`, `git push --force` | Notifies Herdr, blocks autonomous execution, and directs agent to delegate to human. |
| **Hazardous Commands** | `HARD_DENY` | `rm -rf /`, `chmod 777`, `curl * \| bash`, `DROP DATABASE` | Blocks execution and warns agent to find non-destructive solutions. |
| **Interactive Operations** | `ASK` | `git commit`, `git push`, `curl`, `ssh`, outside workspace access | Prompts for manual user confirmation + alerts Herdr. |

---

## Installation & Setup

1. **Link the plugin to Herdr:**
   ```bash
   herdr plugin link "$(pwd)/plugins/permission-gate"
   herdr plugin list
   ```

2. **Install the hooks into all agent CLIs:**
   ```bash
   herdr plugin action invoke c4.permission-gate.install-hooks
   ```

3. **Check status:**
   ```bash
   herdr plugin action invoke c4.permission-gate.status
   ```

4. **Uninstall anytime:**
   ```bash
   herdr plugin action invoke c4.permission-gate.uninstall-hooks
   ```
