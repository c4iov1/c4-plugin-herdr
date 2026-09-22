"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HOOK_IDENTIFIER = "c4-permission-gate";

function getCodexHooksPath() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".codex", "hooks.json");
}

function getCodexConfigPath() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".codex", "config.toml");
}

function ensureCodexHooksFeature() {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return;

  try {
    let content = fs.readFileSync(configPath, "utf-8");
    if (!content.includes("[features]")) {
      content += "\n[features]\nhooks = true\n";
      fs.writeFileSync(configPath, content, "utf-8");
    } else if (!content.includes("hooks = true")) {
      content = content.replace("[features]", "[features]\nhooks = true");
      fs.writeFileSync(configPath, content, "utf-8");
    }
  } catch (_e) {
    // Ignore config write failures
  }
}

function install(gatekeeperBinPath) {
  const hooksPath = getCodexHooksPath();
  const dir = path.dirname(hooksPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let hooksData = {};
  if (fs.existsSync(hooksPath)) {
    try {
      hooksData = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
    } catch (_e) {
      hooksData = {};
    }
  }

  if (!hooksData.hooks || typeof hooksData.hooks !== "object") {
    hooksData.hooks = {};
  }

  if (!Array.isArray(hooksData.hooks.PreToolUse)) {
    hooksData.hooks.PreToolUse = [];
  }

  const hookCommand = `node "${gatekeeperBinPath}" --agent codex # ${HOOK_IDENTIFIER}`;

  const alreadyInstalled = hooksData.hooks.PreToolUse.some((group) => {
    return (
      Array.isArray(group.hooks) &&
      group.hooks.some((h) => h.command && h.command.includes(HOOK_IDENTIFIER))
    );
  });

  if (!alreadyInstalled) {
    hooksData.hooks.PreToolUse.push({
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

  fs.writeFileSync(hooksPath, JSON.stringify(hooksData, null, 2) + "\n", "utf-8");
  ensureCodexHooksFeature();

  return { success: true, path: hooksPath };
}

function uninstall() {
  const hooksPath = getCodexHooksPath();
  if (!fs.existsSync(hooksPath)) {
    return { success: true, removed: false };
  }

  let hooksData = {};
  try {
    hooksData = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
  } catch (_e) {
    return { success: false, error: "Failed to parse codex hooks.json" };
  }

  if (hooksData.hooks && Array.isArray(hooksData.hooks.PreToolUse)) {
    const initialLen = hooksData.hooks.PreToolUse.length;
    hooksData.hooks.PreToolUse = hooksData.hooks.PreToolUse.filter((group) => {
      if (!Array.isArray(group.hooks)) return true;
      group.hooks = group.hooks.filter(
        (h) => !h.command || !h.command.includes(HOOK_IDENTIFIER)
      );
      return group.hooks.length > 0;
    });

    if (hooksData.hooks.PreToolUse.length === 0) {
      delete hooksData.hooks.PreToolUse;
    }

    fs.writeFileSync(hooksPath, JSON.stringify(hooksData, null, 2) + "\n", "utf-8");
    return { success: true, removed: hooksData.hooks.PreToolUse?.length !== initialLen };
  }

  return { success: true, removed: false };
}

function status() {
  const hooksPath = getCodexHooksPath();
  if (!fs.existsSync(hooksPath)) {
    return { installed: false, reason: "Codex hooks.json not found" };
  }

  try {
    const hooksData = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
    const installed =
      hooksData.hooks &&
      Array.isArray(hooksData.hooks.PreToolUse) &&
      hooksData.hooks.PreToolUse.some(
        (g) =>
          Array.isArray(g.hooks) &&
          g.hooks.some((h) => h.command && h.command.includes(HOOK_IDENTIFIER))
      );
    return { installed: Boolean(installed), path: hooksPath };
  } catch (e) {
    return { installed: false, error: e.message };
  }
}

module.exports = {
  install,
  uninstall,
  status,
};
