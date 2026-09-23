"use strict";

const path = require("node:path");
const { isInsideWorkspace, isProtectedPath, resolvePath } = require("./path-utils");
const { stripHeredocBodies, extractPathCandidates, splitShellWords } = require("./shell-parser");

const READ_ONLY_BINARIES = new Set([
  "cat",
  "tail",
  "head",
  "ls",
  "grep",
  "rg",
  "find",
  "file",
  "strings",
  "which",
  "readlink",
  "stat",
  "wc",
  "diff",
  "sort",
  "uniq",
  "echo",
  "printf",
  "pwd",
  "test",
  "true",
]);

const READ_ONLY_PREFIXES = [
  "git grep",
  "launchctl print",
  "launchctl list",
  "tailscale status",
  "tailscale ip",
  "tailscale ping",
  "tailscale netcheck",
  "tailscale version",
  "tailscale whois",
  "tailscale",
];

/**
 * Strips command wrappers such as 'time', '/usr/bin/time', and leading environment variable assignments
 * (e.g. CGO_ENABLED=0 GOOS=linux) to evaluate the underlying command.
 *
 * @param {string} command - Shell command.
 * @returns {string} Unwrapped command.
 */
function stripCommandWrappers(command) {
  if (!command) return "";
  let cmd = command.trim();

  // Strip leading environment variable assignments (e.g. CGO_ENABLED=0 GOOS=linux)
  const envRegex = /^(?:[a-zA-Z_][a-zA-Z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/;
  if (envRegex.test(cmd)) {
    cmd = cmd.replace(envRegex, "").trim();
  }

  // Strip leading 'time' or '/usr/bin/time' with optional flags
  const timeRegex = /^(?:\/usr\/bin\/)?time(?:\s+-[a-zA-Z0-9_-]+)*\s+/i;
  if (timeRegex.test(cmd)) {
    cmd = cmd.replace(timeRegex, "").trim();
  }

  // Strip any env vars after time (e.g. time CGO_ENABLED=0 go build)
  if (envRegex.test(cmd)) {
    cmd = cmd.replace(envRegex, "").trim();
  }

  return cmd;
}

/**
 * Checks if a target path is in a standard system temporary directory.
 *
 * @param {string} targetPath - Path to check.
 * @returns {boolean} True if target is within /tmp, /private/tmp, or /var/tmp.
 */
function isTemporaryPath(targetPath) {
  if (!targetPath) return false;
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    normalized.startsWith("/tmp/") ||
    normalized === "/tmp" ||
    normalized.startsWith("/private/tmp/") ||
    normalized === "/private/tmp" ||
    normalized.startsWith("/var/tmp/") ||
    normalized === "/var/tmp"
  );
}

/**
 * Determine if a shell command consists exclusively of read-only/inspection operations.
 *
 * @param {string} command - Shell command.
 * @returns {boolean} True if every sub-command is read-only.
 */
function isReadOnlyCommand(command) {
  const stripped = stripHeredocBodies(command);
  // If command redirects stdout with > or >>, it is writing to a file, not read-only
  // Exception: 2> /dev/null or 2>&1
  if (/(^|[^2])>\s*\S+/.test(stripped)) {
    return false;
  }
  const parts = stripped.split(/[;&|]+/);
  for (let part of parts) {
    part = stripCommandWrappers(part.trim());
    if (!part) continue;
    const words = splitShellWords(part);
    if (words.length === 0) continue;
    const bin = words[0].toLowerCase().split(/[/\\]/).pop();

    if (bin === "sqlite3") {
      const isMutatingSql = /\b(insert|update|delete|create|drop|truncate|alter|replace)\b/i.test(part);
      if (isMutatingSql) {
        return false;
      }
      continue;
    }

    const lowerPart = part.toLowerCase();
    const isPrefixMatch = READ_ONLY_PREFIXES.some(
      (prefix) => lowerPart === prefix || lowerPart.startsWith(prefix + " ")
    );

    if (!READ_ONLY_BINARIES.has(bin) && !isPrefixMatch) {
      return false;
    }
  }
  return parts.length > 0;
}

const LOCALHOST_URL_REGEX = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|localhost\.localdomain)(:\d+)?(\/.*)?$/i;
const EXTERNAL_URL_REGEX = /^(https?|ftp):\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|localhost\.localdomain)/i;

/**
 * Checks if a curl/wget command exclusively targets local development services
 * (localhost, 127.0.0.1, 0.0.0.0, [::1]).
 *
 * @param {string} command - Shell command string.
 * @returns {boolean} True if command is curl/wget strictly targeting localhost.
 */
