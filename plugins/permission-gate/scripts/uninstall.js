#!/usr/bin/env node
"use strict";

const claude = require("../lib/integrators/claude");
const codex = require("../lib/integrators/codex");
const agy = require("../lib/integrators/agy");
const pi = require("../lib/integrators/pi");

function run() {
  console.log("🧹 [c4.permission-gate] Removing hooks from all agent CLIs...\n");

  const results = [
    { name: "Claude Code", res: claude.uninstall() },
    { name: "OpenAI Codex", res: codex.uninstall() },
    { name: "Antigravity CLI (Agy)", res: agy.uninstall() },
    { name: "Pi Agent", res: pi.uninstall() },
  ];

  for (const { name, res } of results) {
    if (res.success) {
      if (res.removed) {
        console.log(`  ✅ ${name}: Hook removed successfully.`);
      } else {
        console.log(`  ⚪ ${name}: No hook was present.`);
      }
    } else {
      console.log(`  ❌ ${name}: Error during removal: ${res.error}`);
    }
  }

  console.log("\nUninstallation complete.");
}

run();
