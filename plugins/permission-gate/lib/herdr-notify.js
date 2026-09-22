"use strict";

const { spawn } = require("node:child_process");

/**
 * Emit a notification into Herdr via the CLI.
 *
 * @param {string} title - Notification title.
 * @param {string} body - Notification message body.
 */
function notifyHerdr(title, body) {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";

  try {
    const child = spawn(
      herdrBin,
      ["notification", "show", "--title", title, "--body", body],
      {
        stdio: "ignore",
        detached: true,
      }
    );
    child.unref();
  } catch (_err) {
    // Gracefully ignore if Herdr binary or socket is not present
  }
}

module.exports = {
  notifyHerdr,
};
