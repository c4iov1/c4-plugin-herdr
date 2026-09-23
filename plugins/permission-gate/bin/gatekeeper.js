#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
let evaluateToolCall;
let notifyHerdr = () => {};

try {
  ({ evaluateToolCall } = require("../lib/policy-engine"));
} catch (err) {
  console.error(`[c4-permission-gate] Warning: failed to load policy-engine: ${err.message}`);
}

try {
  ({ notifyHerdr } = require("../lib/herdr-notify"));
} catch (err) {
  console.error(`[c4-permission-gate] Warning: failed to load herdr-notify: ${err.message}`);
}

function loadPolicy() {
  const policyPath = path.join(__dirname, "..", "policy.json");
  try {
    return JSON.parse(fs.readFileSync(policyPath, "utf-8"));
  } catch (err) {
    console.error(`[c4-permission-gate] Warning: failed to read policy.json: ${err.message}`);
    return {
      protectedPaths: ["\\.env$"],
      protectedPathsWhitelist: ["\\.env\\.example$"],
      hardDenyPatterns: [],
      delegateToUserPatterns: [],
      askPatterns: [],
      safeCommandPrefixes: [],
      autoApprovedTools: ["write", "edit", "read", "view_file"],
    };
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let agent = "auto";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) {
      agent = args[i + 1].toLowerCase();
      i++;
    }
  }
  return { agent };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");

    process.stdin.on("data", (chunk) => {
      data += chunk;
    });

    process.stdin.on("end", () => {
      resolve(data.trim());
    });

    process.stdin.on("error", () => {
      resolve("");
    });
  });
}

function normalizePayload(rawJson) {
  let parsed = {};
  if (rawJson) {
    try {
      parsed = JSON.parse(rawJson);
    } catch (_e) {
      parsed = {};
    }
  }

  const toolName =
    parsed.toolCall?.name ||
    parsed.tool_name ||
    parsed.toolName ||
    parsed.tool ||
    "run_command";

  const params =
    parsed.toolCall?.args ||
    parsed.tool_input ||
    parsed.arguments ||
    parsed.input ||
    parsed.args ||
    parsed;

  const workspaceRoot =
    (Array.isArray(parsed.workspacePaths) && parsed.workspacePaths[0]) ||
    parsed.workspaceRoot ||
    parsed.cwd ||
    process.cwd();

  const cwd = (params && params.cwd) || parsed.cwd || workspaceRoot;

  return {
    raw: parsed,
    toolName,
    params: typeof params === "object" && params !== null ? params : {},
    workspaceRoot,
    cwd,
  };
}

async function main() {
  const { agent } = parseArgs();
  const rawInput = await readStdin();
  const { toolName, params, workspaceRoot, cwd } = normalizePayload(rawInput);
  const policy = loadPolicy();

  const isAgy = agent === "agy";
  const isClaude = agent === "claude";
  const isCodex = agent === "codex";

  if (!evaluateToolCall) {
    if (isAgy) {
      process.stdout.write(
        JSON.stringify({
          decision: "force_ask",
          reason: "Permission gate engine temporarily unavailable",
        }) + "\n"
      );
      process.exit(0);
    }
    process.exit(0);
  }

  const evalResult = evaluateToolCall({
    toolName,
    params,
    cwd,
    workspaceRoot,
    policy,
  });

  try {
    fs.appendFileSync(
      "/tmp/c4-gatekeeper.log",
      `[${new Date().toISOString()}] agent=${agent} tool=${toolName} decision=${evalResult.decision} target="${(evalResult.command || evalResult.target || "").slice(0, 100)}"\n`
    );
  } catch (_e) {}

  switch (evalResult.decision) {
    case "ALLOW": {
      if (isAgy) {
        process.stdout.write(
          JSON.stringify({
            decision: "allow",
            reason: evalResult.reason,
          }) + "\n"
        );
      }
      process.exit(0);
      break;
    }

    case "HARD_DENY": {
      notifyHerdr(
        "🛑 Comando Bloqueado",
        `Agente tentou comando perigoso: ${(evalResult.command || evalResult.target || "").slice(0, 120)}`
      );

      if (isAgy) {
        process.stdout.write(
          JSON.stringify({
            decision: "deny",
            reason: evalResult.directive || evalResult.reason,
          }) + "\n"
        );
        process.exit(0);
      }

      // For Claude Code and Codex, print directive to stderr and exit with error code
      console.error(evalResult.directive || evalResult.reason);
      process.exit(isClaude ? 2 : 1);
      break;
    }

    case "DELEGATE_TO_USER": {
      notifyHerdr(
        "⚠️ Ação Manual Requerida",
        `Agente precisa que você execute: ${(evalResult.command || "").slice(0, 120)}`
      );

      if (isAgy) {
        process.stdout.write(
          JSON.stringify({
            decision: "deny",
            reason: evalResult.directive,
          }) + "\n"
        );
        process.exit(0);
      }

      console.error(evalResult.directive);
      process.exit(isClaude ? 2 : 1);
      break;
    }

    case "ASK":
    default: {
      notifyHerdr(
        "⚠️ Permissão Solicitada",
        `Agente solicitando aprovação para: ${(evalResult.command || evalResult.target || "").slice(0, 120)}`
      );

      if (isAgy) {
        process.stdout.write(
          JSON.stringify({
            decision: "force_ask",
            reason: evalResult.reason,
          }) + "\n"
        );
        process.exit(0);
      }

      // In Claude Code and Codex, normal exit allows the native prompt to handle interactive approval
      process.exit(0);
      break;
    }
  }
}

main().catch((err) => {
  console.error(`[c4-permission-gate] Fatal error: ${err.message}`);
  const { agent } = parseArgs();
  if (agent === "agy") {
    process.stdout.write(
      JSON.stringify({
        decision: "force_ask",
        reason: `Permission gate encountered error: ${err.message}`,
      }) + "\n"
    );
    process.exit(0);
  }
  process.exit(1);
});
