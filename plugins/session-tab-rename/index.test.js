"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  agyData,
  firstUserPrompt,
  normalizeAgent,
  scanJsonl,
  sessionName,
  stripWorkspaceSuffix,
} = require("./index.js");

test("normalizes agent aliases", () => {
  assert.equal(normalizeAgent("Antigravity CLI"), "agy");
  assert.equal(normalizeAgent("claude-code"), "claude");
  assert.equal(normalizeAgent("opencode"), "opencode");
});

test("extracts native names and first prompts from provider lines", () => {
  assert.equal(
    sessionName("pi", { type: "session_info", name: "Fix auth" }),
    "Fix auth",
  );
  assert.equal(
    firstUserPrompt("codex", {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ input_text: "Review the login flow" }],
      },
    }),
    "Review the login flow",
  );
  assert.equal(
    sessionName("claude", { type: "custom-title", customTitle: "OAuth review" }),
    "OAuth review",
  );
  assert.equal(
    firstUserPrompt("agy", { type: "USER_INPUT", content: "<USER_REQUEST>Run tests</USER_REQUEST>" }),
    "Run tests",
  );
});

test("removes the workspace suffix but preserves the session name", () => {
  assert.equal(
    stripWorkspaceSuffix("Implement cache | c4-plugin-herdr", ["c4-plugin-herdr"]),
    "Implement cache",
  );
  assert.equal(
    stripWorkspaceSuffix("Implement cache · c4-plugin-herdr", ["c4-plugin-herdr"]),
    "Implement cache",
  );
  assert.equal(
    stripWorkspaceSuffix("Implement cache | another-project", ["c4-plugin-herdr"]),
    "Implement cache | another-project",
  );
});

test("scans a Pi JSONL session name and prompt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-tab-rename-"));
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session", cwd: "/repo" }),
    JSON.stringify({ type: "session_info", name: "Implement cache" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ text: "Implement cache" }] } }),
  ].join("\n"));
  assert.deepEqual(scanJsonl(file, "pi"), {
    name: "Implement cache",
    prompt: "Implement cache",
    cwd: "/repo",
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test("reads Agy rename commands and first prompt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-tab-rename-agy-"));
  fs.writeFileSync(path.join(root, "history.jsonl"), [
    JSON.stringify({ conversationId: "agy-1", type: "user", display: "Fix deployment" }),
    JSON.stringify({ conversationId: "agy-1", type: "slash_command", display: "/rename Deploy API" }),
  ].join("\n"));
  process.env.ANTIGRAVITY_HOME = root;
  assert.deepEqual(agyData("agy-1"), { name: "Deploy API", prompt: "Fix deployment" });
  delete process.env.ANTIGRAVITY_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});
