"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildPayload } = require("../src/payload");
const pkg = require("../package.json");

// Sample records in the shape the adapters produce.
function sampleRecords() {
  return [
    {
      platform: "claude-code",
      model: "claude-sonnet-4-20250514",
      date: "2026-06-10",
      input_tokens: 1840,
      output_tokens: 1250,
      cache_read_tokens: 2300,
      cache_creation_tokens: 200,
    },
  ];
}

// Regression guard: the ingest refactor (extracting the POST into src/ingest.js
// and adding a `source` option to buildPayload) must NOT change the payload the
// live CLI sends. `tokeburn sync` calls buildPayload(records) with no options,
// so that call must still produce source "cli" and the exact documented shape.
test("CLI payload (no explicit source) is unchanged by the ingest refactor", () => {
  const now = new Date("2026-06-15T14:05:26.450Z");
  const payload = buildPayload(sampleRecords(), { now });

  // Default source is "cli" — the live CLI must never emit "sdk".
  assert.equal(payload.source, "cli");

  // Exact top-level shape the CLI sent before the refactor.
  assert.deepEqual(Object.keys(payload).sort(), [
    "cli_version",
    "source",
    "synced_at",
    "usage",
  ]);
  assert.equal(payload.cli_version, pkg.version);
  assert.equal(payload.synced_at, "2026-06-15T14:05:26.450Z");

  // Records pass through verbatim — no added/dropped/renamed fields.
  assert.deepEqual(payload.usage, sampleRecords());
});

// buildPayload() with NO second argument (the literal CLI call site) must also
// default to source "cli" — the defaulted options object must not regress.
test("buildPayload(records) with no options defaults to source cli", () => {
  const payload = buildPayload(sampleRecords());
  assert.equal(payload.source, "cli");
  assert.equal(payload.usage.length, 1);
  assert.equal(typeof payload.synced_at, "string");
});

// The SDK path opts into source "sdk"; confirm the override works without
// affecting the rest of the shape.
test("buildPayload with source sdk overrides only the source field", () => {
  const now = new Date("2026-06-15T14:05:26.450Z");
  const payload = buildPayload(sampleRecords(), { now, source: "sdk" });
  assert.equal(payload.source, "sdk");
  assert.deepEqual(Object.keys(payload).sort(), [
    "cli_version",
    "source",
    "synced_at",
    "usage",
  ]);
  assert.deepEqual(payload.usage, sampleRecords());
});
