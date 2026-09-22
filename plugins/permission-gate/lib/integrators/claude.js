"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HOOK_IDENTIFIER = "c4-permission-gate";

function getClaudeSettingsPath() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".claude", "settings.json");
}

function install(gatekeeperBinPath) {
  const settingsPath = getClaudeSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch (_e) {
      settings = {};
    }
  }

  // Ensure permissionMode is acceptEdits
  settings.permissionMode = "acceptEdits";

  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }

  if (!Array.isArray(settings.hooks.PreToolUse)) {
    settings.hooks.PreToolUse = [];
  }

  const hookCommand = `node "${gatekeeperBinPath}" --agent claude # ${HOOK_IDENTIFIER}`;

  // Check if already installed
  const alreadyInstalled = settings.hooks.PreToolUse.some((group) => {
    return (
      Array.isArray(group.hooks) &&
      group.hooks.some(
        (h) => h.command && h.command.includes(HOOK_IDENTIFIER)
      )
    );
  });

  if (!alreadyInstalled) {
    settings.hooks.PreToolUse.push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 30,
        },
      ],
    });
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return { success: true, path: settingsPath };
}

function uninstall() {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { success: true, removed: false };
  }

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (_e) {
    return { success: false, error: "Failed to parse settings.json" };
  }

  if (settings.hooks && Array.isArray(settings.hooks.PreToolUse)) {
    const initialLen = settings.hooks.PreToolUse.length;
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((group) => {
      if (!Array.isArray(group.hooks)) return true;
      group.hooks = group.hooks.filter(
        (h) => !h.command || !h.command.includes(HOOK_IDENTIFIER)
      );
      return group.hooks.length > 0;
    });

    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return { success: true, removed: settings.hooks.PreToolUse?.length !== initialLen };
  }

  return { success: true, removed: false };
}

function status() {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { installed: false, reason: "Claude settings not found" };
  }

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const installed =
      settings.hooks &&
      Array.isArray(settings.hooks.PreToolUse) &&
      settings.hooks.PreToolUse.some(
        (g) =>
          Array.isArray(g.hooks) &&
          g.hooks.some((h) => h.command && h.command.includes(HOOK_IDENTIFIER))
      );
    return { installed: Boolean(installed), path: settingsPath };
  } catch (e) {
    return { installed: false, error: e.message };
  }
}

module.exports = {
  install,
  uninstall,
  status,
};
