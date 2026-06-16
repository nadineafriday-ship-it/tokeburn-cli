"use strict";

const { resolveToken, resolveApiUrl } = require("./config");
const { buildPayload } = require("./payload");
const { postPayload } = require("./ingest");

const PLATFORM = "anthropic";

/**
 * Today's date as YYYY-MM-DD (UTC), matching the adapters' date format.
 */
function todayDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function toCount(value) {
  return typeof value === "number" && isFinite(value) && value > 0 ? value : 0;
}

/**
 * Build a Tokeburn usage record from an Anthropic Messages response.
 *
 * Returns null when the response carries no usage (e.g. a streaming response),
 * so the caller can skip it silently.
 *
 * Anthropic's `usage.input_tokens` is already exclusive of cached tokens, so —
 * unlike the Codex adapter — no subtraction is needed: cache_read and
 * cache_creation map straight across from their `*_input_tokens` fields.
 *
 * @param {object} response  An Anthropic message (the resolved create() value).
 * @param {Date}   [now]     Date used for the record (defaults to now).
 */
function buildRecord(response, now = new Date()) {
  if (!response || typeof response !== "object") return null;
  const usage = response.usage;
  if (!usage || typeof usage !== "object") return null;

  const model =
    typeof response.model === "string" && response.model
      ? response.model
      : "unknown";

  return {
    platform: PLATFORM,
    model,
    date: todayDate(now),
    input_tokens: toCount(usage.input_tokens),
    output_tokens: toCount(usage.output_tokens),
    cache_read_tokens: toCount(usage.cache_read_input_tokens),
    cache_creation_tokens: toCount(usage.cache_creation_input_tokens),
  };
}

/**
 * Capture usage from a response and POST it. Fire-and-forget: this is kept off
 * the critical path and MUST NOT throw into the caller's request. Any error
 * (no usage, no token, bad response, network failure) is swallowed and logged.
 *
 * Returns the in-flight Promise so callers/tests can await completion if they
 * want to; the wrapper itself never awaits it.
 */
async function captureAndSend(response, { token, apiUrl }) {
  try {
    const record = buildRecord(response);
    if (!record) return; // no usage (e.g. streaming) — skip silently

    if (!token) {
      // Nothing to authenticate with; don't attempt a doomed POST.
      logError("no Tokeburn API token configured; usage not sent");
      return;
    }

    const payload = buildPayload([record], { source: "sdk" });
    const res = await postPayload(payload, { token, apiUrl });
    if (res && !res.ok) {
      logError(`ingest responded ${res.status} ${res.statusText || ""}`.trim());
    }
  } catch (err) {
    logError(err && err.message ? err.message : String(err));
  }
}

function logError(message) {
  // Log only — never throw. Kept to a single concise line.
  try {
    console.error(`[tokeburn] usage capture failed: ${message}`);
  } catch (_) {
    /* ignore logging failures */
  }
}

/**
 * Wrap an Anthropic Node client so every `messages.create` call's token usage
 * is forward-captured and POSTed to Tokeburn, reusing the CLI's payload format
 * and ingest path (source "sdk").
 *
 * The original response is returned UNCHANGED; the capture/POST happens after
 * it resolves, off the critical path, and never blocks or throws into the call.
 * v1 is non-streaming only — streaming responses carry no usage on the returned
 * object and are skipped silently. (Streaming support is a follow-up: it would
 * need to read usage from the terminal message_delta / final-message event.)
 *
 * No runtime dependency on the Anthropic SDK — the client is duck-typed.
 *
 * @param {object} client   An Anthropic-like client with `messages.create`.
 * @param {object} [options]
 * @param {string} [options.token]      Tokeburn API token. Falls back to
 *   TOKEBURN_TOKEN / ~/.tokeburn config, the same resolution the CLI uses.
 * @param {string} [options.ingestUrl]  Ingest endpoint. Falls back through the
 *   CLI's resolution to the default Tokeburn ingest URL.
 * @returns {object} The same client, with `messages.create` patched.
 */
function withTokeburn(client, options = {}) {
  if (!client || typeof client !== "object") {
    throw new TypeError(
      "withTokeburn(client): client must be an Anthropic-like object"
    );
  }
  const messages = client.messages;
  if (!messages || typeof messages.create !== "function") {
    throw new TypeError(
      "withTokeburn(client): client.messages.create must be a function"
    );
  }

  // Idempotent: wrapping an already-wrapped client is a no-op.
  if (messages.create.__tokeburnWrapped) return client;

  const env = options.env || process.env;
  const token = resolveToken({ token: options.token }, env);
  const apiUrl = resolveApiUrl({ url: options.ingestUrl }, env);

  const originalCreate = messages.create.bind(messages);

  function patchedCreate(...args) {
    const result = originalCreate(...args);

    // Forward-capture without touching the returned value. Use a detached
    // promise so the user's call (and its return value) are unaffected.
    Promise.resolve(result).then(
      (response) => {
        captureAndSend(response, { token, apiUrl });
      },
      () => {
        // The user's own call rejected — nothing to capture, and the
        // rejection is theirs to handle on the value we returned to them.
      }
    );

    return result; // unchanged
  }
  patchedCreate.__tokeburnWrapped = true;

  messages.create = patchedCreate;
  return client;
}

module.exports = { withTokeburn, buildRecord };
