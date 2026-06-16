"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_API_URL = "https://tokeburn.app/api/public/ingest";

/**
 * Absolute path to the Tokeburn config directory (~/.tokeburn by default).
 * `homedir` is injectable so the installed/unattended flow and tests can
 * target a specific home directory.
 */
function configDir(homedir = os.homedir()) {
  return path.join(homedir, ".tokeburn");
}

/**
 * Absolute path to the config file (~/.tokeburn/config.json by default).
 */
function configFilePath(homedir = os.homedir()) {
  return path.join(configDir(homedir), "config.json");
}

/**
 * Read and parse ~/.tokeburn/config.json if it exists.
 * Returns an object (possibly empty); never throws on missing/malformed files.
 */
function readConfigFile(homedir = os.homedir()) {
  const configPath = configFilePath(homedir);
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    // Missing or unreadable/malformed config is not fatal.
    return {};
  }
}

/**
 * Persist values into ~/.tokeburn/config.json, merging with whatever is already
 * there. Used by `tokeburn install` to store the API token so an unattended
 * launchd run can authenticate the same way `sync` does — launchd jobs run with
 * a minimal environment, so an env-only token would be invisible to them.
 * Returns the merged config object.
 */
function saveConfig(updates = {}, homedir = os.homedir()) {
  const dir = configDir(homedir);
  // Owner-only directory (0700) so the stored token isn't world/group readable.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readConfigFile(homedir);
  const merged = { ...existing, ...updates };
  fs.writeFileSync(
    configFilePath(homedir),
    JSON.stringify(merged, null, 2) + "\n",
    { mode: 0o600 }
  );
  return merged;
}

/**
 * Resolve the API token.
 * Order: --token flag, TOKEBURN_TOKEN env, config file `token`.
 * Returns a non-empty string or null.
 */
function resolveToken(opts = {}, env = process.env, config = readConfigFile()) {
  const candidates = [opts.token, env.TOKEBURN_TOKEN, config.token];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

/**
 * Resolve the ingest URL.
 * Order: --url flag, TOKEBURN_API_URL env, config file `apiUrl`, then default.
 */
function resolveApiUrl(opts = {}, env = process.env, config = readConfigFile()) {
  const candidates = [opts.url, env.TOKEBURN_API_URL, config.apiUrl];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return DEFAULT_API_URL;
}

module.exports = {
  DEFAULT_API_URL,
  configDir,
  configFilePath,
  readConfigFile,
  saveConfig,
  resolveToken,
  resolveApiUrl,
};
