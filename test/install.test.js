"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  runInstall,
  runUninstall,
  LAUNCH_AGENT_LABEL,
  DEFAULT_INTERVAL_SECONDS,
  installPaths,
  buildPlist,
  formatEvery,
} = require("../src/install");

// --- helpers ---------------------------------------------------------------

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tokeburn-home-"));
}

function makeLaunchctl() {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
  };
  fn.calls = calls;
  return fn;
}

function silent() {
  const lines = [];
  const fn = (...args) => lines.push(args.join(" "));
  fn.lines = lines;
  return fn;
}

const EXEC = "/abs/node/bin/node";
const CLI = "/abs/lib/tokeburn/bin/tokeburn.js";

// A runSync stub that records it was called and does no network.
function makeSync() {
  const fn = async (opts, env) => {
    fn.called += 1;
    fn.lastOpts = opts;
    fn.lastEnv = env;
    return 0;
  };
  fn.called = 0;
  return fn;
}

function baseDeps(homedir, overrides = {}) {
  return Object.assign(
    {
      platform: "darwin",
      homedir,
      execPath: EXEC,
      cliPath: CLI,
      launchctl: makeLaunchctl(),
      runSync: makeSync(),
      env: {},
      log: silent(),
      error: silent(),
    },
    overrides
  );
}

// --- buildPlist ------------------------------------------------------------

test("buildPlist contains label, absolute node + CLI paths, interval, RunAtLoad, log", () => {
  const xml = buildPlist({
    label: LAUNCH_AGENT_LABEL,
    programArguments: [EXEC, CLI, "sync"],
    intervalSeconds: 300,
    logPath: "/home/me/.tokeburn/sync.log",
  });

  assert.match(xml, /<key>Label<\/key>\s*<string>app\.tokeburn\.sync<\/string>/);
  // Absolute node + CLI paths, in order, followed by the "sync" subcommand.
  assert.match(
    xml,
    /<array>\s*<string>\/abs\/node\/bin\/node<\/string>\s*<string>\/abs\/lib\/tokeburn\/bin\/tokeburn\.js<\/string>\s*<string>sync<\/string>\s*<\/array>/
  );
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/home\/me\/\.tokeburn\/sync\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/home\/me\/\.tokeburn\/sync\.log<\/string>/);
});

test("formatEvery renders minutes and seconds", () => {
  assert.equal(formatEvery(300), "5 minutes");
  assert.equal(formatEvery(60), "1 minute");
  assert.equal(formatEvery(90), "90 seconds");
  assert.equal(formatEvery(1), "1 second");
});

// --- install: plist + paths ------------------------------------------------

test("install writes a plist with absolute node and CLI paths", async () => {
  const home = tempHome();
  const deps = baseDeps(home, { token: "tok_123" });

  const code = await runInstall({ token: "tok_123" }, deps);
  assert.equal(code, 0);

  const paths = installPaths(home);
  const xml = fs.readFileSync(paths.plistPath, "utf8");
  assert.ok(xml.includes(`<string>${EXEC}</string>`), "uses absolute node path");
  assert.ok(xml.includes(`<string>${CLI}</string>`), "uses absolute CLI path");
  assert.ok(xml.includes("<string>sync</string>"));
  assert.ok(xml.includes(paths.logPath), "logs under ~/.tokeburn");

  // Ran the initial sync and loaded the job.
  assert.equal(deps.runSync.called, 1);
  assert.deepEqual(deps.launchctl.calls, [["load", paths.plistPath]]);
});

test("install persists the token to config.json for unattended runs", async () => {
  const home = tempHome();
  const deps = baseDeps(home, { token: "tok_secret" });

  await runInstall({ token: "tok_secret" }, deps);

  const cfg = JSON.parse(fs.readFileSync(path.join(home, ".tokeburn", "config.json"), "utf8"));
  assert.equal(cfg.token, "tok_secret");
});

test("install writes config.json owner-readable only (mode 0600)", async () => {
  const home = tempHome();
  const deps = baseDeps(home, { token: "tok_secret" });

  await runInstall({ token: "tok_secret" }, deps);

  const stat = fs.statSync(path.join(home, ".tokeburn", "config.json"));
  assert.equal(stat.mode & 0o777, 0o600);
});

