"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  recentWindow,
  filterToWindow,
  recentSync,
  createWatchSync,
  createDebouncer,
} = require("../src/watch");

const FIXED_NOW = () => new Date("2026-06-16T12:00:00.000Z");

function record(date, model = "m") {
  return {
    platform: "claude-code",
    model,
    date,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

test("recentWindow returns today + lookback days (UTC)", () => {
  const win = recentWindow(FIXED_NOW(), 2);
  assert.deepEqual(
    [...win].sort(),
    ["2026-06-14", "2026-06-15", "2026-06-16"]
  );
  assert.equal(win.size, 3);

  // lookback 0 == today only.
  assert.deepEqual([...recentWindow(FIXED_NOW(), 0)], ["2026-06-16"]);
});

test("filterToWindow keeps only in-window records", () => {
  const win = recentWindow(FIXED_NOW(), 2);
  const recs = [record("2026-06-16"), record("2026-06-13"), record("2020-01-01")];
  const kept = filterToWindow(recs, win);
  assert.deepEqual(kept.map((r) => r.date), ["2026-06-16"]);
});

test("recentSync posts only today + lookback, never the full history", async () => {
  // Adapter output spans well outside the window (an old backfill).
  const collect = () => ({
    records: [
      record("2026-06-16"), // today          -> in window
      record("2026-06-15"), // yesterday      -> in window
      record("2026-06-14"), // 2 days back    -> in window
      record("2026-06-13"), // 3 days back    -> OUT
      record("2025-01-01"), // ancient        -> OUT
    ],
  });

  let posted = null;
  const post = async (payload) => {
    posted = payload;
  };

  const recent = await recentSync({ collect, post, lookbackDays: 2, now: FIXED_NOW });

  const dates = posted.usage.map((r) => r.date).sort();
  assert.deepEqual(dates, ["2026-06-14", "2026-06-15", "2026-06-16"]);
  // The decoupled return value matches what was posted.
  assert.equal(recent.length, 3);
  // The full history (5 records) was NOT re-sent.
  assert.notEqual(posted.usage.length, 5);
});

test("recentSync does not post when nothing falls in the window", async () => {
  const collect = () => ({ records: [record("2020-01-01")] });
  let called = false;
  const post = async () => {
    called = true;
  };
  const recent = await recentSync({ collect, post, lookbackDays: 2, now: FIXED_NOW });
  assert.equal(called, false);
  assert.deepEqual(recent, []);
});

test("debounce coalesces rapid changes into a single sync", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let calls = 0;
  const debounced = createDebouncer(() => {
    calls += 1;
  }, 2500);

  // A burst of change events.
  debounced();
  t.mock.timers.tick(500);
  debounced();
  t.mock.timers.tick(500);
  debounced();

  // Not yet — the quiet period hasn't elapsed since the last trigger.
  t.mock.timers.tick(2000);
  assert.equal(calls, 0);

  // Cross the debounce threshold from the LAST trigger.
  t.mock.timers.tick(500);
  assert.equal(calls, 1, "three rapid triggers collapse into one call");

  // A later, separate change fires again.
  debounced();
  t.mock.timers.tick(2500);
  assert.equal(calls, 2);
});

test("an error in one sync does not stop the loop", async () => {
  const collect = () => ({ records: [record("2026-06-16")] });

  let attempt = 0;
  const post = async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error("network down");
    }
  };

  const errors = [];
  const synced = [];
  const tick = createWatchSync({
    collect,
    post,
    lookbackDays: 2,
    now: FIXED_NOW,
    onSynced: (count) => synced.push(count),
    onError: (err) => errors.push(err.message),
  });

  // First tick throws inside post — must be caught, not rethrown.
  await tick();
  assert.deepEqual(errors, ["network down"]);
  assert.deepEqual(synced, []);

  // The loop survives: a later tick still runs and succeeds.
  await tick();
  assert.deepEqual(errors, ["network down"]);
  assert.deepEqual(synced, [1]);
});

test("createWatchSync reports the number of synced events", async () => {
  const collect = () => ({
    records: [record("2026-06-16", "a"), record("2026-06-15", "b")],
  });
  const post = async () => {};
  const synced = [];
  const tick = createWatchSync({
    collect,
    post,
    lookbackDays: 2,
    now: FIXED_NOW,
    onSynced: (count) => synced.push(count),
  });
  await tick();
  assert.deepEqual(synced, [2]);
});
