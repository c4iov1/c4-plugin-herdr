"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXTENSION_NAME = "c4-permission-gate";

function getPiSettingsPath() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".pi", "agent", "settings.json");
}

function install(gatekeeperBinPath) {
  const settingsPath = getPiSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    return { success: true, skipped: true, reason: "Pi not installed" };
  }

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch (_e) {
      settings = {};
    }
  }

  // Ensure activeExtensions includes c4-permission-gate if supported
  if (Array.isArray(settings.activeExtensions)) {
    if (!settings.activeExtensions.includes(EXTENSION_NAME)) {
      settings.activeExtensions.unshift(EXTENSION_NAME);
    }
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return { success: true, path: settingsPath };
}

function uninstall() {
  const settingsPath = getPiSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { success: true, removed: false };
  }

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (_e) {
    return { success: false, error: "Failed to parse Pi settings.json" };
  }

  if (Array.isArray(settings.activeExtensions)) {
    const idx = settings.activeExtensions.indexOf(EXTENSION_NAME);
    if (idx !== -1) {
      settings.activeExtensions.splice(idx, 1);
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      return { success: true, removed: true };
    }
  }

  return { success: true, removed: false };
}

function status() {
  const settingsPath = getPiSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return { installed: false, reason: "Pi settings.json not found" };
  }

  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const installed =
      Array.isArray(settings.activeExtensions) &&
      settings.activeExtensions.includes(EXTENSION_NAME);
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
