"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT_DIR = path.join(__dirname, "..");
const DATA_DIR = process.env.WEB_TERMINAL_DATA || path.join(ROOT_DIR, ".data");

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function parseRoots(raw) {
  const fallback = process.env.USERPROFILE || os.homedir() || process.cwd();
  // path.delimiter, so the variable reads the way every other PATH-shaped
  // variable does on the platform it is set on: ";" on Windows, ":" on POSIX.
  const list = String(raw || fallback)
    .split(path.delimiter)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => path.resolve(x));
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const key = r.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(r)) out.push(r);
  }
  return out.length ? out : [path.resolve(fallback)];
}

/**
 * Fallback password. A weak default is a poor secret, but it is strictly safer
 * than the alternative it replaces: with no password at all, anyone who can
 * reach the port gets a shell. The UI and the startup log both say loudly that
 * this is the default and should be changed.
 * Set WEB_TERMINAL_PASSWORD="" explicitly to run with no authentication.
 */
const DEFAULT_PASSWORD = "123123";
const passwordFromEnv =
  process.env.WEB_TERMINAL_PASSWORD === undefined ? DEFAULT_PASSWORD : process.env.WEB_TERMINAL_PASSWORD;

const config = {
  rootDir: ROOT_DIR,
  dataDir: DATA_DIR,
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || "0.0.0.0",
  ptyHostPort: num(process.env.PTY_HOST_PORT, 8777),
  // 127.0.0.1 by default. Set to 0.0.0.0 to let other machines on the LAN
  // drive this PTY host (they still need the shared key from .data/host.key).
  ptyHostBind: process.env.PTY_HOST_BIND || "127.0.0.1",
  /**
   * Encrypt the PTY channel with TLS-PSK keyed by .data/host.key (server/tlspsk.js).
   * On by default. PTY_HOST_TLS=0 serves the old plaintext protocol, which is
   * only for talking to a machine still running an older version of this code —
   * it puts every keystroke back on the wire in the clear.
   */
  ptyTls: process.env.PTY_HOST_TLS !== "0",
  password: passwordFromEnv,
  passwordHash: process.env.WEB_TERMINAL_PASSWORD_HASH || "",
  roots: parseRoots(process.env.WEB_TERMINAL_ROOTS),
  tokenTtlMs: num(process.env.WEB_TERMINAL_TOKEN_HOURS, 168) * 3600 * 1000,
  maxUploadBytes: num(process.env.WEB_TERMINAL_MAX_UPLOAD_MB, 200) * 1024 * 1024,
  scrollbackBytes: num(process.env.WEB_TERMINAL_SCROLLBACK_KB, 512) * 1024,
  /**
   * How many terminals may run at once on this machine. 0 = no limit, and
   * that is the default: the cap existed to catch a runaway script, but the
   * one time it fired was on a person opening their 25th project, and a
   * limit that only ever stops the owner is not protecting anyone.
   */
  maxSessions: Math.max(0, Math.floor(Number(process.env.WEB_TERMINAL_MAX_SESSIONS) || 0)),
  /** How long an exited session stays listed so the UI can offer Restart. */
  exitedKeepMs: num(process.env.WEB_TERMINAL_EXITED_KEEP_MIN, 30) * 60 * 1000,
  /** Days of Strict-Transport-Security to promise. 0 = send no HSTS header. */
  hstsSeconds: num(process.env.WEB_TERMINAL_HSTS_DAYS, 0) * 86400,
  tlsCert: process.env.WEB_TERMINAL_TLS_CERT || "",
  tlsKey: process.env.WEB_TERMINAL_TLS_KEY || "",
  claudeBin: process.env.CLAUDE_BIN || "claude",
  /**
   * Local VieNeu-TTS server (apps/web_stream.py listens on 8001). Set
   * WEB_TERMINAL_TTS=0 to read out on the browser's own voices only.
   */
  ttsUrl: process.env.VIENEU_TTS_URL || "http://127.0.0.1:8001",
  ttsEnabled: process.env.WEB_TERMINAL_TTS !== "0",
  ttsTimeoutMs: num(process.env.WEB_TERMINAL_TTS_TIMEOUT_MS, 120000),
  /** VieNeu caps streaming at 3000 chars; stay under it. */
  ttsMaxChars: num(process.env.WEB_TERMINAL_TTS_MAX_CHARS, 2000),
  trustProxy: process.env.WEB_TERMINAL_TRUST_PROXY !== "0",
};

config.authRequired = !!(config.password || config.passwordHash);
config.usingDefaultPassword = !config.passwordHash && config.password === DEFAULT_PASSWORD;
config.defaultCwd = config.roots[0];

/**
 * Directories a terminal may not be started in. A shell can `cd` anywhere once
 * it is running, so this is about intent and accidents rather than containment
 * — the real filesystem boundary is WEB_TERMINAL_ROOTS, which still governs the
 * file manager (browse, download, upload, delete).
 */
const DEFAULT_BLOCKED_DIRS =
  process.platform === "win32"
    ? [
        process.env.SystemRoot || "C:\\Windows",
        "C:\\$Recycle.Bin",
        "C:\\System Volume Information",
        "C:\\Recovery",
        "C:\\Boot",
        "C:\\PerfLogs",
        "C:\\Config.Msi",
        "C:\\Documents and Settings",
      ]
    : // Kernel and device trees. /etc and the rest stay open: a shell can cd
      // anywhere once it is running, so this is about accidents, not
      // containment - the real filesystem boundary is WEB_TERMINAL_ROOTS.
      ["/proc", "/sys", "/dev", "/run", "/boot"];

config.blockedDirs = [
  ...DEFAULT_BLOCKED_DIRS,
  ...String(process.env.WEB_TERMINAL_BLOCKED_DIRS || "")
    .split(path.delimiter)
    .map((x) => x.trim())
    .filter(Boolean),
].map((x) => path.resolve(x));

function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  return config.dataDir;
}

/**
 * Shared secret proving that a TCP client on 127.0.0.1 is our own web server.
 * Localhost binding already blocks remote access; this blocks other local users.
 */
function hostKey() {
  ensureDataDir();
  const file = path.join(config.dataDir, "host.key");
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v.length >= 32) return v;
  } catch {}
  const v = require("crypto").randomBytes(32).toString("hex");
  fs.writeFileSync(file, v, { mode: 0o600 });
  return v;
}

module.exports = { config, ensureDataDir, hostKey };