function isLocalhostNetworkCommand(command) {
  const stripped = stripHeredocBodies(command);
  const words = splitShellWords(stripped);
  if (words.length === 0) return false;

  const bin = words[0].toLowerCase().split(/[/\\]/).pop();
  if (bin !== "curl" && bin !== "wget") return false;

  let hasLocalhost = false;
  let hasExternal = false;

  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/^["']|["']$/g, "");
    if (w.startsWith("-")) continue;
    if (LOCALHOST_URL_REGEX.test(w)) {
      hasLocalhost = true;
    } else if (EXTERNAL_URL_REGEX.test(w)) {
      hasExternal = true;
    }
  }

  return hasLocalhost && !hasExternal;
}

/**
 * Splits a compound shell command into individual sequential sub-commands.
 * Respects single and double quotes and heredocs.
 * Splits on &&, ||, and ;.
 *
 * @param {string} command - Compound shell command.
 * @returns {string[]} Array of individual command strings.
 */
function splitCommandChain(command) {
  if (!command) return [];
  const stripped = stripHeredocBodies(command);
  const parts = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    const next = stripped[i + 1];

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (!inDouble && !inSingle) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        if (current.trim()) parts.push(current.trim());
        current = "";
        i++; // skip second operator character
      } else if (ch === ";") {
        if (current.trim()) parts.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.length > 0 ? parts : [command];
}

/**
 * Format instructional delegation message for the agent.
 *
 * @param {string} command - Original command attempted.
 * @param {string} reason - Justification for delegation.
 * @returns {string} Formatted instructional directive.
 */
function formatDelegationDirective(command, reason) {
  return [
    "[PERMISSION GATE: HUMAN INTERVENTION REQUIRED]",
    `The requested command is blocked by security policy: \`${command}\``,
    `Reason: ${reason}`,
    "",
    "MANDATORY DIRECTIVES FOR THE AGENT:",
    "1. DO NOT attempt workarounds, alternative scripts (e.g. Python, subshells), or indirect tools to bypass this restriction.",
    "2. HALT further autonomous tool execution for this specific action.",
    "3. Report this impediment clearly to the user, explaining why this action is required.",
    "4. Output the exact command formatted in a code block for the user to execute manually in their terminal:",
    "   ```bash",
    `   ${command}`,
    "   ```",
    "5. Ask the user to confirm once they have finished executing the command so you can continue the task.",
  ].join("\n");
}

/**
 * Format instructional hard denial message for the agent.
 *
 * @param {string} command - Original command attempted.
 * @param {string} reason - Justification for denial.
 * @returns {string} Formatted instructional directive.
 */
function formatHardDenyDirective(command, reason) {
  return [
    "[PERMISSION GATE: INHERENTLY UNSAFE COMMAND BLOCKED]",
    `The command \`${command}\` is strictly blocked by security policy.`,
    `Reason: ${reason}`,
    "",
    "MANDATORY DIRECTIVES FOR THE AGENT:",
    "1. This operation is classified as inherently hazardous or destructive to the operating system or codebase.",
    "2. DO NOT suggest that the user run this command.",
    "3. DO NOT attempt alternative methods to execute this destructive operation.",
    "4. Reformulate your solution using safe, non-destructive, project-scoped commands.",
  ].join("\n");
}

/**
 * Extract target file paths from tool parameters.
 *
 * @param {string} toolName - Tool identifier.
 * @param {object} params - Tool parameters.
 * @returns {string[]} List of file paths found.
 */
function extractFilePaths(toolName, params) {
  if (!params || typeof params !== "object") return [];
  const paths = [];

  const candidates = [
    params.TargetFile,
    params.targetFile,
    params.path,
    params.filePath,
    params.filepath,
    params.file,
    params.AbsolutePath,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      paths.push(c.trim());
    }
  }

  return paths;
}

/**
 * Evaluates a single, non-chained shell command against policy rules.
 *
 * @param {object} options
 * @param {string} options.command - Shell command string.
 * @param {string} options.cwd - Current working directory.
 * @param {string} options.workspaceRoot - Active workspace root.
 * @param {object} options.policy - Loaded policy configuration.
 * @returns {object} Decision object.
 */
