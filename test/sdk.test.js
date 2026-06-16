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

test("withTokeburn rejects a client with no supported create method", () => {
  assert.throws(() => withTokeburn({}), TypeError);
  assert.throws(() => withTokeburn(null), TypeError);
});

// ---------------------------------------------------------------------------
// OpenAI support
// ---------------------------------------------------------------------------

// A fake non-streaming OpenAI Chat Completions response. prompt_tokens INCLUDES
// the cached portion (cached_tokens lives under prompt_tokens_details).
function fakeChatCompletion() {
  return {
    id: "chatcmpl_fake",
    object: "chat.completion",
    model: "gpt-4.1",
    choices: [{ message: { role: "assistant", content: "hi" } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 400 },
    },
  };
}

// A fake non-streaming OpenAI Responses response. input_tokens INCLUDES the
// cached portion (cached_tokens lives under input_tokens_details).
function fakeOpenAIResponse() {
  return {
    id: "resp_fake",
    object: "response",
    model: "gpt-4.1",
    output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
      input_tokens_details: { cached_tokens: 400 },
    },
  };
}

function mockChatClient(response) {
  return {
    chat: { completions: { create: async () => response } },
  };
}

function mockResponsesClient(response) {
  return {
    responses: { create: async () => response },
  };
}

// Run a create() call through a stubbed fetch and return the parsed payload.
async function capturePayload(t, client, callFn) {
  let captured = null;
  let resolveFetch;
  const fetchCalled = new Promise((r) => (resolveFetch = r));
  withStubs(t, async (url, init) => {
    captured = { url, init };
    resolveFetch();
    return { ok: true, status: 200, statusText: "OK", async text() { return ""; } };
  });

  const res = await callFn(client);
  await fetchCalled;
  return { res, captured, payload: JSON.parse(captured.init.body) };
}

test("OpenAI Chat Completions: subtracts cached tokens and maps to platform openai", async (t) => {
  const response = fakeChatCompletion();
  const client = withTokeburn(mockChatClient(response), {
    token: "tok_test",
    ingestUrl: "https://example.test/ingest",
    env: {},
  });

  const { res, payload } = await capturePayload(t, client, (c) =>
    c.chat.completions.create({ model: "gpt-4.1", messages: [] })
  );

  // Original response returned unchanged.
  assert.equal(res, response);

  assert.equal(payload.source, "sdk");
  assert.equal(payload.usage.length, 1);
  assert.deepEqual(payload.usage[0], {
    platform: "openai",
    model: "gpt-4.1",
    date: TODAY,
    input_tokens: 600, // 1000 prompt - 400 cached
    output_tokens: 200,
    cache_read_tokens: 400,
    cache_creation_tokens: 0,
  });
});

test("OpenAI Responses: subtracts cached tokens and maps to platform openai", async (t) => {
  const response = fakeOpenAIResponse();
  const client = withTokeburn(mockResponsesClient(response), {
    token: "tok_test",
    ingestUrl: "https://example.test/ingest",
    env: {},
  });

  const { res, payload } = await capturePayload(t, client, (c) =>
    c.responses.create({ model: "gpt-4.1", input: "hi" })
  );

  // Original response returned unchanged.
  assert.equal(res, response);

  assert.deepEqual(payload.usage[0], {
    platform: "openai",
    model: "gpt-4.1",
    date: TODAY,
    input_tokens: 600, // 1000 input - 400 cached
    output_tokens: 200,
    cache_read_tokens: 400,
    cache_creation_tokens: 0,
  });
});

test("OpenAI: the user's call still succeeds when the POST fails", async (t) => {
  let resolveAttempt;
  const sendAttempted = new Promise((r) => (resolveAttempt = r));

  const { errors } = withStubs(t, async () => {
    resolveAttempt();
    throw new Error("network down");
  });

  const response = fakeChatCompletion();
  const client = withTokeburn(mockChatClient(response), {
    token: "tok_test",
    ingestUrl: "https://example.test/ingest",
    env: {},
  });

  // Must resolve with the original response, not reject.
  const res = await client.chat.completions.create({ messages: [] });
  assert.equal(res, response);

  await sendAttempted;
  await new Promise((r) => setImmediate(r)); // let the catch run
  assert.ok(errors.some((e) => /usage capture failed/.test(e)));
});

test("OpenAI: skips silently when the response has no usage (streaming)", async (t) => {
  let fetched = false;
  withStubs(t, async () => {
    fetched = true;
    return { ok: true, status: 200, async text() { return ""; } };
  });

  const streamLike = { model: "gpt-4.1", [Symbol.asyncIterator]() {} };
  const client = withTokeburn(mockChatClient(streamLike), {
    token: "tok_test",
    ingestUrl: "https://example.test/ingest",
    env: {},
  });

  const res = await client.chat.completions.create({ stream: true, messages: [] });
  assert.equal(res, streamLike);

  await new Promise((r) => setImmediate(r));
  assert.equal(fetched, false);
});

test("withTokeburn patches every supported create method present on one client", async (t) => {
  // A combined client exposing all three surfaces.
  const client = withTokeburn(
    {
      messages: { create: async () => fakeMessage() },
      chat: { completions: { create: async () => fakeChatCompletion() } },
      responses: { create: async () => fakeOpenAIResponse() },
    },
    { token: "tok_test", ingestUrl: "https://example.test/ingest", env: {} }
  );

  assert.equal(client.messages.create.__tokeburnWrapped, true);
  assert.equal(client.chat.completions.create.__tokeburnWrapped, true);
  assert.equal(client.responses.create.__tokeburnWrapped, true);
});
