"use strict";

const PLATFORM = "cursor";

/**
 * Cursor adapter — coming soon.
 * TODO: Cursor stores usage locally in its application support data. We have
 * not yet confirmed the on-disk log format, so this adapter is a stub.
 */
function collect(/* env = process.env */) {
  return {
    records: [],
    notes: ["Cursor: coming soon"],
  };
}

module.exports = { platform: PLATFORM, collect };
