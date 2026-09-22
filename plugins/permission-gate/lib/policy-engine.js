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

/**
 * Determine if a shell command consists exclusively of read-only/inspection operations.
 *
 * @param {string} command - Shell command.
 * @returns {boolean} True if every sub-command is read-only.
 */
function isReadOnlyCommand(command) {
  const stripped = stripHeredocBodies(command);
  const parts = stripped.split(/[;&|]+/);
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    const words = splitShellWords(part);
    if (words.length === 0) continue;
    const bin = words[0].toLowerCase().split(/[/\\]/).pop();
    if (!READ_ONLY_BINARIES.has(bin)) {
      return false;
    }
  }
  return parts.length > 0;
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

  // Check path candidates inside the shell command for sensitive files
  const pathCandidates = extractPathCandidates(command);
  for (const rawPath of pathCandidates) {
    const resolved = resolvePath(rawPath, effectiveCwd);
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
    const resolved = resolvePath(rawPath, effectiveCwd);
    if (!isInsideWorkspace(resolved, effectiveRoot)) {
      // Allow read-only commands (inspection/queries) to read outside the workspace
      if (isReadOnly) {
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

  // Check Safe Command Prefixes
  const lowerCmd = strippedCommand.toLowerCase();
  for (const prefix of policy.safeCommandPrefixes) {
    if (lowerCmd === prefix || lowerCmd.startsWith(prefix + " ")) {
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
    reason: `Unclassified shell command requires human approval.`,
    command,
  };
}

module.exports = {
  evaluateToolCall,
  formatDelegationDirective,
  formatHardDenyDirective,
};
