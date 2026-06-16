"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_API_URL = "https://tokeburn.app/api/public/ingest";

/**
 * Read and parse ~/.tokeburn/config.json if it exists.
 * Returns an object (possibly empty); never throws on missing/malformed files.
 */
function readConfigFile() {
  const configPath = path.join(os.homedir(), ".tokeburn", "config.json");
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
  readConfigFile,
  resolveToken,
  resolveApiUrl,
};
