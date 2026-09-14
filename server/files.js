"use strict";
/**
 * Filesystem access, constrained to WEB_TERMINAL_ROOTS.
 *
 * Every path from the browser goes through safePath(): it is resolved, symlinks
 * are followed, and the result must still sit inside an allowed root. That
 * closes ../ traversal, absolute-path escapes, junction/symlink escapes and
 * short-name (8.3) tricks.
 */
const fs = require("fs");
const path = require("path");
const { config } = require("./config");

class PathError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const lower = (p) => p.replace(/[\\/]+$/, "").toLowerCase();

function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function insideRoot(abs) {
  const target = lower(abs);
  return config.roots.some((r) => {
    const root = lower(realOrSelf(r));
    return target === root || target.startsWith(root + path.sep.toLowerCase());
  });
}

/**
 * @param {string} input path from the client ("" = first allowed root)
 * @param {{mustExist?: boolean, forCreate?: boolean}} opts
 */
function safePath(input, opts = {}) {
  const raw = String(input || "").trim();
  if (!raw) return config.roots[0];
  if (/[\u0000-\u001f]/.test(raw)) throw new PathError("Invalid path");

  let abs = path.resolve(raw);
  // A UNC path can never be inside a local root; reject early and clearly.
  if (/^\\\\/.test(abs) && !insideRoot(abs)) throw new PathError("Path is outside allowed roots");

  const exists = fs.existsSync(abs);
  if (exists) {
    abs = realOrSelf(abs);
  } else if (opts.forCreate) {
    const parent = realOrSelf(path.dirname(abs));
    abs = path.join(parent, path.basename(abs));
  } else if (opts.mustExist !== false) {
    throw new PathError("Path not found");
  }

  if (!insideRoot(abs)) throw new PathError("Path is outside allowed roots");
  return abs;
}

/** A filename supplied by the browser, stripped of any directory component. */
function safeName(input) {
  const base = path.basename(String(input || "").replace(/[\\/]+/g, "/"));
  const clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^\.+$/, "_").trim();
  if (!clean) throw new PathError("Invalid file name");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean)) throw new PathError("Reserved file name");
  return clean.slice(0, 200);
}

function isRootItself(abs) {
  return config.roots.some((r) => lower(realOrSelf(r)) === lower(abs));
}

function entry(dir, name) {
  const p = path.join(dir, name);
  let st = null;
  try {
    st = fs.statSync(p);
  } catch {
    try {
      st = fs.lstatSync(p);
    } catch {}
  }
  return {
    name,
    path: p,
    isDir: st ? st.isDirectory() : false,
    size: st && st.isFile() ? st.size : 0,
    mtime: st ? st.mtime.toISOString() : null,
  };
}

function list(input) {
  const dir = safePath(input);
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new PathError("Not a directory");
  const names = fs.readdirSync(dir);
  const items = names
    .map((n) => entry(dir, n))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent !== dir && insideRoot(parent) ? parent : null,
    isRoot: isRootItself(dir),
    roots: config.roots,
    items,
  };
}

function mkdir(parentInput, nameInput) {
  const parent = safePath(parentInput);
  const target = safePath(path.join(parent, safeName(nameInput)), { forCreate: true });
  if (fs.existsSync(target)) throw new PathError("Already exists");
  fs.mkdirSync(target);
  return entry(path.dirname(target), path.basename(target));
}

function remove(input) {
  const target = safePath(input);
  if (isRootItself(target)) throw new PathError("Refusing to delete an allowed root");
  const st = fs.statSync(target);
  if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: false });
  else fs.unlinkSync(target);
  return { path: target };
}

function rename(input, nameInput) {
  const target = safePath(input);
  if (isRootItself(target)) throw new PathError("Refusing to rename an allowed root");
  const next = safePath(path.join(path.dirname(target), safeName(nameInput)), { forCreate: true });
  if (fs.existsSync(next)) throw new PathError("Target already exists");
  fs.renameSync(target, next);
  return entry(path.dirname(next), path.basename(next));
}

/** Destination for an upload; refuses to escape the chosen directory. */
function uploadTarget(dirInput, nameInput) {
  const dir = safePath(dirInput);
  if (!fs.statSync(dir).isDirectory()) throw new PathError("Upload target is not a directory");
  return safePath(path.join(dir, safeName(nameInput)), { forCreate: true });
}

module.exports = { safePath, safeName, list, mkdir, remove, rename, uploadTarget, PathError, insideRoot };
