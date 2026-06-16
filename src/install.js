"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const {
  configDir,
  readConfigFile,
  saveConfig,
  resolveToken,
} = require("./config");
const { runSync } = require("./sync");

// launchd job identity and scheduling defaults.
const LAUNCH_AGENT_LABEL = "app.tokeburn.sync";
const DEFAULT_INTERVAL_SECONDS = 300; // 5 minutes

/**
 * Absolute paths used by the installer, all derived from a single home dir so
 * tests can point everything at a temp directory.
 */
function installPaths(homedir) {
  const tokeburnDir = configDir(homedir);
  const launchAgentsDir = path.join(homedir, "Library", "LaunchAgents");
  return {
    tokeburnDir,
    launchAgentsDir,
    logPath: path.join(tokeburnDir, "sync.log"),
    plistPath: path.join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`),
  };
}

/**
 * Resolve the real, absolute path to the tokeburn CLI entry file. launchd runs
 * with a minimal environment and no PATH lookup for our bin shim, so the plist
 * must point at the actual file. realpath collapses symlinks (e.g. an npm
 * global bin link) down to the installed file.
 */
function defaultCliPath() {
  const entry = path.join(__dirname, "..", "bin", "tokeburn.js");
  try {
    return fs.realpathSync(entry);
  } catch (err) {
    return path.resolve(entry);
  }
}

/** Run a launchctl subcommand. Throws (execFileSync) on a non-zero exit. */
function defaultLaunchctl(args) {
  execFileSync("launchctl", args, { stdio: "ignore" });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the launchd LaunchAgent plist XML.
 *
 * @param {object}   o
 * @param {string}   o.label
 * @param {string[]} o.programArguments  Absolute argv, e.g. [node, cli, "sync"].
 * @param {number}   o.intervalSeconds   StartInterval.
 * @param {string}   o.logPath           stdout + stderr destination.
 * @param {boolean}  [o.runAtLoad=true]
 */
function buildPlist({ label, programArguments, intervalSeconds, logPath, runAtLoad = true }) {
  const args = programArguments
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${Math.round(intervalSeconds)}</integer>
  <key>RunAtLoad</key>
  <${runAtLoad ? "true" : "false"}/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

/** A positive finite number from CLI input, else the fallback. */
function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Human-friendly interval for the success message ("5 minutes", "90 seconds"). */
function formatEvery(seconds) {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

function unsupportedMessage() {
  return (
    "Background auto-sync isn't supported on this platform yet — it's macOS-only for now.\n" +
    "In the meantime you can keep your data fresh by running: tokeburn watch"
  );
}

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * `tokeburn install`
 *
 * Persists the API token (so unattended launchd runs can authenticate), runs an
 * initial sync, then installs a launchd LaunchAgent that re-runs `tokeburn sync`
 * on a fixed interval. Background install failures are non-fatal: the initial
 * sync still counts, so onboarding is never blocked.
 *
 * Dependencies are injectable for testing: homedir, platform, execPath,
 * cliPath, launchctl, runSync, fs, log, error.
 *
 * @returns {Promise<number>} process exit code (always 0 on macOS).
 */
async function runInstall(opts = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  const log = deps.log || console.log;
  const error = deps.error || console.error;

  if (platform !== "darwin") {
    log(unsupportedMessage());
    return 0;
  }

  const env = deps.env || process.env;
  const homedir = deps.homedir || os.homedir();
  const execPath = deps.execPath || process.execPath;
  const cliPath = deps.cliPath || defaultCliPath();
  const launchctl = deps.launchctl || defaultLaunchctl;
  const doSync = deps.runSync || runSync;
  const fsmod = deps.fs || fs;

  const intervalSeconds = Math.round(
    positiveNumber(opts.minutes, DEFAULT_INTERVAL_SECONDS / 60) * 60
  );

  const paths = installPaths(homedir);
  fsmod.mkdirSync(paths.tokeburnDir, { recursive: true });

  // Persist the token (and an explicitly-overridden URL) so the scheduled job,
  // which runs under launchd's minimal environment, authenticates exactly like
  // `sync`: --token > TOKEBURN_TOKEN > config file.
  const token = resolveToken(opts, env, readConfigFile(homedir));
  if (token) {
    const updates = { token };
    if (typeof opts.url === "string" && opts.url.trim()) {
      updates.apiUrl = opts.url.trim();
    }
    saveConfig(updates, homedir);
  }

  // 1. Initial sync — reuse the existing sync logic (no duplication).
  await doSync(opts, env);

  // 2. Install the launchd agent. This must never block onboarding: any failure
  // here is reported in plain language with the `watch` fallback, and we still
  // exit successfully because the initial sync already happened.
  try {
    fsmod.mkdirSync(paths.launchAgentsDir, { recursive: true });

    const plist = buildPlist({
      label: LAUNCH_AGENT_LABEL,
      programArguments: [execPath, cliPath, "sync"],
      intervalSeconds,
      logPath: paths.logPath,
    });

    // Idempotency: if a job is already installed, unload it before rewriting so
    // we never end up with two scheduled jobs.
    if (fsmod.existsSync(paths.plistPath)) {
      try {
        launchctl(["unload", paths.plistPath]);
      } catch (err) {
        // An already-unloaded job is fine; keep going.
      }
    }

    fsmod.writeFileSync(paths.plistPath, plist);
    launchctl(["load", paths.plistPath]);

    log(`Connected. Tokeburn will keep itself updated every ${formatEvery(intervalSeconds)}.`);
  } catch (err) {
    error("Your usage was synced, but background auto-sync could not be set up: " + errMessage(err));
    error("You can keep your data fresh by running: tokeburn watch");
  }

  return 0;
}

/**
 * `tokeburn uninstall`
 *
 * Unloads the launchd job and removes the plist. Safe to run when nothing is
 * installed — it never errors.
 *
 * @returns {number} process exit code (always 0 on macOS).
 */
function runUninstall(opts = {}, deps = {}) {
  const platform = deps.platform || process.platform;
  const log = deps.log || console.log;

  if (platform !== "darwin") {
    log(unsupportedMessage());
    return 0;
  }

  const homedir = deps.homedir || os.homedir();
  const launchctl = deps.launchctl || defaultLaunchctl;
  const fsmod = deps.fs || fs;
  const paths = installPaths(homedir);

  if (!fsmod.existsSync(paths.plistPath)) {
    log("Background auto-sync is not installed — nothing to remove.");
    return 0;
  }

  try {
    launchctl(["unload", paths.plistPath]);
  } catch (err) {
    // Job may already be unloaded; removing the plist is what matters.
  }
  try {
    fsmod.rmSync(paths.plistPath, { force: true });
  } catch (err) {
    // Best effort; nothing actionable if removal fails.
  }

  log("Background auto-sync removed. Tokeburn will no longer update on its own.");
  return 0;
}

module.exports = {
  runInstall,
  runUninstall,
  // Exported for testing / reuse.
  LAUNCH_AGENT_LABEL,
  DEFAULT_INTERVAL_SECONDS,
  installPaths,
  buildPlist,
  formatEvery,
  unsupportedMessage,
};
