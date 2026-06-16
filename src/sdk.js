"use strict";

const { resolveToken, resolveApiUrl } = require("./config");
const { buildPayload } = require("./payload");
const { postPayload } = require("./ingest");

const PLATFORM_ANTHROPIC = "anthropic";
const PLATFORM_OPENAI = "openai";
const PLATFORM_OPENROUTER = "openrouter";

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
 * First finite number among the candidates, or 0. Used to read a count that two
 * API shapes name differently (e.g. prompt_tokens vs input_tokens).
 */
function firstNumber(...values) {
  for (const v of values) {
    if (typeof v === "number" && isFinite(v)) return v;
  }
  return 0;
}

/**
 * Build a Tokeburn usage record from an Anthropic Messages response.
 *
 * Returns null when the response carries no usage (e.g. a streaming response),
 * so the caller can skip it silently.
 *
 * Anthropic's `usage.input_tokens` is already exclusive of cached tokens, so —
 * unlike the Codex/OpenAI paths — no subtraction is needed: cache_read and
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
    platform: PLATFORM_ANTHROPIC,
    model,
    date: todayDate(now),
    input_tokens: toCount(usage.input_tokens),
    output_tokens: toCount(usage.output_tokens),
    cache_read_tokens: toCount(usage.cache_read_input_tokens),
    cache_creation_tokens: toCount(usage.cache_creation_input_tokens),
  };
}

/**
 * Build a Tokeburn usage record from an OpenAI response — handling both
 * Chat Completions (`chat.completions.create`) and Responses
 * (`responses.create`), which name the same counts differently:
 *
 *   Chat Completions: prompt_tokens, completion_tokens,
 *                     prompt_tokens_details.cached_tokens
 *   Responses:        input_tokens, output_tokens,
 *                     input_tokens_details.cached_tokens
 *
 * Returns null when the response carries no usage (e.g. a streaming response).
 *
 * Like Codex (and UNLIKE Anthropic), OpenAI's prompt/input count INCLUDES the
 * cached tokens. We follow the Anthropic convention used throughout Tokeburn —
 * input_tokens is EXCLUSIVE of cache, with the cached portion recorded
 * separately in cache_read_tokens — so a downstream
 * (input_tokens + cache_read_tokens) sum never double-counts the cache. There
 * is no OpenAI cache-write equivalent, so cache_creation_tokens stays 0.
 *
 * @param {object} response  An OpenAI response (the resolved create() value).
 * @param {Date}   [now]     Date used for the record (defaults to now).
 */
function buildOpenAIRecord(response, now = new Date()) {
  if (!response || typeof response !== "object") return null;
  const usage = response.usage;
  if (!usage || typeof usage !== "object") return null;

  const model =
    typeof response.model === "string" && response.model
      ? response.model
      : "unknown";

  // Chat Completions uses prompt_/completion_; Responses uses input_/output_.
  const promptTokens = firstNumber(usage.prompt_tokens, usage.input_tokens);
  const completionTokens = firstNumber(usage.completion_tokens, usage.output_tokens);

  const details =
    usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cached = toCount(details.cached_tokens);

  // Subtract the cached portion out of the prompt/input count so input_tokens
  // is exclusive of cache (cached lives in cache_read_tokens).
  const inputExclusive = Math.max(0, promptTokens - cached);

  return {
    platform: PLATFORM_OPENAI,
    model,
    date: todayDate(now),
    input_tokens: toCount(inputExclusive),
    output_tokens: toCount(completionTokens),
    cache_read_tokens: cached,
    cache_creation_tokens: 0,
  };
}

/**
 * Build a Tokeburn usage record from an OpenRouter response.
 *
 * OpenRouter is consumed through the OpenAI SDK pointed at openrouter.ai, so the
 * response is OpenAI-shaped: token normalization (including the cached-token
 * subtraction) is identical, and we reuse buildOpenAIRecord wholesale. The only
 * differences are:
 *
 *   - platform is tagged "openrouter" instead of "openai".
 *   - OpenRouter reports the REAL dollar cost of the call in `usage.cost` (USD)
 *     when usage accounting is enabled (see withUsageAccounting). When present
 *     we surface it as the optional `cost_usd` field; when absent we omit it and
 *     still send the tokens.
 *
 * Returns null when the response carries no usage (e.g. a streaming response).
 *
 * @param {object} response  An OpenRouter response (the resolved create() value).
 * @param {Date}   [now]     Date used for the record (defaults to now).
 */