// --- install: interval default + --minutes override ------------------------

test("install uses the 300s default interval", async () => {
  const home = tempHome();
  const deps = baseDeps(home, { token: "t" });
  await runInstall({ token: "t" }, deps);
  const xml = fs.readFileSync(installPaths(home).plistPath, "utf8");
  assert.match(xml, new RegExp(`<integer>${DEFAULT_INTERVAL_SECONDS}</integer>`));
});

test("install --minutes overrides the interval (minutes -> seconds)", async () => {
  const home = tempHome();
  const deps = baseDeps(home, { token: "t" });
  await runInstall({ token: "t", minutes: "10" }, deps);
  const xml = fs.readFileSync(installPaths(home).plistPath, "utf8");
  assert.match(xml, /<integer>600<\/integer>/);
  assert.ok(deps.log.lines.some((l) => l.includes("every 10 minutes")));
});

// --- install: idempotency --------------------------------------------------

test("install is idempotent: unloads an existing job before rewriting", async () => {
  const home = tempHome();
  const paths = installPaths(home);
  // Simulate a previously installed job.
  fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
  fs.writeFileSync(paths.plistPath, "<old/>");

  const deps = baseDeps(home, { token: "t" });
  await runInstall({ token: "t" }, deps);

  assert.deepEqual(deps.launchctl.calls, [
    ["unload", paths.plistPath],
    ["load", paths.plistPath],
  ]);
  // The plist was rewritten (no longer the placeholder).
  assert.notEqual(fs.readFileSync(paths.plistPath, "utf8"), "<old/>");
});

// --- install: non-fatal launchd failure ------------------------------------

test("install is non-fatal when the launchd step fails", async () => {
  const home = tempHome();
  const throwing = (args) => {
    throw new Error("launchctl exploded");
  };
  const deps = baseDeps(home, { token: "t", launchctl: throwing });

  const code = await runInstall({ token: "t" }, deps);

  assert.equal(code, 0, "still exits successfully");
  assert.equal(deps.runSync.called, 1, "initial sync still ran");
  const errText = deps.error.lines.join("\n");
  assert.ok(errText.includes("launchctl exploded"));
  assert.ok(errText.includes("tokeburn watch"), "offers the watch fallback");
});

// --- install/uninstall: non-macOS guard ------------------------------------

test("install on non-macOS prints a friendly message and does nothing", async () => {
  const home = tempHome();
  const deps = baseDeps(home, { platform: "linux" });

  const code = await runInstall({}, deps);

  assert.equal(code, 0);
  assert.equal(deps.runSync.called, 0, "no sync attempted");
  assert.deepEqual(deps.launchctl.calls, []);
  assert.ok(!fs.existsSync(installPaths(home).plistPath));
  const out = deps.log.lines.join("\n");
  assert.ok(out.includes("tokeburn watch"));
  assert.ok(/not supported|isn't supported|only/i.test(out));
});

test("uninstall on non-macOS prints a friendly message and does nothing", async () => {
  const home = tempHome();
  const deps = baseDeps(home, { platform: "win32" });

  const code = await runUninstall({}, deps);

  assert.equal(code, 0);
  assert.deepEqual(deps.launchctl.calls, []);
  assert.ok(deps.log.lines.join("\n").includes("tokeburn watch"));
});

// --- uninstall: removal + safe-when-missing --------------------------------

test("uninstall unloads the job and removes the plist", async () => {
  const home = tempHome();
  const paths = installPaths(home);
  fs.mkdirSync(paths.launchAgentsDir, { recursive: true });
  fs.writeFileSync(paths.plistPath, "<plist/>");

  const deps = baseDeps(home);
  const code = await runUninstall({}, deps);

  assert.equal(code, 0);
  assert.deepEqual(deps.launchctl.calls, [["unload", paths.plistPath]]);
  assert.ok(!fs.existsSync(paths.plistPath), "plist removed");
});

test("uninstall is safe when nothing is installed", async () => {
  const home = tempHome();
  const deps = baseDeps(home);

  const code = await runUninstall({}, deps);

  assert.equal(code, 0);
  assert.deepEqual(deps.launchctl.calls, [], "no launchctl calls when missing");
  assert.ok(deps.log.lines.join("\n").toLowerCase().includes("not installed"));
});
