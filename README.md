# tokeburn

> **Canonical source home.** This repository is the canonical source home for
> the [`tokeburn`](https://www.npmjs.com/package/tokeburn) package published on
> npm. The code here is the source of truth for what is published; the npm
> tarball is built from this repo.

Sync your local AI coding-tool token usage into [Tokeburn](https://tokeburn.app).

Some of your AI token spend only exists locally — terminal coding tools like
Claude Code write usage logs to your machine that the Tokeburn web app can't
read on its own. This CLI reads those local logs, aggregates the token counts,
and sends them to your Tokeburn account so your $/Mt efficiency score reflects
everything.

## Install / Usage

No install needed — run it with `npx`:

```sh
npx tokeburn sync
```

Or install it globally:

```sh
npm install -g tokeburn
tokeburn sync
```

Requires **Node.js 18+** (uses the built-in `fetch`).

## Getting an API token

1. Open Tokeburn and go to **Settings**.
2. Create a personal **API token**.
3. Make it available to the CLI in one of these ways:
   - Pass it directly: `tokeburn sync --token <your-token>`
   - Set an environment variable: `export TOKEBURN_TOKEN=<your-token>`
   - Save it in `~/.tokeburn/config.json`:
     ```json
     {
       "token": "<your-token>",
       "apiUrl": "https://api.tokeburn.app/api/public/ingest"
     }
     ```

The token is resolved in that order: `--token` flag → `TOKEBURN_TOKEN` →
config file.

## Commands

### `tokeburn sync`

Reads your local AI usage logs and POSTs the aggregated counts to Tokeburn.

| Flag | Description |
| --- | --- |
| `--dry-run` | Do everything except the POST, and print the exact JSON payload that would be sent. |
| `--token <token>` | Override the API token. |
| `--url <url>` | Override the ingest URL. |

### `tokeburn watch`

Keeps your usage flowing automatically so the dashboard stays live for Claude
Code and Codex without re-running `sync` by hand. On start it runs the same full
`sync` once (catch-up / backfill), then watches your local log directories and
re-syncs whenever they change — no need to leave a terminal babysitting it.

```bash
tokeburn watch
```

| Flag | Default | Description |
| --- | --- | --- |
| `--interval <seconds>` | `60` | Fallback poll interval. A sync runs at least this often regardless of filesystem events. |
| `--lookback-days <days>` | `2` | How many days before today to re-sync on each change, to catch late writes. |
| `--token <token>` | | Override the API token. |
| `--url <url>` | | Override the ingest URL. |

**How it works**

- **Initial full sync.** Runs the existing one-shot `sync` once so you're
  current immediately.
- **Watch + poll.** Uses `fs.watch` on the directories the adapters already read
  (Claude Code's `~/.claude/{projects,transcripts}` and Codex's
  `$CODEX_HOME`/`~/.codex/{sessions,archived_sessions}`), plus a poll interval as
  a safety net for events `fs.watch` can miss.
- **Debounce.** Filesystem events are debounced (~2.5s) so a burst of writes from
  a single agent turn collapses into one sync.
- **Recent window only.** Each change re-syncs only **today + `--lookback-days`**,
  not the full history. Ingest upserts by `(user, platform, model, date)`, so
  repeated syncs of the same day are idempotent.
- **Resilient.** A failed sync is logged and the loop keeps running; `Ctrl-C`
  exits cleanly.

Output is intentionally quiet: a `watching <dirs>` line on start and a short
`synced N events at HH:MM:SS` line per sync.

**Platform caveat:** `fs.watch` recursive mode is only supported on macOS and
Windows. On Linux the watcher falls back to a shallow (non-recursive) watch, so
deep writes (e.g. Codex's dated `sessions/YYYY/MM/DD/…` files) are caught by the
poll interval rather than instantly. Lower `--interval` if you want tighter
latency there. `sync` itself is unchanged.

Other built-ins: `tokeburn --version`, `tokeburn --help`.

The ingest URL is resolved in this order: `--url` flag → `TOKEBURN_API_URL`
env → `apiUrl` in the config file → the default Tokeburn ingest endpoint.

## Supported data sources

| Platform | Status |
| --- | --- |
| Claude Code | ✅ Supported |
| Codex | ✅ Supported |
| Cursor | 🔜 Coming soon |
| GitHub Copilot | 🔜 Coming soon |

### Claude Code

The CLI reads Claude Code's per-session `.jsonl` logs under
`~/.claude/projects/<project>/*.jsonl` (and `~/.claude/transcripts/*.jsonl` if
present), then aggregates token counts grouped by model and date.

Set `TOKEBURN_CLAUDE_DIR` to point at a different `.claude` root (useful for
testing).

### Codex

The CLI reads the Codex CLI's per-session `rollout-*.jsonl` logs (searched
recursively under `sessions/` and `archived_sessions/`), then aggregates token
counts grouped by model and date — the same shape as Claude Code.

Codex `token_count` events don't carry the model name, so the model is taken
from the most recent `turn_context` (or session metadata) seen earlier in the
same session. Token events that appear before any model is known (older logs)
are skipped rather than misattributed. The per-turn `last_token_usage` delta is
used so summing across a session doesn't double-count its running total. Codex's
`cached_input_tokens` maps to `cache_read_tokens`; there is no cache-creation
equivalent.

By default the logs are read from `~/.codex`. Set `CODEX_HOME` to point at a
different Codex root (matches the Codex CLI's own convention; useful for
testing).

## SDK: wrap your Anthropic or OpenAI client

If you call the [Anthropic Node SDK](https://www.npmjs.com/package/@anthropic-ai/sdk)
or the [OpenAI Node SDK](https://www.npmjs.com/package/openai) directly from
your own code, you can have Tokeburn capture token usage from every API call
automatically — no log files, no `sync` command. Wrap your client once:

```js
import Anthropic from "@anthropic-ai/sdk";
import { withTokeburn } from "tokeburn";

const client = withTokeburn(new Anthropic(), {
  token: process.env.TOKEBURN_TOKEN, // optional — see resolution below
});

// Use the client exactly as before. The response is returned unchanged.
const message = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});
```

The same wrapper works for the OpenAI client and patches whichever create
methods are present:

```js
import OpenAI from "openai";
import { withTokeburn } from "tokeburn";

const openai = withTokeburn(new OpenAI());

// Chat Completions...
await openai.chat.completions.create({
  model: "gpt-4.1",
  messages: [{ role: "user", content: "Hello" }],
});

// ...and the Responses API are both captured.
await openai.responses.create({ model: "gpt-4.1", input: "Hello" });
```

[OpenRouter](https://openrouter.ai) is used through the same OpenAI SDK, just
pointed at `openrouter.ai`, so the same wrapper handles it too — it detects the
provider from the client's base URL:

```js
import OpenAI from "openai";
import { withTokeburn } from "tokeburn";

const openrouter = withTokeburn(
  new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  })
);

// Tagged as `openrouter`, with the real dollar cost captured (see below).
await openrouter.chat.completions.create({
  model: "openai/gpt-4.1",
  messages: [{ role: "user", content: "Hello" }],
});
```

`withTokeburn` detects the client by duck-typing and patches every supported
create method it finds:

| Method | Platform |
| --- | --- |
| `client.messages.create` | `anthropic` |
| `client.chat.completions.create` | `openai` / `openrouter` (Chat Completions) |
| `client.responses.create` | `openai` / `openrouter` (Responses) |

For OpenAI-shaped clients (`chat.completions` / `responses`), the platform is
`openrouter` when `client.baseURL` contains `openrouter.ai`, otherwise `openai`.
Pass `platform: "openai" | "openrouter"` to override the detection.

After each create call resolves, the wrapper reads `response.usage` and
`response.model`, builds a usage record, and POSTs it to the same Tokeburn
ingest endpoint the CLI uses (with `source: "sdk"`). This happens
fire-and-forget, off the critical path: it never blocks or throws into your
call, and failures are swallowed and logged only.

`withTokeburn(client, options)`:

| Option | Description |
| --- | --- |
| `token` | Tokeburn API token. Falls back to `TOKEBURN_TOKEN`, then `~/.tokeburn/config.json` — the same resolution the CLI uses. |
| `ingestUrl` | Override the ingest URL. Defaults through `TOKEBURN_API_URL` / config to the standard Tokeburn ingest endpoint. |
| `platform` | Override the platform for OpenAI-shaped clients — `"openai"` or `"openrouter"`. When omitted, it's detected from `client.baseURL`. No effect on the Anthropic path. |

Notes:

- **Cached tokens are subtracted out of the input count for OpenAI.** Both
  OpenAI APIs bundle cached tokens inside the prompt/input count
  (`prompt_tokens` / `input_tokens`), so the wrapper subtracts
  `cached_tokens` and records it separately under `cache_read_tokens`. This
  keeps `input_tokens` exclusive of cache — matching the Anthropic convention —
  so a downstream `input_tokens + cache_read_tokens` never double-counts.
  OpenAI has no cache-write tokens, so `cache_creation_tokens` is always `0`.
  Anthropic's `input_tokens` is already cache-exclusive and maps straight across.
- **OpenRouter reports a real dollar cost.** OpenRouter normalizes tokens
  exactly like OpenAI (same cached-token subtraction), but it also returns the
  actual cost of the call. The wrapper enables usage accounting on each call
  (merging `{ usage: { include: true } }` into your request args without
  clobbering any `usage` option you set), and surfaces `usage.cost` (USD) as the
  optional `cost_usd` field on the record. If the response carries no cost,
  `cost_usd` is omitted and the tokens are still sent. Only `openrouter` records
  carry `cost_usd`; `anthropic` and `openai` records never do.
- **Non-streaming only (v1).** Streaming responses carry no usage on the
  returned value and are skipped silently. Capturing streamed usage is a
  planned follow-up.
- **No dependency on the Anthropic or OpenAI SDK.** Clients are duck-typed —
  the wrapper only needs the relevant `create` method, so `tokeburn` adds no
  runtime dependency on `@anthropic-ai/sdk` or `openai`.

## Payload shape

```json
{
  "source": "cli",
  "cli_version": "0.1.0",
  "synced_at": "2026-06-15T14:05:26.450Z",
  "usage": [
    {
      "platform": "claude-code",
      "model": "claude-sonnet-4-20250514",
      "date": "2026-06-10",
      "input_tokens": 1840,
      "output_tokens": 1250,
      "cache_read_tokens": 2300,
      "cache_creation_tokens": 200
    }
  ]
}
```

## License

MIT