function buildOpenRouterRecord(response, now = new Date()) {
  const record = buildOpenAIRecord(response, now);
  if (!record) return null;

  record.platform = PLATFORM_OPENROUTER;

  // OpenRouter returns the actual dollar cost in usage.cost (USD). It's optional
  // — only present when usage accounting is on — so set cost_usd only when it's
  // a real number, otherwise omit it (tokens are still recorded).
  const cost = response.usage.cost;
  if (typeof cost === "number" && isFinite(cost)) {
    record.cost_usd = cost;
  }

  return record;
}

/**
 * Detect the platform for an OpenAI-shaped client (chat.completions / responses).
 *
 * OpenRouter clients are OpenAI clients pointed at openrouter.ai, so they're
 * indistinguishable by shape — we disambiguate by `client.baseURL`: if it
 * contains "openrouter.ai" the platform is "openrouter", otherwise "openai".
 * `options.platform`, when provided, overrides the detection.
 *
 * @param {object} client
 * @param {object} [options]
 * @param {string} [options.platform]  Explicit override ("openai"/"openrouter").
 * @returns {string} "openai" or "openrouter" (or the override, verbatim).
 */
function detectOpenAIPlatform(client, options = {}) {
  if (typeof options.platform === "string" && options.platform) {
    return options.platform;
  }
  const baseURL =
    client && typeof client.baseURL === "string" ? client.baseURL : "";
  return baseURL.includes("openrouter.ai")
    ? PLATFORM_OPENROUTER
    : PLATFORM_OPENAI;
}

/**
 * Merge `{ usage: { include: true } }` into an OpenRouter create() call's args
 * so the response carries usage accounting (token counts AND the dollar cost),
 * WITHOUT overwriting any `usage` option the caller already set: caller-supplied
 * usage keys win over our default. Returns a new args array; the original is
 * left untouched.
 */
function withUsageAccounting(args) {
  const first =
    args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
      ? args[0]
      : {};
  const callerUsage =
    first.usage && typeof first.usage === "object" ? first.usage : {};

  const merged = {
    ...first,
    usage: { include: true, ...callerUsage },
  };
  return [merged, ...args.slice(1)];
}

/**
 * Capture usage from a response and POST it. Fire-and-forget: this is kept off
 * the critical path and MUST NOT throw into the caller's request. Any error
 * (no usage, no token, bad response, network failure) is swallowed and logged.
 *
 * `buildRecordFn` maps the platform-specific response into a Tokeburn record.
 *
 * Returns the in-flight Promise so callers/tests can await completion if they
 * want to; the wrapper itself never awaits it.
 */
