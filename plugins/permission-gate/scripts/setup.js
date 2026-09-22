#!/usr/bin/env node
"use strict";

const path = require("node:path");
const claude = require("../lib/integrators/claude");
const codex = require("../lib/integrators/codex");
const agy = require("../lib/integrators/agy");
const pi = require("../lib/integrators/pi");

const gatekeeperBin = path.resolve(__dirname, "..", "bin", "gatekeeper.js");
const verifyOnly = process.argv.includes("--verify-only");

function run() {
  if (verifyOnly) {
    // Startup check: verify if hooks are installed
    const cStatus = claude.status();
    const xStatus = codex.status();
    const aStatus = agy.status();

    if (!cStatus.installed || !xStatus.installed || !aStatus.installed) {
      // Auto-install missing hooks during Herdr startup
      claude.install(gatekeeperBin);
      codex.install(gatekeeperBin);
      agy.install(gatekeeperBin);
      pi.install(gatekeeperBin);
    }
    return;
  }

  console.log("🛡️  [c4.permission-gate] Installing hooks across all agent CLIs...\n");

  const results = [
    { name: "Claude Code", res: claude.install(gatekeeperBin) },
    { name: "OpenAI Codex", res: codex.install(gatekeeperBin) },
    { name: "Antigravity CLI (Agy)", res: agy.install(gatekeeperBin) },
    { name: "Pi Agent", res: pi.install(gatekeeperBin) },
  ];

  let anyError = false;
  for (const { name, res } of results) {
    if (res.skipped) {
      console.log(`  ⚪ ${name}: Skipped (${res.reason})`);
    } else if (res.success) {
      console.log(`  ✅ ${name}: Hook successfully configured (${res.path})`);
    } else {
      console.log(`  ❌ ${name}: Failed to configure: ${res.error}`);
      anyError = true;
    }
  }

  console.log("\n✨ Permission gate hooks are active!");
  console.log("All coding agents will now auto-approve workspace edits and enforce safety directives.\n");

  if (anyError) process.exit(1);
}

run();
