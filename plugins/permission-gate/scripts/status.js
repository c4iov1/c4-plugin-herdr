#!/usr/bin/env node
"use strict";

const claude = require("../lib/integrators/claude");
const codex = require("../lib/integrators/codex");
const agy = require("../lib/integrators/agy");
const pi = require("../lib/integrators/pi");

function run() {
  console.log("🔍 [c4.permission-gate] Checking integration status...\n");

  const agents = [
    { name: "Claude Code", status: claude.status() },
    { name: "OpenAI Codex", status: codex.status() },
    { name: "Antigravity CLI (Agy)", status: agy.status() },
    { name: "Pi Agent", status: pi.status() },
  ];

  for (const { name, status } of agents) {
    if (status.installed) {
      console.log(`  🟢 ${name}: Active (${status.path})`);
    } else {
      console.log(`  ⚪ ${name}: Inactive (${status.reason || "Not configured"})`);
    }
  }

  console.log("");
}

run();
