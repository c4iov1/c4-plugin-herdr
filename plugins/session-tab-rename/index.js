"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MAX_LABEL_LENGTH = 80;
const MAX_SCAN_FILES = 300;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "pwsh", "powershell"]);

function debug(...args) {
  if (process.env.HERDR_PLUGIN_DEBUG === "1") {
    console.error("[session-tab-rename]", ...args);
  }
}

function commandPath() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: options.timeout ?? 3000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      env: options.env || process.env,
    }).trim();
  } catch (error) {
    debug(`${command} failed`, error.message);
    return null;
  }
}

function herdr(args, options = {}) {
  return run(commandPath(), args, options);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function snapshot() {
  const response = parseJson(herdr(["api", "snapshot"], { timeout: 4000 }));
  return response?.result?.snapshot || response?.snapshot || response?.result || null;
}

function arrays(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeAgent(value) {
  const agent = String(value || "").toLowerCase().trim().replace(/[\s_]+/g, "-");
  if (["antigravity", "antigravity-cli", "agy"].includes(agent)) return "agy";
  if (["claude-code", "claude"].includes(agent)) return "claude";
  if (["cursor-agent", "cursor"].includes(agent)) return "cursor";
  if (["github-copilot", "github-copilot-cli", "copilot"].includes(agent)) return "copilot";
  return agent;
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function envOrHome(name, suffix) {
  return process.env[name] || path.join(homeDir(), suffix);
}

function agentRoots(agent) {
  switch (agent) {
    case "pi": {
      const root = process.env.PI_CODING_AGENT_DIR || path.join(homeDir(), ".pi", "agent");
      return [path.join(root, "sessions")];
    }
    case "claude":
      return [path.join(envOrHome("CLAUDE_CONFIG_DIR", ".claude"), "projects")];
    case "codex":
      return [envOrHome("CODEX_HOME", ".codex")];
    case "agy":
      return [envOrHome("ANTIGRAVITY_HOME", path.join(".gemini", "antigravity-cli"))];
    default:
      return [];
  }
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningful(value) {
  const text = cleanText(value);
  return text && text !== "(empty)" ? text : null;
}

function compact(value, limit = MAX_LABEL_LENGTH) {
  const text = meaningful(value);
  if (!text) return null;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function stripWorkspaceSuffix(value, workspaceNames) {
  const text = meaningful(value);
  if (!text) return null;
  const names = workspaceNames.map((name) => meaningful(name)?.toLowerCase()).filter(Boolean);
  const separators = [...text.matchAll(/\s+(?:\||·|—|–)\s+/g)];
  const separator = separators.at(-1);
  if (!separator) return text;
  const suffix = text.slice(separator.index + separator[0].length).toLowerCase();
  return names.includes(suffix) ? meaningful(text.slice(0, separator.index)) : text;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((item) => item && (item.text ?? item.input_text))
    .filter((item) => typeof item === "string");
  return parts.length ? parts.join(" ") : null;
}

function firstUserPrompt(agent, value) {
  const type = value?.type;
  if (agent === "pi") {
    if (type !== "message" || value.message?.role !== "user") return null;
    return meaningful(contentText(value.message.content));
  }
  if (agent === "codex") {
    if (type !== "response_item" || value.payload?.type !== "message" || value.payload?.role !== "user") {
      return null;
    }
    return meaningful(contentText(value.payload.content));
  }
  if (agent === "agy") {
    if (type !== "USER_INPUT") return null;
    const raw = String(contentText(value.content) || "");
    const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
    const cleaned = match ? match[1] : raw.replace(/<\/?USER_REQUEST>/gi, "");
    return meaningful(cleaned);
  }
  const role = value?.role || value?.message?.role;
  if (role !== "user") return null;
  const content = value?.content ?? value?.message?.content ?? value?.message;
  return meaningful(contentText(content) || content);
}

function sessionName(agent, value) {
  if (agent === "pi" && value?.type === "session_info") return meaningful(value.name);
  if (agent === "claude" && value?.type === "custom-title") return meaningful(value.customTitle);
  if (agent === "claude" && value?.type === "agent-name") return meaningful(value.agentName);
  if (agent === "codex" && value?.thread_name) return meaningful(value.thread_name);
  return meaningful(value?.display_name ?? value?.displayName ?? value?.title);
}

function scanJsonl(file, agent) {
  const text = readText(file);
  if (!text) return { name: null, prompt: null, cwd: null };
  let name = null;
  let prompt = null;
  let cwd = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const value = parseJson(line);
    if (!value) continue;
    name ||= sessionName(agent, value);
    prompt ||= firstUserPrompt(agent, value);
    if (agent === "pi" && value.type === "session") cwd ||= meaningful(value.cwd);
    if (agent === "codex" && value.type === "session_meta") {
      cwd ||= meaningful(value.payload?.cwd);
    }
  }
  return { name, prompt, cwd };
}

function walkFiles(root, predicate, limit = MAX_SCAN_FILES) {
  const result = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && result.length < limit) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (result.length >= limit) break;
      const file = path.join(current.dir, entry.name);
      if (entry.isFile() && predicate(file, entry.name)) result.push(file);
      else if (entry.isDirectory() && current.depth < 6 && !entry.name.startsWith(".")) {
        queue.push({ dir: file, depth: current.depth + 1 });
      }
    }
  }
  return result;
}

function findSessionFile(agent, sessionId) {
  if (!sessionId) return null;
  for (const root of agentRoots(agent)) {
    const direct = [
      path.join(root, `${sessionId}.jsonl`),
      path.join(root, sessionId, `${sessionId}.jsonl`),
    ];
    for (const file of direct) if (fs.existsSync(file)) return file;
    const files = walkFiles(root, (file, name) =>
      name.endsWith(".jsonl") && (name.includes(sessionId) || path.basename(file, ".jsonl") === sessionId));
    if (files.length) return files[0];
  }
  return null;
}

function sqliteQuery(file, query) {
  if (!fs.existsSync(file)) return null;
  return run("sqlite3", ["-readonly", "-batch", "-separator", "\t", file, query], {
    timeout: 1500,
    maxBuffer: 1024 * 1024,
  });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function codexLogPrompt(sessionId, root) {
  const body = sqliteQuery(path.join(root, "logs_2.sqlite"),
    `select feedback_log_body from logs
     where thread_id = ${sqlString(sessionId)}
       and feedback_log_body like '%websocket request:%'
       and feedback_log_body like '%\"role\":\"user\"%'
       and feedback_log_body like '%\"input_text\"%'
     order by ts asc, ts_nanos asc limit 1;`);
  const request = body?.split("websocket request: ").at(-1);
  const parsed = parseJson(request);
  for (const item of arrays(parsed?.input)) {
    const prompt = firstUserPrompt("codex", { type: "response_item", payload: item });
    if (prompt) return prompt;
  }
  return null;
}

function codexData(sessionId) {
  const root = envOrHome("CODEX_HOME", ".codex");
  let name = null;
  let prompt = null;
  const index = readText(path.join(root, "session_index.jsonl"));
  if (index) {
    for (const line of index.split(/\r?\n/)) {
      const value = parseJson(line);
      if (value?.id === sessionId) name = meaningful(value.thread_name) || name;
    }
  }
  const history = readText(path.join(root, "history.jsonl"));
  if (history) {
    for (const line of history.split(/\r?\n/)) {
      const value = parseJson(line);
      if (value?.session_id === sessionId && !String(value.type || "").includes("slash")) {
        prompt ||= meaningful(value.text);
      }
    }
  }
  const file = findSessionFile("codex", sessionId);
  if (file) {
    const scanned = scanJsonl(file, "codex");
    name ||= scanned.name;
    prompt ||= scanned.prompt;
  }
  prompt ||= codexLogPrompt(sessionId, root);
  const row = sqliteQuery(path.join(root, "state_5.sqlite"),
    `select title, first_user_message, preview from threads where id = ${sqlString(sessionId)} limit 1;`);
  if (row) {
    const [title, first, preview] = row.split("\t");
    name ||= meaningful(title);
    prompt ||= meaningful(first) || meaningful(preview);
  }
  return { name, prompt };
}

function claudeData(sessionId, sessionRef) {
  const file = sessionRef?.kind === "path" && fs.existsSync(sessionRef.value)
    ? sessionRef.value
    : findSessionFile("claude", sessionId);
  if (!file) return { name: null, prompt: null };
  const data = scanJsonl(file, "claude");
  return data;
}

function piData(sessionId, sessionRef) {
  const file = sessionRef?.kind === "path" && fs.existsSync(sessionRef.value)
    ? sessionRef.value
    : findSessionFile("pi", sessionId);
  if (!file) return { name: null, prompt: null };
  return scanJsonl(file, "pi");
}

function agyData(sessionId) {
  if (!sessionId) return { name: null, prompt: null };
  const root = agentRoots("agy")[0];
  let name = null;
  let prompt = null;

  // 1. History JSONL (slash commands /rename have high precedence)
  const history = readText(path.join(root, "history.jsonl"));
  if (history) {
    for (const line of history.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const value = parseJson(line);
      if (value?.conversationId !== sessionId) continue;
      const display = meaningful(value.display);
      if (value.type === "slash_command") {
        const rename = String(display || "").match(/^\/rename\s+(.+)$/i);
        if (rename) name = meaningful(rename[1]);
      } else {
        prompt ||= display;
      }
    }
  }

  // 2. Annotations pbtxt
  const annotation = path.join(root, "annotations", `${sessionId}.pbtxt`);
  const annotationText = readText(annotation);
  const match = annotationText?.match(/title:\s*["']?([^"\r\n]+)["']?/);
  name ||= meaningful(match?.[1]);

  // 3. SQLite conversation_summaries.db
  const dbFile = path.join(root, "conversation_summaries.db");
  const row = sqliteQuery(
    dbFile,
    `SELECT title, preview FROM conversation_summaries WHERE conversation_id = ${sqlString(sessionId)} LIMIT 1;`
  );
  if (row) {
    const [title, preview] = row.split("\t");
    name ||= meaningful(title);
    prompt ||= meaningful(preview);
  }

  // 4. Transcript JSONL fallback for prompt
  if (!prompt) {
    const transcript = path.join(root, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
    const transcriptText = readText(transcript);
    if (transcriptText) {
      for (const line of transcriptText.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const val = parseJson(line);
        const p = firstUserPrompt("agy", val);
        if (p) {
          prompt = p;
          break;
        }
      }
    }
  }

  // Avoid raw UUIDs as session titles
  if (name && (name === sessionId || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name))) {
    name = null;
  }

  return { name, prompt };
}

function opencodeDbPaths() {
  const dataRoots = [];
  if (process.env.OPENCODE_DATA_DIR) dataRoots.push(process.env.OPENCODE_DATA_DIR);
  if (process.env.XDG_DATA_HOME) dataRoots.push(path.join(process.env.XDG_DATA_HOME, "opencode"));
  dataRoots.push(path.join(homeDir(), ".local", "share", "opencode"));
  if (process.platform === "darwin") {
    dataRoots.push(path.join(homeDir(), "Library", "Application Support", "opencode"));
  }
  if (process.env.LOCALAPPDATA) dataRoots.push(path.join(process.env.LOCALAPPDATA, "opencode"));
  return [...new Set(dataRoots.map((root) => path.join(root, "opencode.db")))];
}

function opencodeDbData(sessionId) {
  for (const file of opencodeDbPaths()) {
    const name = sqliteQuery(file,
      `select title from session where id = ${sqlString(sessionId)} limit 1;`);
    const prompt = sqliteQuery(file,
      `select json_extract(p.data, '$.text')
       from message m join part p on p.message_id = m.id
       where m.session_id = ${sqlString(sessionId)}
         and json_extract(m.data, '$.role') = 'user'
         and json_extract(p.data, '$.type') = 'text'
       order by m.time_created, p.time_created limit 1;`);
    if (meaningful(name) || meaningful(prompt)) {
      return { name: meaningful(name), prompt: meaningful(prompt) };
    }
  }
  return { name: null, prompt: null };
}

function opencodeData(sessionId) {
  const output = run(process.env.OPENCODE_BIN_PATH || "opencode", ["session", "list", "--format", "json"], {
    timeout: 2000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = parseJson(output);
  const items = Array.isArray(parsed)
    ? parsed
    : arrays(parsed?.sessions || parsed?.result?.sessions || parsed?.result || parsed?.data)
      .concat(parsed?.id ? [parsed] : []);
  const item = items.find((entry) =>
    entry?.id === sessionId || entry?.sessionID === sessionId || entry?.session_id === sessionId);
  const db = opencodeDbData(sessionId);
  return {
    name: meaningful(item?.title || item?.name) || db.name,
    prompt: meaningful(item?.first_user_message || item?.preview) || db.prompt,
  };
}

function findAgyPid(paneId) {
  if (!paneId) return null;
  const processInfo = parseJson(herdr(["pane", "process-info", "--pane", paneId], { timeout: 1500 }));
  const processes = processInfo?.result?.process_info?.foreground_processes || [];
  for (const p of processes) {
    if (["agy", "antigravity", "antigravity-cli"].includes(String(p.name || p.argv0 || "").toLowerCase())) {
      return p.pid;
    }
  }
  // When agy runs a tool/command, it may not be in foreground_processes.
  // Check direct children of shell_pid to find the agy process in this pane.
  const shellPid = processInfo?.result?.process_info?.shell_pid;
  if (shellPid) {
    const psOut = run("ps", ["-A", "-o", "pid,ppid,comm"], { timeout: 1000 });
    if (psOut) {
      for (const line of psOut.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const [pidStr, ppidStr, comm] = parts;
          if (ppidStr === String(shellPid) && comm && comm.toLowerCase().includes("agy")) {
            return parseInt(pidStr, 10);
          }
        }
      }
    }
  }
  return null;
}

function resolveAgySessionId(pane) {
  const ref = pane?.agent_session || pane?.agentSession;
  const directId = ref?.value || pane?.agent_session_id || pane?.agentSessionId;
  if (directId) return directId;

  const pid = findAgyPid(pane?.pane_id);
  if (pid) {
    let sessionId = null;
    if (process.platform === "linux") {
      try {
        const fds = fs.readdirSync(`/proc/${pid}/fd`);
        for (const fd of fds) {
          const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          const m = target.match(/\/presence\/([a-f0-9-]+)\.lock$/) ||
                    target.match(/\/conversations\/([a-f0-9-]+)\.db/) ||
                    target.match(/\/brain\/([a-f0-9-]+)/);
          if (m) {
            sessionId = m[1];
            break;
          }
        }
      } catch {}
    } else {
      const out = run("lsof", ["-p", String(pid), "-Fn"], { timeout: 1000 });
      if (out) {
        const m = out.match(/n.*\/presence\/([a-f0-9-]+)\.lock/) ||
                  out.match(/n.*\/conversations\/([a-f0-9-]+)\.db/) ||
                  out.match(/n.*\/brain\/([a-f0-9-]+)/);
        if (m) {
          sessionId = m[1];
        }
      }
    }

    if (sessionId) {
      if (pane?.pane_id) {
        herdr(["pane", "report-agent-session", "--source", "herdr:session-tab-rename", "--agent", "agy", "--agent-session-id", sessionId, pane.pane_id]);
      }
      return sessionId;
    }
  }

  return null;
}

function nativeSessionData(pane, cache, record) {
  const agent = normalizeAgent(pane?.agent || pane?.agent_session?.agent);
  const ref = pane?.agent_session || pane?.agentSession || null;
  let sessionId = ref?.value || pane?.agent_session_id || pane?.agentSessionId;
  if (agent === "agy") {
    if (!sessionId) {
      sessionId = resolveAgySessionId(pane);
    }
    if (!sessionId && record?.sessionId) {
      sessionId = record.sessionId;
    }
  }
  if (!agent || !sessionId) return { agent, sessionId: null, name: null, prompt: null };
  const key = `${agent}:${ref?.kind || "id"}:${sessionId}`;
  if (cache.has(key)) return cache.get(key);
  let data;
  switch (agent) {
    case "codex": data = codexData(sessionId); break;
    case "claude": data = claudeData(sessionId, ref); break;
    case "pi": data = piData(sessionId, ref); break;
    case "agy": data = agyData(sessionId); break;
    case "opencode": data = opencodeData(sessionId); break;
    default: data = { name: null, prompt: null };
  }
  const result = { agent, sessionId, ...data };
  cache.set(key, result);
  return result;
}

function focusedPaneForTab(tab, snap) {
  const panes = arrays(snap.panes).filter((pane) => pane.tab_id === tab.tab_id);
  const layout = arrays(snap.layouts).find((item) => item.tab_id === tab.tab_id);
  const focusedId = layout?.focused_pane_id || snap.focused_pane_id;
  const focused = panes.find((pane) => pane.pane_id === focusedId);
  return focused?.agent
    ? focused
    : panes.find((pane) => pane.agent && ["working", "blocked"].includes(pane.agent_status))
      || focused
      || panes[0];
}

function contextFromPane(pane, snap) {
  if (!pane) return null;
  const agent = normalizeAgent(pane.agent);
  const workspace = arrays(snap.workspaces).find((item) => item.workspace_id === pane.workspace_id);
  const titles = [
    pane.terminal_title_stripped,
    pane.terminal_title,
    pane.title,
    pane.label,
    pane.display_agent,
  ];
  const cwd = pane.foreground_cwd || pane.cwd;
  const cwdBase = cwd ? path.basename(cwd) : null;
  const workspaceNames = [cwdBase, workspace?.label];
  for (const candidate of titles) {
    const title = compact(stripWorkspaceSuffix(candidate, workspaceNames));
    if (!title) continue;
    const lower = title.toLowerCase();
    if (
      lower === agent
      || normalizeAgent(title) === agent
      || DEFAULT_SHELLS.has(lower)
      || lower === cwdBase?.toLowerCase()
    ) continue;
    if (!/^\d+$/.test(title)) return title;
  }
  const processInfo = parseJson(herdr(["pane", "process-info", "--pane", pane.pane_id], { timeout: 1500 }));
  const process = processInfo?.result?.process_info?.foreground_processes?.[0];
  const rawProcessName = compact(process?.argv0 || process?.name || agent, 32);
  const processName = rawProcessName && !DEFAULT_SHELLS.has(rawProcessName.toLowerCase())
    ? rawProcessName
    : null;
  const where = cwdBase || workspace?.label;
  const branch = cwd ? run("git", ["-C", cwd, "branch", "--show-current"], { timeout: 1000 }) : null;
  const context = [processName, where, meaningful(branch)].filter(Boolean).join(" · ");
  return compact(context || where);
}

function tabIdFromContext() {
  if (process.env.HERDR_TAB_ID) return process.env.HERDR_TAB_ID;
  const context = parseJson(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  return context?.tab?.tab_id || context?.tab?.id || context?.tab_id || null;
}

function paneIdFromContext() {
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
  const context = parseJson(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  return context?.pane?.pane_id || context?.pane?.id || context?.focused_pane_id || null;
}

function statePath() {
  return process.env.HERDR_PLUGIN_STATE_DIR
    ? path.join(process.env.HERDR_PLUGIN_STATE_DIR, "state.json")
    : null;
}

function loadState(file) {
  if (!file) return { tabs: {} };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { tabs: value.tabs && typeof value.tabs === "object" ? value.tabs : {} };
  } catch {
    return { tabs: {} };
  }
}

function saveState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function lockState(file) {
  if (!file) return () => {};
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    return null;
  }
  return () => {
    try { fs.rmdirSync(lock); } catch {}
  };
}

function defaultTabLabel(label) {
  return !label || /^\d+$/.test(label) || /^tab[-\s]*\d+$/i.test(label);
}

function isDefaultOrContextLabel(label, workspaceNames = []) {
  if (defaultTabLabel(label)) return true;
  const lower = String(label || "").toLowerCase();
  for (const ws of workspaceNames) {
    if (ws && lower === String(ws).toLowerCase()) return true;
  }
  // Context labels generated by contextFromPane e.g. "agy · c4-plugin-herdr · main" or "c4-plugin-herdr · main"
  if (typeof label === "string" && label.includes(" · ")) {
    return true;
  }
  return false;
}

function renameTab(tabId, label) {
  return herdr(["tab", "rename", tabId, label], { timeout: 2500 }) !== null;
}

function reconcile(options = {}) {
  const snap = snapshot();
  if (!snap) return;
  const tabs = arrays(snap.tabs);
  const paneId = options.paneId;
  const contextTabId = options.tabId;
  let targets = tabs;
  if (options.onlyTabId) {
    targets = tabs.filter((tab) => tab.tab_id === options.onlyTabId);
  } else if (paneId && !contextTabId) {
    const pane = arrays(snap.panes).find((item) => item.pane_id === paneId);
    if (pane) targets = tabs.filter((tab) => tab.tab_id === pane.tab_id);
  }
  const file = statePath();
  const state = loadState(file);
  const cache = new Map();
  for (const tab of targets) {
    const pane = focusedPaneForTab(tab, snap);
    if (!pane) continue;
    const workspace = arrays(snap.workspaces).find((item) => item.workspace_id === pane.workspace_id);
    const cwdBase = path.basename(pane.foreground_cwd || pane.cwd || "");
    const workspaceNames = [cwdBase, workspace?.label].filter(Boolean);
    const isAutoOrContext = isDefaultOrContextLabel(tab.label, workspaceNames);

    let record = state.tabs[tab.tab_id];
    if (!record) {
      const isManual = !isAutoOrContext && !defaultTabLabel(tab.label);
      record = {
        manual: isManual,
        settled: false,
        lastAutoLabel: isAutoOrContext ? null : tab.label,
        sessionId: null,
      };
      state.tabs[tab.tab_id] = record;
    }

    // Regra 1: Renomeio manual = não mexe mais no nome da aba
    if (record.manual) {
      continue;
    }

    // Se o usuário renomeou manualmente fora do plugin:
    if (record.lastAutoLabel && tab.label !== record.lastAutoLabel && !isAutoOrContext && !defaultTabLabel(tab.label)) {
      record.manual = true;
      continue;
    }

    // Regras 2 e 3: Sessão já recebeu nome definitivo (por rename ou primeiro prompt) = NÃO MEXE MAIS
    if (record.settled || (record.settled === undefined && record.lastAutoLabel && !isAutoOrContext)) {
      record.settled = true;
      continue;
    }

    // Tab ainda pendente de nome definitivo:
    const session = nativeSessionData(pane, cache, record);
    if (session.sessionId) {
      record.sessionId = session.sessionId;
    }
    const sessionName = stripWorkspaceSuffix(session.name, workspaceNames);

    let desired = null;
    let isDefinitive = false;

    if (sessionName) {
      // Sessão com rename explícito
      desired = compact(sessionName);
      isDefinitive = true;
    } else if (session.prompt) {
      // Sessão sem rename (regra de primeiro prompt)
      desired = compact(session.prompt);
      isDefinitive = true;
    } else {
      // Contexto temporário enquanto não há nem prompt nem rename
      desired = compact(contextFromPane(pane, snap));
      isDefinitive = false;
    }

    if (!desired) continue;

    if (desired !== tab.label) {
      if (renameTab(tab.tab_id, desired)) {
        debug(`renamed ${tab.tab_id}: ${tab.label} -> ${desired} (definitive: ${isDefinitive})`);
        record.lastAutoLabel = desired;
      }
    } else {
      record.lastAutoLabel = desired;
    }

    // Uma vez definido o nome definitivo: settle e não mexe mais!
    if (isDefinitive) {
      record.settled = true;
    }
  }
  saveState(file, state);
}

function renameNowCurrentTab() {
  const id = tabIdFromContext();
  const snap = snapshot();
  const tabId = id || snap?.focused_tab_id || arrays(snap?.tabs)[0]?.tab_id;
  if (!tabId) return;
  const file = statePath();
  const state = loadState(file);
  const current = state.tabs[tabId] || {};
  state.tabs[tabId] = { ...current, manual: false, settled: false };
  saveState(file, state);
  reconcile({ onlyTabId: tabId });
}

function resetCurrentTab() {
  const id = tabIdFromContext();
  const snap = snapshot();
  const tabId = id || snap?.focused_tab_id || arrays(snap?.tabs)[0]?.tab_id;
  if (!tabId) return;
  const file = statePath();
  const state = loadState(file);
  state.tabs[tabId] = { manual: false, settled: false, lastAutoLabel: null, sessionId: null };
  saveState(file, state);
  reconcile({ onlyTabId: tabId });
}

function main() {
  const mode = process.argv[2] || "event";
  const release = lockState(statePath());
  if (release === null) return;
  try {
    if (mode === "reset") {
      resetCurrentTab();
      return;
    }
    if (mode === "rename-now") {
      renameNowCurrentTab();
      return;
    }
    const event = process.env.HERDR_PLUGIN_EVENT || mode;
    const targetTab = tabIdFromContext();
    const targetPane = paneIdFromContext();
    const onlyTab = event === "pane.agent_detected"
      || event === "pane.agent_status_changed" || event === "pane.focused" || event === "pane.exited"
      || event === "pane.closed" ? targetTab : null;
    reconcile({ onlyTabId: onlyTab, tabId: targetTab, paneId: targetPane });
  } finally {
    release();
  }
}

if (require.main === module) main();

module.exports = {
  agyData,
  defaultTabLabel,
  firstUserPrompt,
  isDefaultOrContextLabel,
  nativeSessionData,
  normalizeAgent,
  resolveAgySessionId,
  scanJsonl,
  sessionName,
  stripWorkspaceSuffix,
};
