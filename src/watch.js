"use strict";

const fs = require("fs");
const pc = require("picocolors");

const { resolveToken, resolveApiUrl } = require("./config");
const { collectAll, watchDirs } = require("./adapters");
const { buildPayload } = require("./payload");
const { postPayload } = require("./ingest");
const { runSync, missingTokenMessage } = require("./sync");

// Defaults, also referenced by bin/tokeburn.js for the --flag help text.
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_LOOKBACK_DAYS = 2;
// How long to wait after the last detected change before syncing. Coalesces a
// burst of writes (a single agent turn can touch a log file many times) into
// one sync.
const DEFAULT_DEBOUNCE_MS = 2500;

/**
 * Compute the set of YYYY-MM-DD date strings considered "recent": today plus
 * `lookbackDays` previous days. Dates use UTC to match the adapters, which key
 * their per-day records off `new Date(ts).toISOString().slice(0, 10)`.
 *
 * @param {Date}   now
 * @param {number} lookbackDays  Number of days before today to include.
 * @returns {Set<string>}
 */
function recentWindow(now = new Date(), lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  const days = new Set();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const span = Math.max(0, Math.floor(lookbackDays));
  for (let i = 0; i <= span; i++) {
    days.add(new Date(base - i * MS_PER_DAY).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Keep only the records whose `date` falls in the recent window. This is what
 * makes a watch tick cheap: the adapters always produce the full per-day
 * history, and we drop everything outside the window before posting rather than
 * re-sending the entire backlog on every change.
 */
function filterToWindow(records, windowSet) {
  return records.filter((r) => r && windowSet.has(r.date));
}

/**
 * Run a single "recent window" sync: collect from the adapters, keep only
 * today + lookback, and post if there's anything to send. Dependencies are
 * injected so the core logic is testable without real fs/network.
 *
 * @param {object}   ctx
 * @param {Function} ctx.collect        () => { records } (defaults to collectAll).
 * @param {Function} ctx.post           async (payload) => void; throws on failure.
 * @param {number}   ctx.lookbackDays
 * @param {Function} [ctx.now]          () => Date.
 * @returns {Promise<Array>} the records that were (or would have been) posted.
 */
async function recentSync({ collect, post, lookbackDays, now = () => new Date() }) {
  const { records } = collect();
  const windowSet = recentWindow(now(), lookbackDays);
  const recent = filterToWindow(records, windowSet);
  if (recent.length > 0) {
    await post(buildPayload(recent, { now: now(), source: "cli" }));
  }
  return recent;
}

/**
 * Wrap `recentSync` in a guard that (a) never lets an error stop the loop and
 * (b) never runs two syncs concurrently — if a change arrives mid-sync, exactly
 * one follow-up sync is queued. Returns an async `tick()` that always resolves.
 *
 * @param {object}   ctx              Passed through to recentSync.
 * @param {Function} [ctx.onSynced]   (count, at) => void on a successful sync.
 * @param {Function} [ctx.onError]    (err) => void when a sync throws.
 */
function createWatchSync(ctx) {
  const onSynced = ctx.onSynced || (() => {});
  const onError = ctx.onError || (() => {});
  const now = ctx.now || (() => new Date());
  let inFlight = false;
  let queued = false;

  async function tick() {
    if (inFlight) {
      // A change landed while we were syncing — fold it into one re-run.
      queued = true;
      return;
    }
    inFlight = true;
    try {
      const recent = await recentSync({
        collect: ctx.collect,
        post: ctx.post,
        lookbackDays: ctx.lookbackDays,
        now,
      });
      onSynced(recent.length, now());
    } catch (err) {
      onError(err);
    } finally {
      inFlight = false;
      if (queued) {
        queued = false;
        tick();
      }
    }
  }

  return tick;
}

/**
 * Create a debouncer: calling the returned `trigger()` repeatedly only runs
 * `fn` once, `delayMs` after the last call. Timer functions are injectable for
 * deterministic tests; by default they resolve the global timers at call time
 * so node:test's mock timers are picked up.
 */
function createDebouncer(fn, delayMs, timers) {
  const setT = (timers && timers.setTimeout) || ((cb, ms) => setTimeout(cb, ms));
  const clearT = (timers && timers.clearTimeout) || ((t) => clearTimeout(t));
  let handle = null;

  function trigger() {
    if (handle !== null) clearT(handle);
    handle = setT(() => {
      handle = null;
      fn();
    }, delayMs);
  }
  trigger.cancel = () => {
    if (handle !== null) {
      clearT(handle);
      handle = null;
    }
  };
  trigger.pending = () => handle !== null;
  return trigger;
}

function nowTime(d = new Date()) {
  return d.toTimeString().slice(0, 8); // HH:MM:SS, local time
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (err) {
    return false;
  }
}

/**
 * Place a filesystem watcher on `dir`. Tries a recursive watch first (supported
 * on macOS and Windows); on platforms without it (notably Linux) falls back to
 * a shallow watch. The poll interval is the real safety net for missed deep
 * writes either way. Returns the FSWatcher or null if watching failed entirely.
 */
function watchDir(dir, onChange) {
  const attempts = [{ recursive: true }, { recursive: false }];
  for (const opts of attempts) {
    try {
      const watcher = fs.watch(dir, opts, () => onChange());
      // Watcher errors (e.g. a dir removed underneath us) must not crash the
      // process; the poll loop keeps things current.
      watcher.on("error", () => {});
      return watcher;
    } catch (err) {
      // Try the next option (e.g. recursive unsupported), else give up on this
      // directory and rely on polling.
    }
  }
  return null;
}

/**
 * Run the `watch` command:
 *   1. Run the existing full sync once (catch-up / backfill).
 *   2. Watch the adapters' log dirs (fs.watch) plus a fallback poll interval.
 *   3. On a debounced change, re-sync only the recent window.
 *   4. Log and continue on errors; Ctrl-C exits cleanly.
 *
 * Resolves with a process exit code when the watcher is stopped.
 */
async function runWatch(opts = {}, env = process.env) {
  const token = resolveToken(opts, env);
  const apiUrl = resolveApiUrl(opts, env);

  if (!token) {
    missingTokenMessage();
    return 1;
  }

  const intervalSeconds = positiveNumber(opts.interval, DEFAULT_INTERVAL_SECONDS);
  const lookbackDays = nonNegativeInt(opts.lookbackDays, DEFAULT_LOOKBACK_DAYS);

  // 1. Catch-up: the existing one-shot full sync, so we're current immediately.
  console.log(pc.bold("Running initial full sync…"));
  await runSync(opts, env);

  // 2. Build the recent-window sync used for every subsequent change.
  const tick = createWatchSync({
    collect: () => collectAll(env),
    post: async (payload) => {
      const res = await postPayload(payload, { token, apiUrl });
      if (!res || !res.ok) {
        const status = res ? `${res.status} ${res.statusText}` : "no response";
        throw new Error(`Tokeburn ingest error: ${status}`);
      }
    },
    lookbackDays,
    onSynced: (count, at) => {
      console.log(pc.dim(`synced ${count} events at ${nowTime(at)}`));
    },
    onError: (err) => {
      console.error(
        pc.red("sync failed (continuing): ") + (err && err.message ? err.message : String(err))
      );
    },
  });

  const debounced = createDebouncer(tick, DEFAULT_DEBOUNCE_MS);

  // 3. Watch each existing log directory; fall back to polling for the rest.
  const allDirs = watchDirs(env);
  const presentDirs = allDirs.filter(dirExists);
  const watchers = [];
  for (const dir of presentDirs) {
    const watcher = watchDir(dir, () => debounced());
    if (watcher) watchers.push(watcher);
  }

  // 4. Poll fallback — catches events fs.watch misses (deep writes on Linux,
  // dirs that did not exist when we started, flaky platforms). The poll calls
  // the sync directly rather than through the debouncer: it is the guaranteed
  // periodic tick, and routing it through the debouncer would let a poll
  // shorter than the debounce window keep resetting the timer so it never
  // fires. `tick` already coalesces with any in-flight/debounced run.
  const poll = setInterval(() => tick(), intervalSeconds * 1000);

  const watchingLabel = presentDirs.length
    ? presentDirs.join(", ")
    : "(no log directories found yet — polling)";
  console.log("");
  console.log(pc.green(`watching ${watchingLabel}`));
  console.log(
    pc.dim(
      `poll every ${intervalSeconds}s · recent window = today + ${lookbackDays} day(s) · Ctrl-C to stop`
    )
  );

  // Keep running until interrupted; Ctrl-C tears everything down cleanly.
  return new Promise((resolve) => {
    let stopped = false;
    const shutdown = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(poll);
      debounced.cancel();
      for (const w of watchers) {
        try {
          w.close();
        } catch (err) {
          /* ignore */
        }
      }
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      console.log("");
      console.log(pc.dim("Stopped watching."));
      resolve(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

module.exports = {
  runWatch,
  // Decoupled units, exported for testing.
  recentWindow,
  filterToWindow,
  recentSync,
  createWatchSync,
  createDebouncer,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_DEBOUNCE_MS,
};
