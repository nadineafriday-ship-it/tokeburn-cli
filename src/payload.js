"use strict";

const pkg = require("../package.json");

/**
 * Build the ingest payload from collected usage records.
 */
function buildPayload(records, now = new Date()) {
  return {
    source: "cli",
    cli_version: pkg.version,
    synced_at: now.toISOString(),
    usage: records,
  };
}

/**
 * Compute a summary of the records for display.
 * Returns { count, totalInput, totalOutput, totalCacheRead, totalCacheCreation, byPlatform }.
 */
function summarize(records) {
  const summary = {
    count: records.length,
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
    byPlatform: new Map(),
  };

  for (const r of records) {
    summary.totalInput += r.input_tokens || 0;
    summary.totalOutput += r.output_tokens || 0;
    summary.totalCacheRead += r.cache_read_tokens || 0;
    summary.totalCacheCreation += r.cache_creation_tokens || 0;

    let p = summary.byPlatform.get(r.platform);
    if (!p) {
      p = { records: 0, input_tokens: 0, output_tokens: 0 };
      summary.byPlatform.set(r.platform, p);
    }
    p.records += 1;
    p.input_tokens += r.input_tokens || 0;
    p.output_tokens += r.output_tokens || 0;
  }

  return summary;
}

module.exports = { buildPayload, summarize };
