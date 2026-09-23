"use strict";

const SHELL_OPERATORS = new Set([
  "|",
  "||",
  "&",
  "&&",
  ";",
  ">",
  ">>",
  "<",
  "<<",
  "2>",
  "2>>",
  "2>&1",
]);

/**
 * Remove heredoc payload lines before shell path analysis.
 *
 * @param {string} command - Shell command string.
 * @returns {string} Stripped command.
 */
function stripHeredocBodies(command) {
  if (!command) return "";
  const output = [];
  const pendingDelimiters = [];
  const heredocPattern = /<<-?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))/g;
  const lines = command.split(/\r?\n/);

  for (const line of lines) {
    if (pendingDelimiters.length > 0) {
      const delimiter = pendingDelimiters[0];
      if (line.trim() === delimiter) pendingDelimiters.shift();
      continue;
    }

    output.push(line);

    heredocPattern.lastIndex = 0;
    let match;
    while ((match = heredocPattern.exec(line)) !== null) {
      const delimiter = match[1] || match[2] || match[3];
      if (delimiter) pendingDelimiters.push(delimiter);
    }
  }

  return output.join("\n");
}

/**
 * Coarse shell word splitting handling quotes.
 *
 * @param {string} command - Shell command string.
 * @returns {string[]} List of tokens.
 */
function splitShellWords(command) {
  if (!command) return [];
  const words = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\S+/g;
  let match;

  while ((match = pattern.exec(command)) !== null) {
    words.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[0]);
  }

  return words;
}

/**
 * Extract path-like arguments from shell command.
 *
 * @param {string} command - Shell command.
 * @returns {string[]} List of path candidate tokens.
 */
function extractPathCandidates(command) {
  const stripped = stripHeredocBodies(command);
  const tokens = splitShellWords(stripped);
  const candidates = [];

  // Track sqlite3 positional arguments and find the primary command binary token
  let isSqlite = false;
  let sqlitePositionalCount = 0;
  let sqliteIndex = -1;
  let commandIndex = -1;

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (SHELL_OPERATORS.has(t) || t.startsWith("-")) continue;
    if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(t)) continue;

    const tokenClean = t.toLowerCase().split(/[/\\]/).pop();
    if (tokenClean === "time") continue;

    if (commandIndex === -1) {
      commandIndex = idx;
    }

    if (tokenClean === "sqlite3") {
      isSqlite = true;
      sqliteIndex = idx;
      break;
    }
    break;
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || SHELL_OPERATORS.has(t) || t.startsWith("-")) continue;

    // The primary executable binary being run is not a file target to be mutated
    if (i === commandIndex) {
      continue;
    }

    if (isSqlite && i > sqliteIndex) {
      sqlitePositionalCount++;
      if (sqlitePositionalCount > 1) {
        // Skip SQL statements and dot-commands
        continue;
      }
    }

    // Skip inline script arguments following -c, -e, --eval (e.g. python3 -c "<code>", node -e "<code>")
    if (i > 0 && (tokens[i - 1] === "-c" || tokens[i - 1] === "-e" || tokens[i - 1] === "--eval")) {
      continue;
    }

    // Skip commit message arguments following -m or --message
    if (i > 0 && (tokens[i - 1] === "-m" || tokens[i - 1] === "--message")) {
      continue;
    }

    // Skip scoped package names like @org/pkg
    if (t.startsWith("@")) {
      continue;
    }

    // Skip Go package pattern wildcards (e.g. ./... or ./pkg/...)
    if (t === "./..." || t.endsWith("/...")) {
      continue;
    }

    // cd target
    if (t === "cd" && tokens[i + 1] && !tokens[i + 1].startsWith("-")) {
      candidates.push(tokens[i + 1]);
      continue;
    }

    if (
      t.startsWith("/") ||
      t.startsWith("./") ||
      t.startsWith("../") ||
      t.startsWith("~/") ||
      t.includes("/") ||
      /\.[a-zA-Z0-9_-]+$/.test(t)
    ) {
      candidates.push(t);
    }
  }

  return candidates;
}

module.exports = {
  stripHeredocBodies,
  splitShellWords,
  extractPathCandidates,
};
