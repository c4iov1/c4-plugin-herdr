const { spawnSync } = require("node:child_process");

// 1. Resolve Herdr binary from environment
const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

console.log("🚀 [Herdr Plugin] Starting Node action handler...");
console.log(`Plugin ID: ${process.env.HERDR_PLUGIN_ID || "unknown"}`);
console.log(`Plugin Root: ${process.env.HERDR_PLUGIN_ROOT || __dirname}`);
console.log(`Config Dir: ${process.env.HERDR_PLUGIN_CONFIG_DIR || "none"}`);
console.log(`State Dir: ${process.env.HERDR_PLUGIN_STATE_DIR || "none"}`);

// 2. Parse Context JSON if available
if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON);
    console.log("Herdr Invocation Context:", JSON.stringify(ctx, null, 2));
  } catch (err) {
    console.warn("Could not parse HERDR_PLUGIN_CONTEXT_JSON:", err.message);
  }
}

// 3. Call Herdr CLI
console.log("\nExecuting `herdr workspace list`...");
const result = spawnSync(herdrBin, ["workspace", "list"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}

process.exit(result.status ?? 0);
