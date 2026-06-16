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

## SDK: wrap your Anthropic client

If you call the [Anthropic Node SDK](https://www.npmjs.com/package/@anthropic-ai/sdk)
directly from your own code, you can have Tokeburn capture token usage from
every API call automatically — no log files, no `sync` command. Wrap your
client once:

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

After each `messages.create` call resolves, the wrapper reads `response.usage`
and `response.model`, builds a usage record, and POSTs it to the same Tokeburn
ingest endpoint the CLI uses (with `source: "sdk"`). This happens
fire-and-forget, off the critical path: it never blocks or throws into your
call, and failures are swallowed and logged only.

`withTokeburn(client, options)`:

| Option | Description |
| --- | --- |
| `token` | Tokeburn API token. Falls back to `TOKEBURN_TOKEN`, then `~/.tokeburn/config.json` — the same resolution the CLI uses. |
| `ingestUrl` | Override the ingest URL. Defaults through `TOKEBURN_API_URL` / config to the standard Tokeburn ingest endpoint. |

Notes:

- **Non-streaming only (v1).** Streaming responses carry no usage on the
  returned value and are skipped silently. Capturing streamed usage (from the
  terminal `message_delta` / final-message event) is a planned follow-up.
- **No dependency on the Anthropic SDK.** The client is duck-typed — the
  wrapper only needs a `messages.create` method, so `tokeburn` adds no runtime
  dependency on `@anthropic-ai/sdk`.

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
