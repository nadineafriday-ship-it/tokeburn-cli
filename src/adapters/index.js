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

module.exports = { adapters, collectAll };