async function captureAndSend(response, buildRecordFn, { token, apiUrl }) {
  try {
    const record = buildRecordFn(response);
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
 * Patch a single `<holder>.create` method so each resolved response's usage is
 * forward-captured and POSTed via `buildRecordFn`, without touching the value
 * returned to the caller. Idempotent per holder. Returns true if it patched.
 *
 * `transformArgs`, when provided, rewrites the call arguments before they reach
 * the original method (used by the OpenRouter path to enable usage accounting).
 */
function patchCreate(holder, buildRecordFn, { token, apiUrl, transformArgs }) {
  if (!holder || typeof holder.create !== "function") return false;

  // Idempotent: wrapping an already-wrapped method is a no-op.
  if (holder.create.__tokeburnWrapped) return true;

  const originalCreate = holder.create.bind(holder);

  function patchedCreate(...args) {
    const callArgs =
      typeof transformArgs === "function" ? transformArgs(args) : args;
    const result = originalCreate(...callArgs);

    // Forward-capture without touching the returned value. Use a detached
    // promise so the user's call (and its return value) are unaffected.
    Promise.resolve(result).then(
      (response) => {
        captureAndSend(response, buildRecordFn, { token, apiUrl });
      },
      () => {
        // The user's own call rejected — nothing to capture, and the
        // rejection is theirs to handle on the value we returned to them.
      }
    );

    return result; // unchanged
  }
  patchedCreate.__tokeburnWrapped = true;

  holder.create = patchedCreate;
  return true;
}

/**
 * Wrap a supported AI Node client so every supported `create` call's token
 * usage is forward-captured and POSTed to Tokeburn, reusing the CLI's payload
 * format and ingest path (source "sdk").
 *
 * The client is detected by duck-typing, and whichever create methods are
 * present get patched (all of them, if more than one exists):
 *
 *   client.messages.create           -> Anthropic Messages   (platform "anthropic")
 *   client.chat.completions.create   -> OpenAI Chat Completions (platform "openai")
 *   client.responses.create          -> OpenAI Responses     (platform "openai")
 *
 * OpenRouter is used through the OpenAI SDK pointed at openrouter.ai, so its
 * client is shape-identical to an OpenAI client. We disambiguate by inspecting
 * `client.baseURL` (or an explicit `options.platform` override): a baseURL
 * containing "openrouter.ai" tags records "openrouter" instead of "openai", and
 * enables usage accounting on each call so OpenRouter returns the real dollar
 * cost (surfaced as the optional `cost_usd` field). The Anthropic path is
 * unaffected by detection.
 *
 * The original response is returned UNCHANGED; the capture/POST happens after
 * it resolves, off the critical path, and never blocks or throws into the call.
 * v1 is non-streaming only — streaming responses carry no usage on the returned
 * object and are skipped silently. (Streaming support is a follow-up.)
 *
 * No runtime dependency on the Anthropic or OpenAI SDKs — clients are duck-typed.
 *
 * @param {object} client   An Anthropic-like or OpenAI-like client.
 * @param {object} [options]
 * @param {string} [options.token]      Tokeburn API token. Falls back to
 *   TOKEBURN_TOKEN / ~/.tokeburn config, the same resolution the CLI uses.
 * @param {string} [options.ingestUrl]  Ingest endpoint. Falls back through the
 *   CLI's resolution to the default Tokeburn ingest URL.
 * @param {string} [options.platform]   Override for OpenAI-shaped clients —
 *   "openai" or "openrouter". When omitted, the platform is detected from
 *   `client.baseURL`. Has no effect on the Anthropic path.
 * @returns {object} The same client, with its supported create methods patched.
 */
function withTokeburn(client, options = {}) {
  if (!client || typeof client !== "object") {
    throw new TypeError(
      "withTokeburn(client): client must be an Anthropic-like or OpenAI-like object"
    );
  }

  const env = options.env || process.env;
  const token = resolveToken({ token: options.token }, env);
  const apiUrl = resolveApiUrl({ url: options.ingestUrl }, env);
  const ctx = { token, apiUrl };

  // OpenAI-shaped clients (chat.completions / responses) may actually be talking
  // to OpenRouter via openrouter.ai. Detect once, then pick the matching record
  // builder; the OpenRouter path also enables usage accounting per call so the
  // response carries token counts AND the real dollar cost.
  const openaiPlatform = detectOpenAIPlatform(client, options);
  const isOpenRouter = openaiPlatform === PLATFORM_OPENROUTER;
  const openaiBuild = isOpenRouter ? buildOpenRouterRecord : buildOpenAIRecord;
  const openaiCtx = isOpenRouter
    ? { ...ctx, transformArgs: withUsageAccounting }
    : ctx;

  // Duck-type the client and patch whichever create methods exist.
  const targets = [
    [client.messages, buildRecord, ctx], // Anthropic
    [client.chat && client.chat.completions, openaiBuild, openaiCtx], // OpenAI/OpenRouter Chat
    [client.responses, openaiBuild, openaiCtx], // OpenAI/OpenRouter Responses
  ];

  let patched = 0;
  for (const [holder, build, holderCtx] of targets) {
    if (patchCreate(holder, build, holderCtx)) patched++;
  }

  if (patched === 0) {
    throw new TypeError(
      "withTokeburn(client): client must expose at least one supported create() " +
        "method (messages.create, chat.completions.create, or responses.create)"
    );
  }

  return client;
}

module.exports = {
  withTokeburn,
  buildRecord,
  buildOpenAIRecord,
  buildOpenRouterRecord,
};
