"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const codex = require("../src/adapters/codex");

const FIXTURE_ROOT = path.join(__dirname, "fixtures", "codex");

test("codex adapter aggregates tokens by model+date from a fixture", () => {
  const { records, notes } = codex.collect({ CODEX_HOME: FIXTURE_ROOT });

  // Two distinct (model, date) buckets: one from sessions/, one from
  // archived_sessions/. The no-model event and the malformed line are dropped.
  assert.equal(records.length, 2);

  // Records are sorted by date then model.
  const [first, second] = records;

  // sessions/ — two valid token_count events attributed to gpt-5-codex on the
  // same day aggregate together (100+200 in, 50+80 out, 20+30 cached).
  assert.deepEqual(first, {
    platform: "codex",
    model: "gpt-5-codex",
    date: "2026-06-10",
    input_tokens: 300,
    output_tokens: 130,
    cache_read_tokens: 50,
    cache_creation_tokens: 0,
  });

  // archived_sessions/ is read too.
  assert.deepEqual(second, {
    platform: "codex",
    model: "gpt-4.1-mini",
    date: "2026-06-11",
    input_tokens: 40,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  });

  // The token_count emitted before any turn_context has no determinable model
  // and must be skipped, never attributed to "unknown" or the next model.
  assert.ok(!records.some((r) => r.model === "unknown"));
  assert.equal(first.input_tokens, 300, "no-model event must not be counted");

  // Malformed and no-model events are reported (not silently lost from notes).
  assert.ok(notes.some((n) => /malformed/i.test(n)));
  assert.ok(notes.some((n) => /no determinable model/i.test(n)));
});

test("codex adapter handles a simplified, flat token_count format", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-flat-"));
  const sessions = path.join(dir, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, "rollout-2026-06-12T10-00-00-cccccccc.jsonl");
  // Fields directly on the record, no payload/info wrapper.
  fs.writeFileSync(
    file,
    [
      '{"timestamp":"2026-06-12T10:00:00.000Z","type":"turn_context","model":"gpt-5"}',
      '{"timestamp":"2026-06-12T10:00:01.000Z","type":"token_count","input_tokens":70,"cached_input_tokens":10,"output_tokens":30,"reasoning_output_tokens":5,"total_tokens":100}',
      "",
    ].join("\n")
  );

  try {
    const { records } = codex.collect({ CODEX_HOME: dir });
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      platform: "codex",
      model: "gpt-5",
      date: "2026-06-12",
      input_tokens: 70,
      output_tokens: 30,
      cache_read_tokens: 10,
      cache_creation_tokens: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex adapter returns a clean result when no data exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-"));
  try {
    const { records, notes } = codex.collect({ CODEX_HOME: dir });
    assert.deepEqual(records, []);
    assert.ok(notes.some((n) => /no local data/i.test(n)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
