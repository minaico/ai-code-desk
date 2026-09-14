"use strict";
/**
 * Directory picker for "new terminal here".
 *
 * Deliberately wider than server/files.js: a terminal may be started in any
 * folder on the machine except the Windows system directories, because a shell
 * can `cd` anywhere the moment it exists — restricting only its starting
 * directory would buy no safety while making the app annoying to use.
 *
 * This module lists directory *names* only. It never reads file contents,
 * never writes, and never deletes. Everything that actually touches file data
 * still goes through files.js and stays inside WEB_TERMINAL_ROOTS.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { config } = require("./config");

class DirError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const norm = (p) => p.replace(/[\\/]+$/, "").toLowerCase();

function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** True when `abs` is, or sits inside, a blocked system directory. */
function isBlocked(abs) {
  const target = norm(abs);
  return config.blockedDirs.some((blocked) => {
    const b = norm(blocked);
    return target === b || target.startsWith(b + path.sep.toLowerCase());
  });
}

/**
 * The top of the filesystem, as the platform sees it: the ready drives on
 * Windows, and the single root on POSIX - which has no drives to enumerate and
 * would otherwise offer an empty list where a starting point belongs.
 */
function listDrives() {
  if (process.platform !== "win32") return ["/"];
  const out = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      fs.accessSync(root, fs.constants.R_OK);
      out.push(root);
    } catch {}
  }
  return out;
}

/**
 * Validate a directory a terminal is allowed to start in.
 * @param {string} input path from the client, "" means the default
 */
function resolveStartDir(input) {
  const raw = String(input || "").trim();
  if (!raw) return config.defaultCwd;
  if (/[\u0000-\u001f]/.test(raw)) throw new DirError("Invalid path");

  let abs = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new DirError("Folder not found");
  }
  if (!st.isDirectory()) throw new DirError("Not a folder");

  abs = realOrSelf(abs);
  if (isBlocked(abs)) throw new DirError("That is a Windows system folder");
  return abs;
}

/** Sub-directories of `input`, or the drive list when `input` is empty. */
function list(input) {
  const raw = String(input || "").trim();

  if (!raw) {
    const drives = listDrives();
    return {
      path: "",
      parent: null,
      isDriveList: true,
      drives,
      shortcuts: shortcuts(),
      items: drives.map((d) => ({ name: d, path: d })),
    };
  }

  const dir = resolveStartDir(raw);
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new DirError(err.code === "EPERM" || err.code === "EACCES" ? "Access denied" : "Cannot read folder");
  }

  const items = [];
  for (const entry of names) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    if (isBlocked(full)) continue;
    if (entry.name.startsWith("$")) continue;
    items.push({ name: entry.name, path: full });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));

  const parentPath = path.dirname(dir);
  const parent = parentPath === dir ? "" : parentPath; // "" = back to the drive list

  return {
    path: dir,
    parent,
    isDriveList: false,
    drives: listDrives(),
    shortcuts: shortcuts(),
    items,
  };
}

/** Handy starting points offered above the folder list. */
function shortcuts() {
  const candidates = [
    ...config.roots,
    process.env.USERPROFILE || os.homedir(),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Desktop"),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "Documents"),
  ];
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c) continue;
    const abs = path.resolve(c);
    const key = norm(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.statSync(abs).isDirectory() && !isBlocked(abs)) out.push({ name: path.basename(abs) || abs, path: abs });
    } catch {}
  }
  return out;
}

module.exports = { list, resolveStartDir, isBlocked, listDrives, DirError };