function evaluateSingleCommand({ command, cwd, workspaceRoot, policy }) {
  const unwrappedCommand = stripCommandWrappers(command);
  const strippedCommand = stripHeredocBodies(unwrappedCommand || command);

  // Check path candidates inside the shell command for sensitive files
  const pathCandidates = extractPathCandidates(unwrappedCommand || command);
  for (const rawPath of pathCandidates) {
    const resolved = resolvePath(rawPath, cwd);
    if (isProtectedPath(resolved, policy)) {
      const reason = `Command touches protected sensitive file "${rawPath}".`;
      return {
        decision: "HARD_DENY",
        reason,
        directive: formatHardDenyDirective(command, reason),
        command,
      };
    }
  }

  // Check Hard Deny Patterns (destructive / toxic)
  for (const item of policy.hardDenyPatterns) {
    const rx = new RegExp(item.pattern, "i");
    if (rx.test(strippedCommand)) {
      const reason = item.label;
      return {
        decision: "HARD_DENY",
        reason,
        directive: formatHardDenyDirective(command, reason),
        command,
      };
    }
  }

  // Check Delegate To User Patterns (privileged / external / forced)
  for (const item of policy.delegateToUserPatterns) {
    const rx = new RegExp(item.pattern, "i");
    if (rx.test(strippedCommand)) {
      const reason = item.reason || item.label;
      return {
        decision: "DELEGATE_TO_USER",
        reason,
        label: item.label,
        directive: formatDelegationDirective(command, reason),
        command,
      };
    }
  }

  // Check Ask Patterns (interactive confirmation required)
  for (const item of policy.askPatterns) {
    const rx = new RegExp(item.pattern, "i");
    if (rx.test(strippedCommand)) {
      if (item.label.toLowerCase().includes("network") && isLocalhostNetworkCommand(command)) {
        continue;
      }
      return {
        decision: "ASK",
        reason: `Command requires user approval: ${item.label}`,
        command,
      };
    }
  }

  const isReadOnly = isReadOnlyCommand(command);

  // Check path candidates for external workspace confinement
  for (const rawPath of pathCandidates) {
    // Ignore pure flags or device paths
    if (rawPath.startsWith("/dev/") || rawPath === "/dev/null") continue;
    const resolved = resolvePath(rawPath, cwd);
    if (!isInsideWorkspace(resolved, workspaceRoot)) {
      // Allow read-only commands (inspection/queries) or temporary build files to be outside workspace
      if (isReadOnly || isTemporaryPath(resolved)) {
        continue;
      }
      return {
        decision: "ASK",
        reason: `Mutating command references path outside active workspace: "${rawPath}"`,
        command,
      };
    }
  }

  // If the command is a pure read-only query/inspection command, auto-approve
  if (isReadOnly) {
    return {
      decision: "ALLOW",
      reason: "Read-only inspection command is auto-approved.",
      command,
    };
  }

  // If the command is a localhost development network query, auto-approve
  if (isLocalhostNetworkCommand(command)) {
    return {
      decision: "ALLOW",
      reason: "Localhost development network query auto-approved.",
      command,
    };
  }

  // Check Safe Command Prefixes
  const lowerCmd = strippedCommand.toLowerCase();
  const lowerRaw = stripHeredocBodies(command).toLowerCase();

  // Also normalize command binary (e.g. /usr/local/go/bin/go build -> go build)
  let lowerNormalized = "";
  const words = strippedCommand.split(/\s+/);
  if (words.length > 0 && words[0].includes("/")) {
    words[0] = path.basename(words[0]);
    lowerNormalized = words.join(" ").toLowerCase();
  }

  for (const prefix of policy.safeCommandPrefixes) {
    if (
      lowerCmd === prefix ||
      lowerCmd.startsWith(prefix + " ") ||
      lowerRaw === prefix ||
      lowerRaw.startsWith(prefix + " ") ||
      (lowerNormalized && (lowerNormalized === prefix || lowerNormalized.startsWith(prefix + " ")))
    ) {
      return {
        decision: "ALLOW",
        reason: `Standard development command (${prefix}) auto-approved.`,
        command,
      };
    }
  }

  // Fallback for unclassified commands: prompt the user (fail-closed)
  return {
    decision: "ASK",
    reason: "Unclassified shell command requires human approval.",
    command,
  };
}

/**
 * Evaluates a tool call against the security policy.
 *
 * @param {object} options
 * @param {string} options.toolName - Name of the tool being invoked.
 * @param {object} options.params - Tool parameters/arguments.
 * @param {string} options.cwd - Current working directory.
 * @param {string} options.workspaceRoot - Active workspace root.
 * @param {object} options.policy - Loaded policy configuration.
 * @returns {object} Evaluation result { decision: "ALLOW"|"HARD_DENY"|"DELEGATE_TO_USER"|"ASK", reason, directive, command }
 */
