"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { withTokeburn } = require("..");

// Today's date in the same format the wrapper uses (UTC, YYYY-MM-DD).
const TODAY = new Date().toISOString().slice(0, 10);

// A fake non-streaming Anthropic message with usage + model.
function fakeMessage() {
  return {
    id: "msg_fake",
    model: "claude-opus-4-8",
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    usage: {
      input_tokens: 1840,
      output_tokens: 1250,
      cache_read_input_tokens: 2300,
      cache_creation_input_tokens: 200,
    },
  };
}

// Build a mock client whose messages.create returns the given message.
function mockClient(message) {
  return {
    messages: {
      create: async () => message,
    },
  };
}

// Swap in a stub fetch + silence console.error for the duration of a test,
// restoring both afterwards.
function withStubs(t, fetchImpl) {
  const realFetch = global.fetch;
  const realError = console.error;
  const errors = [];
  global.fetch = fetchImpl;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    global.fetch = realFetch;
    console.error = realError;
  });
  return { errors };
}

test("returns the original response unchanged and POSTs the mapped record", async (t) => {
  let captured = null;
  let resolveFetch;
  const fetchCalled = new Promise((r) => (resolveFetch = r));

  withStubs(t, async (url, init) => {
    captured = { url, init };
    resolveFetch();
    return { ok: true, status: 200, statusText: "OK", async text() { return ""; } };
  });

  const message = fakeMessage();
  const client = withTokeburn(mockClient(message), {
    token: "tok_test",
    ingestUrl: "https://example.test/ingest",
    env: {}, // isolate from real env/config
  });

  const res = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  });

  // Original response is returned UNCHANGED (same object reference).
  assert.equal(res, message);

  // The POST is fire-and-forget; wait for it to be attempted.
  await fetchCalled;

  assert.equal(captured.url, "https://example.test/ingest");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer tok_test");

  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.source, "sdk");
  assert.equal(payload.usage.length, 1);

  // Anthropic usage maps straight across — input_tokens is NOT reduced by cache.
  assert.deepEqual(payload.usage[0], {
    platform: "anthropic",
    model: "claude-opus-4-8",
    date: TODAY,
    input_tokens: 1840,
    output_tokens: 1250,
    cache_read_tokens: 2300,
    cache_creation_tokens: 200,
  });
});

test("the user's call still succeeds when the POST fails", async (t) => {
  let resolveAttempt;
  const sendAttempted = new Promise((r) => (resolveAttempt = r));

  const { errors } = withStubs(t, async () => {
    resolveAttempt();
    throw new Error("network down");
  });

  const message = fakeMessage();
  const client = withTokeburn(mockClient(message), {
    token: "tok_test",
    ingestUrl: "https://example.test/ingest",
    env: {},
  });

  // Must resolve with the original message, not reject.
  const res = await client.messages.create({ messages: [] });
  assert.equal(res, message);

  // The background send was attempted and the failure was swallowed + logged.
  await sendAttempted;
  await new Promise((r) => setImmediate(r)); // let the catch run
  assert.ok(errors.some((e) => /usage capture failed/.test(e)));
});

test("skips silently when the response has no usage (e.g. streaming)", async (t) => {
  let fetched = false;
  withStubs(t, async () => {
    fetched = true;
    return { ok: true, status: 200, async text() { return ""; } };
  });

  // A streaming-style return value with no `usage` field.
  const streamLike = { model: "claude-opus-4-8", [Symbol.asyncIterator]() {} };
  const client = withTokeburn(mockClient(streamLike), {
    token: "tok_test",
    ingestUrl: "https://example.test/ingest",
    env: {},
  });

  const res = await client.messages.create({ stream: true, messages: [] });
  assert.equal(res, streamLike);

  // Give any (incorrect) background work a chance to run, then assert no POST.
  await new Promise((r) => setImmediate(r));
  assert.equal(fetched, false);
});

test("withTokeburn rejects a client without messages.create", () => {
  assert.throws(() => withTokeburn({}), TypeError);
  assert.throws(() => withTokeburn(null), TypeError);
});
