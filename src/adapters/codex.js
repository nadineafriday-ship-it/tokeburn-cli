"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const PLATFORM = "codex";

// Token fields that may appear on a Codex "token_count" usage object.
const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

/**
 * Resolve the Codex root directory.
 * CODEX_HOME overrides ~/.codex (matches the Codex CLI's own convention and is
 * convenient for testing).
 */
function codexRoot(env = process.env) {
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()) {
    return env.CODEX_HOME.trim();
  }
  return path.join(os.homedir(), ".codex");
}

/**
 * Recursively collect rollout-*.jsonl files under a directory.
 * Returns [] if the directory is missing or unreadable.
 */
function findRolloutFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findRolloutFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.startsWith("rollout-") &&
      entry.name.endsWith(".jsonl")
    ) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Extract a YYYY-MM-DD date string from an ISO8601 timestamp.
 * Returns null if unparseable.
 */
function dateFromTimestamp(ts) {
  if (typeof ts !== "string") return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function toCount(value) {
  return typeof value === "number" && isFinite(value) && value > 0 ? value : 0;
}

/**
 * Best-effort event "type" from a parsed line.
 * The Codex log format has changed over time: the kind may live directly on the
 * record (`type`/`record_type`) or nested in a `payload` wrapper
 * (`{ type: "event_msg", payload: { type: "token_count" } }`).
 */
function eventType(obj) {
  if (obj.payload && typeof obj.payload === "object" && typeof obj.payload.type === "string") {
    return obj.payload.type;
  }
  if (typeof obj.type === "string") return obj.type;
  if (typeof obj.record_type === "string") return obj.record_type;
  return null;
}

/**
 * Best-effort timestamp for a line, checking the locations seen across versions.
 */
function timestampOf(obj) {
  if (typeof obj.timestamp === "string") return obj.timestamp;
  if (obj.payload && typeof obj.payload.timestamp === "string") return obj.payload.timestamp;
  return null;
}

/**
 * Best-effort model name from a non-token line (turn_context / session metadata).
 * The model is NOT on token_count events, so callers should only feed this the
 * context/metadata lines. Returns null if no model is present.
 */
function extractModel(obj) {
  const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : null;
  const candidates = [
    payload && payload.model,
    obj.model,
    payload && payload.turn_context && payload.turn_context.model,
    payload && payload.info && payload.info.model,
    payload && payload.session && payload.session.model,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function hasTokenFields(o) {
  if (!o || typeof o !== "object") return false;
  for (const f of TOKEN_FIELDS) {
    if (typeof o[f] === "number") return true;
  }
  return false;
}

/**
 * Locate the usage object on a token_count event across format versions.
 *
 * Modern logs nest a cumulative `total_token_usage` and a per-turn delta
 * `last_token_usage` under `info`. We prefer the *delta* so that summing across
 * a session's events does not double-count the running total. Older/simplified
 * logs put the token fields directly on the event/payload. Returns null if no
 * usable counts are present.
 */
function extractUsage(obj) {
  const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : null;
  const info = payload && typeof payload.info === "object" ? payload.info : obj.info;
  const candidates = [
    info && info.last_token_usage,
    payload && payload.last_token_usage,
    obj.last_token_usage,
    info, // info with fields directly on it (some versions)
    payload && payload.usage,
    payload, // simplified: fields directly on payload
    obj.usage,
    obj, // simplest: fields directly on the record
  ];
  for (const c of candidates) {
    if (hasTokenFields(c)) return c;
  }
  return null;
}

/**
 * Read Codex usage logs and aggregate by (model, date).
 * Returns { records: [...], notes: [...] }.
 * Never throws on bad input.
 */
function collect(env = process.env) {
  const root = codexRoot(env);
  const notes = [];

  const searchDirs = [path.join(root, "sessions"), path.join(root, "archived_sessions")];
  const rolloutFiles = [];
  for (const dir of searchDirs) {
    rolloutFiles.push(...findRolloutFiles(dir));
  }

  if (rolloutFiles.length === 0) {
    notes.push("Codex: no local data found");
    return { records: [], notes };
  }

  // Aggregate keyed by `${model} ${date}`.
  const agg = new Map();
  let malformed = 0;
  let skippedNoModel = 0;

  for (const file of rolloutFiles) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (err) {
      continue; // skip unreadable file
    }

    // Model attribution is per-session (per file): track the most recent model
    // seen and attribute following token_count events to it.
    let currentModel = null;

    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (err) {
        malformed++;
        continue; // skip malformed line
      }

      if (!obj || typeof obj !== "object") {
        malformed++;
        continue;
      }

      const type = eventType(obj);

      if (type !== "token_count") {
        // Non-token line: see if it tells us the active model.
        const model = extractModel(obj);
        if (model) currentModel = model;
        continue;
      }

      // token_count event.
      if (!currentModel) {
        // Older logs lack a determinable model — skip rather than misattribute.
        skippedNoModel++;
        continue;
      }

      const usage = extractUsage(obj);
      if (!usage) continue; // nothing usable on this event

      const date = dateFromTimestamp(timestampOf(obj));
      if (!date) continue; // skip events we can't date

      const key = `${currentModel} ${date}`;
      let rec = agg.get(key);
      if (!rec) {
        rec = {
          platform: PLATFORM,
          model: currentModel,
          date,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        };
        agg.set(key, rec);
      }

      const input = toCount(usage.input_tokens);
      const cached = toCount(usage.cached_input_tokens);
      // Codex's input_tokens INCLUDES the cached portion (cached_input_tokens is
      // a subset of input_tokens). The Claude Code adapter follows the Anthropic
      // convention where input_tokens is EXCLUSIVE of cache and the cached count
      // lives separately in cache_read_tokens, so a downstream
      // (input_tokens + cache_read_tokens) sum never double-counts the cache.
      // Match that convention: subtract the cached portion out of input and
      // record it under cache_read_tokens. There is no Codex cache-creation
      // equivalent, so cache_creation_tokens stays 0. reasoning_output_tokens is
      // a subset of output_tokens and is not added again.
      rec.input_tokens += Math.max(0, input - cached);
      rec.output_tokens += toCount(usage.output_tokens);
      rec.cache_read_tokens += cached;
    }
  }

  const records = Array.from(agg.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });

  if (malformed > 0) {
    notes.push(`Codex: skipped ${malformed} malformed line(s)`);
  }
  if (skippedNoModel > 0) {
    notes.push(`Codex: skipped ${skippedNoModel} token event(s) with no determinable model`);
  }
  if (records.length === 0) {
    notes.push("Codex: no usage records found in local logs");
  }

  return { records, notes };
}

module.exports = { platform: PLATFORM, collect };