function evaluateToolCall({ toolName, params, cwd, workspaceRoot, policy }) {
  const normTool = (toolName || "").toLowerCase();
  const effectiveCwd = cwd || workspaceRoot || process.cwd();
  const effectiveRoot = workspaceRoot || effectiveCwd;

  // 1. FILE TOOLS EVALUATION
  const isFileTool =
    policy.autoApprovedTools.includes(normTool) ||
    normTool.includes("write") ||
    normTool.includes("edit") ||
    normTool.includes("read");

  if (isFileTool && !normTool.includes("command") && !normTool.includes("bash")) {
    const filePaths = extractFilePaths(normTool, params);

    for (const rawPath of filePaths) {
      const resolved = resolvePath(rawPath, effectiveCwd);

      // Check protected credentials / secrets
      if (isProtectedPath(resolved, policy)) {
        const reason = `Access to protected sensitive file "${rawPath}" is reserved for human operation.`;
        return {
          decision: "HARD_DENY",
          reason,
          directive: formatHardDenyDirective(rawPath, reason),
          target: rawPath,
        };
      }

      // Check workspace boundary
      if (!isInsideWorkspace(resolved, effectiveRoot)) {
        return {
          decision: "ASK",
          reason: `Target file path "${rawPath}" resolves outside active project workspace (${effectiveRoot}).`,
          target: rawPath,
        };
      }
    }

    return {
      decision: "ALLOW",
      reason: "Project workspace file operation is auto-approved.",
      target: filePaths[0],
    };
  }

  // 2. SHELL / COMMAND TOOLS EVALUATION
  const rawCommand =
    (params && (params.CommandLine || params.command || params.cmd)) || "";
  const command = String(rawCommand).trim();

  if (!command) {
    return { decision: "ALLOW", reason: "Empty command." };
  }

  const strippedCommand = stripHeredocBodies(command);

  // Global check across full command string for hard deny and delegate patterns
  for (const item of policy.hardDenyPatterns) {
    const rx = new RegExp(item.pattern, "i");
    if (rx.test(strippedCommand)) {
      const reason = item.label;
      return {
        decision: "HARD_DENY",
        reason,
        directive: formatHardDenyDirective(command, reason),
        command,
      };
    }
  }

  for (const item of policy.delegateToUserPatterns) {
    const rx = new RegExp(item.pattern, "i");
    if (rx.test(strippedCommand)) {
      const reason = item.reason || item.label;
      return {
        decision: "DELEGATE_TO_USER",
        reason,
        label: item.label,
        directive: formatDelegationDirective(command, reason),
        command,
      };
    }
  }

  for (const item of policy.askPatterns) {
    const rx = new RegExp(item.pattern, "i");
    if (rx.test(strippedCommand)) {
      if (item.label.toLowerCase().includes("network") && isLocalhostNetworkCommand(command)) {
        continue;
      }
      return {
        decision: "ASK",
        reason: `Command requires user approval: ${item.label}`,
        command,
      };
    }
  }

  // Split compound commands (&&, ||, ;) to evaluate each sub-command individually
  const subCommands = splitCommandChain(command);
  if (subCommands.length > 1) {
    let mostSevere = null;
    for (const subCmd of subCommands) {
      const subResult = evaluateSingleCommand({
        command: subCmd,
        cwd: effectiveCwd,
        workspaceRoot: effectiveRoot,
        policy,
      });

      if (subResult.decision === "HARD_DENY") {
        return subResult;
      }
      if (subResult.decision === "DELEGATE_TO_USER") {
        if (!mostSevere || mostSevere.decision !== "DELEGATE_TO_USER") {
          mostSevere = subResult;
        }
      } else if (subResult.decision === "ASK") {
        if (!mostSevere) {
          mostSevere = subResult;
        }
      }
    }

    if (mostSevere) {
      return mostSevere;
    }

    return {
      decision: "ALLOW",
      reason: "All chained sub-commands are auto-approved.",
      command,
    };
  }

  // Single command evaluation
  return evaluateSingleCommand({
    command,
    cwd: effectiveCwd,
    workspaceRoot: effectiveRoot,
    policy,
  });
}

module.exports = {
  evaluateToolCall,
  evaluateSingleCommand,
  splitCommandChain,
  stripCommandWrappers,
  isReadOnlyCommand,
  isLocalhostNetworkCommand,
  formatDelegationDirective,
  formatHardDenyDirective,
};
