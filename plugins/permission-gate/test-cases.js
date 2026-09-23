"use strict";

const { evaluateToolCall } = require("./lib/policy-engine");
const policy = require("./policy.json");

const cwd = "/Users/caio/C4work/c4-plugin-herdr";
const workspaceRoot = cwd;

const testCases = [
  {
    name: "pnpm filter test",
    cmd: "pnpm --filter @nin-rpg/game-core test",
    expected: "ALLOW",
  },
  {
    name: "pnpm check",
    cmd: "pnpm check",
    expected: "ALLOW",
  },
  {
    name: "pnpm biome check",
    cmd: "pnpm biome check --write .",
    expected: "ALLOW",
  },
  {
    name: "pnpm recursive typecheck",
    cmd: "pnpm -r --if-present typecheck",
    expected: "ALLOW",
  },
  {
    name: "pnpm check && pnpm build",
    cmd: "pnpm check && pnpm build",
    expected: "ALLOW",
  },
  {
    name: "git add && git commit",
    cmd: `git add packages/game-content/src/index.ts apps/web/src/FormationTreeVisual.tsx apps/web/src/FormationTreeVisual.test.tsx apps/web/src/App.tsx apps/web/src/styles.css docs/tasks/005-personagem-progressao.md && git commit -m "feat(web,content): overhaul formation tree with interactive constellation mandala and node inspector"`,
    expected: "ALLOW",
  },
  {
    name: "python3 inline script",
    cmd: `python3 -c "\nimport csv, glob, os, re\nfrom collections import defaultdict\n"`,
    expected: "ALLOW",
  },
  {
    name: "compound safe and git push",
    cmd: "pnpm test && git push origin main",
    expected: "ASK",
  },
  {
    name: "git push alone",
    cmd: "git push origin main",
    expected: "ASK",
  },
  {
    name: "read-only query outside workspace",
    cmd: "cat /tmp/test.log 2>/dev/null || echo 'empty'",
    expected: "ALLOW",
  },
  {
    name: "tail outside workspace",
    cmd: "tail -n 5 /tmp/test.log",
    expected: "ALLOW",
  },
  {
    name: "compound with unclassified command",
    cmd: "pnpm check && ./untrusted-script.sh",
    expected: "ASK",
  },
  {
    name: "git push force delegate to user",
    cmd: "git push --force origin main",
    expected: "DELEGATE_TO_USER",
  },
  {
    name: "npm publish delegate to user",
    cmd: "npm publish",
    expected: "DELEGATE_TO_USER",
  },
  {
    name: "sudo delegate to user",
    cmd: "sudo systemctl restart nginx",
    expected: "DELEGATE_TO_USER",
  },
  {
    name: "chmod 777 hard deny",
    cmd: "chmod 777 secret.txt",
    expected: "HARD_DENY",
  },
  {
    name: "accessing sensitive file hard deny",
    cmd: "cat .env",
    expected: "HARD_DENY",
  },
  {
    name: "accessing .env.example allowed",
    cmd: "cat .env.example",
    expected: "ALLOW",
  },
  {
    name: "mkdir inside workspace allowed",
    cmd: "mkdir -p packages/core/src",
    expected: "ALLOW",
  },
  {
    name: "touch inside workspace allowed",
    cmd: "touch README.md",
    expected: "ALLOW",
  },
  {
    name: "git restore inside workspace allowed",
    cmd: "git restore apps/web/src/App.tsx",
    expected: "ALLOW",
  },
  {
    name: "pnpm add scoped package allowed",
    cmd: "pnpm add @nin-rpg/game-core",
    expected: "ALLOW",
  },
  {
    name: "git commit with slash in message allowed",
    cmd: 'git commit -m "fix/refactor: update UI layout"',
    expected: "ALLOW",
  },
  {
    name: "git checkout branch with slash allowed",
    cmd: "git checkout -b feat/my-branch",
    expected: "ALLOW",
  },
];

let failed = 0;
for (const tc of testCases) {
  const res = evaluateToolCall({
    toolName: "run_command",
    params: { CommandLine: tc.cmd },
    cwd,
    workspaceRoot,
    policy,
  });

  const pass = res.decision === tc.expected;
  if (!pass) failed++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${tc.name}`);
  if (!pass) {
    console.log(`  Expected: ${tc.expected}, Got: ${res.decision}`);
    console.log(`  Reason: ${res.reason}`);
  }
}

console.log(`\nTotal: ${testCases.length}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
