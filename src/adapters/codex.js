"use strict";

const PLATFORM = "codex";

/**
 * Codex adapter — coming soon.
 * TODO: Confirm where the Codex CLI writes local session/usage logs before
 * implementing. This adapter is a stub.
 */
function collect(/* env = process.env */) {
  return {
    records: [],
    notes: ["Codex: coming soon"],
  };
}

module.exports = { platform: PLATFORM, collect };
