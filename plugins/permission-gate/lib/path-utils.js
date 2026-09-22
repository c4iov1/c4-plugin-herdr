"use strict";

const path = require("node:path");
const fs = require("node:fs");

/**
 * Checks whether a target file path is contained inside the workspace boundary.
 *
 * @param {string} targetPath - Path to evaluate.
 * @param {string} workspaceRoot - Workspace root directory.
 * @returns {boolean} True if targetPath is strictly inside workspaceRoot.
 */
function isInsideWorkspace(targetPath, workspaceRoot) {
  if (!targetPath || !workspaceRoot) return false;

  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(workspaceRoot);

  if (resolvedTarget === resolvedRoot) return true;

  const relative = path.relative(resolvedRoot, resolvedTarget);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Checks whether a given path matches sensitive or credential patterns.
 *
 * @param {string} targetPath - Path to inspect.
 * @param {object} policy - Policy rules object.
 * @returns {boolean} True if the path is protected.
 */
function isProtectedPath(targetPath, policy) {
  if (!targetPath || !policy || !Array.isArray(policy.protectedPaths)) {
    return false;
  }

  const normalized = targetPath.replace(/\\/g, "/");
  const basename = path.basename(normalized);

  // Check whitelist first (e.g. .env.example)
  if (Array.isArray(policy.protectedPathsWhitelist)) {
    for (const pattern of policy.protectedPathsWhitelist) {
      if (new RegExp(pattern, "i").test(normalized) || new RegExp(pattern, "i").test(basename)) {
        return false;
      }
    }
  }

  for (const pattern of policy.protectedPaths) {
    const rx = new RegExp(pattern, "i");
    if (rx.test(normalized) || rx.test(basename)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve shell path token handling home directory prefix.
 *
 * @param {string} rawPath - Path string.
 * @param {string} cwd - Current working directory fallback.
 * @returns {string} Fully resolved absolute path.
 */
function resolvePath(rawPath, cwd) {
  if (!rawPath) return cwd;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (rawPath === "~" || rawPath.startsWith("~/")) {
    return path.resolve(home, rawPath.slice(2));
  }
  return path.resolve(cwd, rawPath);
}

module.exports = {
  isInsideWorkspace,
  isProtectedPath,
  resolvePath,
};
