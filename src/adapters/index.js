"use strict";

const claudeCode = require("./claude-code");
const cursor = require("./cursor");
const codex = require("./codex");
const copilot = require("./copilot");

// Order here determines the order adapters run and notes are printed.
const adapters = [claudeCode, cursor, codex, copilot];

/**
 * Run every adapter and combine their output.
 * Returns { records: [...], notes: [...] }.
 */
function collectAll(env = process.env) {
  const records = [];
  const notes = [];
  for (const adapter of adapters) {
    let result;
    try {
      result = adapter.collect(env);
    } catch (err) {
      // An adapter should never take down the whole sync.
      notes.push(`${adapter.platform}: skipped (error reading local data)`);
      continue;
    }
    if (result && Array.isArray(result.records)) records.push(...result.records);
    if (result && Array.isArray(result.notes)) notes.push(...result.notes);
  }
  return { records, notes };
}

/**
 * The set of local log directories the adapters read, across every adapter that
 * exposes a `dirs(env)` function. Used by `tokeburn watch` to place filesystem
 * watchers. Adapters without a `dirs` function (stubs) contribute nothing.
 * Returns a de-duplicated list of directory paths (which may not all exist yet).
 */
function watchDirs(env = process.env) {
  const seen = new Set();
  for (const adapter of adapters) {
    if (typeof adapter.dirs !== "function") continue;
    let dirs;
    try {
      dirs = adapter.dirs(env);
    } catch (err) {
      // A misbehaving adapter should not break watch setup.
      continue;
    }
    if (!Array.isArray(dirs)) continue;
    for (const d of dirs) {
      if (typeof d === "string" && d) seen.add(d);
    }
  }
  return Array.from(seen);
}

module.exports = { adapters, collectAll, watchDirs };
