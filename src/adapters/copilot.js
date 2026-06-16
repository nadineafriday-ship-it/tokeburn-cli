"use strict";

const PLATFORM = "github-copilot";

/**
 * GitHub Copilot adapter — coming soon.
 * TODO: Confirm whether Copilot exposes local token usage logs and in what
 * format before implementing. This adapter is a stub.
 */
function collect(/* env = process.env */) {
  return {
    records: [],
    notes: ["GitHub Copilot: coming soon"],
  };
}

module.exports = { platform: PLATFORM, collect };
