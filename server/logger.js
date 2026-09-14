"use strict";
/**
 * Structured JSON-lines logger shared by the web server and the PTY host.
 * One file per UTC day under <dataDir>/logs. Never logs passwords or PTY input.
 */
const fs = require("fs");
const path = require("path");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[String(process.env.WEB_TERMINAL_LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Keys whose values must never reach the log. */
const SECRET_KEYS = /^(password|pass|token|secret|authorization|cookie|data|input)$/i;

function scrub(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value instanceof Error) return { message: value.message, code: value.code };
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return value.length > 500 ? value.slice(0, 500) + "…" : value;
  return value;
}

function createLogger(component, dataDir) {
  const dir = path.join(dataDir, "logs");
  let stream = null;
  let streamDay = "";

  function file() {
    const day = new Date().toISOString().slice(0, 10);
    if (stream && streamDay === day) return stream;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${component}-${day}.log`);
      try {
        if (fs.statSync(target).size > MAX_FILE_BYTES) {
          fs.renameSync(target, `${target}.1`);
        }
      } catch {}
      if (stream) stream.end();
      stream = fs.createWriteStream(target, { flags: "a" });
      stream.on("error", () => { stream = null; });
      streamDay = day;
    } catch {
      stream = null;
    }
    return stream;
  }

  function write(level, event, fields) {
    if (LEVELS[level] < MIN) return;
    const rec = { ts: new Date().toISOString(), level, component, event, ...scrub(fields || {}) };
    let line;
    try {
      line = JSON.stringify(rec);
    } catch {
      line = JSON.stringify({ ts: rec.ts, level, component, event, note: "unserialisable fields" });
    }
    if (level === "error" || level === "warn") console.error(line);
    else if (process.env.WEB_TERMINAL_LOG_CONSOLE !== "0") console.log(line);
    const s = file();
    if (s) s.write(line + "\n");
  }

  return {
    dir,
    debug: (e, f) => write("debug", e, f),
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
    /** Recent log lines, newest last. Used by /api/system diagnostics. */
    tail(limit = 200) {
      try {
        const day = new Date().toISOString().slice(0, 10);
        const target = path.join(dir, `${component}-${day}.log`);
        const text = fs.readFileSync(target, "utf8");
        return text.split(/\r?\n/).filter(Boolean).slice(-limit);
      } catch {
        return [];
      }
    },
  };
}

module.exports = { createLogger };
