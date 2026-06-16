#!/usr/bin/env node
"use strict";

const { Command } = require("commander");
const pc = require("picocolors");
const pkg = require("../package.json");
const { runSync } = require("../src/sync");

const program = new Command();

program
  .name("tokeburn")
  .description("Sync your local AI coding-tool token usage into Tokeburn.")
  .version(pkg.version, "-v, --version", "output the current version");

program
  .command("sync")
  .description("Read local AI usage logs and send them to Tokeburn.")
  .option("--dry-run", "do everything except the POST; print the JSON payload that would be sent")
  .option("--token <token>", "override the Tokeburn API token")
  .option("--url <url>", "override the Tokeburn ingest URL")
  .action(async (opts) => {
    try {
      const code = await runSync(opts);
      process.exitCode = code;
    } catch (err) {
      // Never surface a raw stack trace to the user.
      console.error(pc.red("Unexpected error: ") + (err && err.message ? err.message : String(err)));
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
