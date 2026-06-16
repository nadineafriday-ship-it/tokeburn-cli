"use strict";

const pc = require("picocolors");
const { resolveToken, resolveApiUrl } = require("./config");
const { collectAll } = require("./adapters");
const { buildPayload, summarize } = require("./payload");
const { postPayload } = require("./ingest");

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function printNotes(notes) {
  for (const note of notes) {
    console.log(pc.dim("• " + note));
  }
}

function printSummary(records) {
  const s = summarize(records);
  console.log("");
  console.log(pc.bold("Summary"));
  console.log(`  Records: ${pc.cyan(fmt(s.count))}`);
  console.log(`  Input tokens:  ${pc.cyan(fmt(s.totalInput))}`);
  console.log(`  Output tokens: ${pc.cyan(fmt(s.totalOutput))}`);
  if (s.totalCacheRead || s.totalCacheCreation) {
    console.log(`  Cache read:    ${pc.dim(fmt(s.totalCacheRead))}`);
    console.log(`  Cache create:  ${pc.dim(fmt(s.totalCacheCreation))}`);
  }
  if (s.byPlatform.size > 0) {
    console.log(pc.bold("  By platform:"));
    for (const [platform, p] of s.byPlatform) {
      console.log(
        `    ${platform}: ${fmt(p.records)} records, ` +
          `${fmt(p.input_tokens)} in / ${fmt(p.output_tokens)} out`
      );
    }
  }
}

function missingTokenMessage() {
  console.error(pc.yellow("No Tokeburn API token found."));
  console.error("");
  console.error("To sync your usage, create an API token in Tokeburn:");
  console.error("  1. Open Tokeburn and go to " + pc.bold("Settings"));
  console.error("  2. Create a personal API token");
  console.error("  3. Make it available to the CLI in one of these ways:");
  console.error("       - run: " + pc.cyan("tokeburn sync --token <your-token>"));
  console.error("       - or set: " + pc.cyan("export TOKEBURN_TOKEN=<your-token>"));
  console.error("       - or save it in " + pc.cyan("~/.tokeburn/config.json") +
    ' as { "token": "<your-token>" }');
  console.error("");
  console.error("Then run " + pc.cyan("tokeburn sync") + " again.");
}

/**
 * Run the sync command.
 * Returns a process exit code (0 = success).
 */
async function runSync(opts = {}, env = process.env) {
  const dryRun = Boolean(opts.dryRun);

  // Token is required even for a dry run (so dry-run reflects a real send),
  // EXCEPT it is fine to inspect without one — but the spec wants a clear
  // friendly message and non-zero exit when no token is found.
  const token = resolveToken(opts, env);
  const apiUrl = resolveApiUrl(opts, env);

  if (!token) {
    missingTokenMessage();
    return 1;
  }

  console.log(pc.bold("Collecting local AI usage…"));
  const { records, notes } = collectAll(env);
  printNotes(notes);

  const payload = buildPayload(records);

  if (dryRun) {
    console.log("");
    console.log(pc.bold("Dry run — payload that would be POSTed to:"));
    console.log("  " + pc.cyan(apiUrl));
    console.log("");
    console.log(JSON.stringify(payload, null, 2));
    printSummary(records);
    console.log("");
    console.log(pc.green("Dry run complete. Nothing was sent."));
    return 0;
  }

  if (records.length === 0) {
    printSummary(records);
    console.log("");
    console.log(pc.yellow("No usage records found — nothing to sync."));
    return 0;
  }

  let response;
  try {
    response = await postPayload(payload, { token, apiUrl });
  } catch (err) {
    console.error("");
    console.error(pc.red("Could not reach Tokeburn: ") + (err && err.message ? err.message : String(err)));
    console.error("Check your network connection and the ingest URL, then try again.");
    return 1;
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch (err) {
      /* ignore */
    }
    console.error("");
    console.error(
      pc.red(`Tokeburn returned an error: ${response.status} ${response.statusText}`)
    );
    if (response.status === 401 || response.status === 403) {
      console.error("Your API token may be invalid or expired. Check Settings in Tokeburn.");
    }
    if (detail) console.error(pc.dim(detail));
    return 1;
  }

  console.log("");
  console.log(pc.green("✓ Synced to Tokeburn."));
  printSummary(records);
  return 0;
}

module.exports = { runSync };
