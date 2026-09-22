"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HOOK_NAME = "c4-permission-gate";

function getAgyHooksPath() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".gemini", "config", "hooks.json");
}

function getAgySettingsPath() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

function install(gatekeeperBinPath) {
  // 1. Configure hooks.json in ~/.gemini/config/hooks.json
  const hooksPath = getAgyHooksPath();
  const hooksDir = path.dirname(hooksPath);
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  let data = {};
  if (fs.existsSync(hooksPath)) {
    try {
      data = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
    } catch (_e) {
      data = {};
    }
  }

  const hookCommand = `node "${gatekeeperBinPath}" --agent agy`;

  data[HOOK_NAME] = {
    PreToolUse: [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: hookCommand,
            timeout: 30,
          },
        ],
      },
    ],
  };

  fs.writeFileSync(hooksPath, JSON.stringify(data, null, 2) + "\n", "utf-8");

  // 2. Configure mode and auto-approval in ~/.gemini/antigravity-cli/settings.json
  const settingsPath = getAgySettingsPath();
  const settingsDir = path.dirname(settingsPath);
  if (fs.existsSync(settingsDir)) {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      } catch (_e) {
        settings = {};
      }
    }

    settings.mode = "accept-edits";

    if (!settings.permissions || typeof settings.permissions !== "object") {
      settings.permissions = { allow: [] };
    }
    if (!Array.isArray(settings.permissions.allow)) {
      settings.permissions.allow = [];
    }

    const autoRules = [
      "command(*)",
      "write_file(*)",
      "write_file(/)",
      "read_file(*)",
    ];
    for (const rule of autoRules) {
      if (!settings.permissions.allow.includes(rule)) {
        settings.permissions.allow.push(rule);
      }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  return { success: true, path: hooksPath };
}

function uninstall() {
  const hooksPath = getAgyHooksPath();
  let hookRemoved = false;

  if (fs.existsSync(hooksPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
      if (data[HOOK_NAME]) {
        delete data[HOOK_NAME];
        fs.writeFileSync(hooksPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
        hookRemoved = true;
      }
    } catch (_e) {}
  }

  const settingsPath = getAgySettingsPath();
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (settings.mode === "accept-edits") {
        settings.mode = "default";
      }
      if (settings.permissions && Array.isArray(settings.permissions.allow)) {
        const rules = new Set(["command(*)", "write_file(*)", "write_file(/)", "read_file(*)"]);
        settings.permissions.allow = settings.permissions.allow.filter((r) => !rules.has(r));
      }
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    } catch (_e) {}
  }

  return { success: true, removed: hookRemoved };
}

function status() {
  const hooksPath = getAgyHooksPath();
  const settingsPath = getAgySettingsPath();

  if (!fs.existsSync(hooksPath)) {
    return { installed: false, reason: "Agy hooks.json not found" };
  }

  try {
    const data = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
    const hookConfigured = Boolean(data[HOOK_NAME]);

    let modeConfigured = false;
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      modeConfigured = settings.mode === "accept-edits";
    }

    return {
      installed: hookConfigured,
      mode: modeConfigured ? "accept-edits" : "default",
      path: hooksPath,
    };
  } catch (e) {
    return { installed: false, error: e.message };
  }
}

module.exports = {
  install,
  uninstall,
  status,
};
