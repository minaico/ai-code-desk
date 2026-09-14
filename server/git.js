"use strict";
/**
 * Read-only Git helpers.
 *
 * execFile with an argument array and shell:false — user input never reaches a
 * command line. Only the working directory comes from the client and it is
 * validated against the allowed roots first. Nothing here writes to a repo.
 */
const { execFile } = require("child_process");
const { safePath } = require("./files");

function run(cwd, args, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((String(stderr || "").trim() || err.message).slice(0, 500));
        e.status = 400;
        return reject(e);
      }
      resolve(String(stdout || ""));
    });
  });
}

const lines = (out) => out.replace(/\r/g, "").split("\n").filter(Boolean);

async function status(cwdInput) {
  const cwd = safePath(cwdInput);
  const out = await run(cwd, ["status", "--porcelain=v1", "-b", "--untracked-files=all"]);
  const all = lines(out);
  const head = all.shift() || "";
  const branch = (head.match(/^##\s+(.+?)(?:\.\.\.|\s|$)/) || [])[1] || "";
  const ahead = Number((head.match(/ahead (\d+)/) || [])[1] || 0);
  const behind = Number((head.match(/behind (\d+)/) || [])[1] || 0);
  const files = all.map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  const untracked = files.filter((f) => f.code === "??").length;
  return {
    cwd,
    branch,
    ahead,
    behind,
    modified: files.length - untracked,
    untracked,
    files: files.slice(0, 500),
  };
}

async function branches(cwdInput) {
  const cwd = safePath(cwdInput);
  const out = await run(cwd, ["branch", "--all", "--format=%(refname:short)%09%(HEAD)"]);
  return {
    cwd,
    branches: lines(out).map((l) => {
      const [name, head] = l.split("\t");
      return { name, current: head === "*" };
    }),
  };
}

async function log(cwdInput, limit = 30) {
  const cwd = safePath(cwdInput);
  const n = Math.max(1, Math.min(200, Number(limit) || 30));
  // %x1f makes git itself emit the unit separator, so no control character
  // has to be embedded in this source file.
  const sep = String.fromCharCode(31);
  const out = await run(cwd, ["log", `-${n}`, "--pretty=format:%h%x1f%an%x1f%ar%x1f%s"]);
  return {
    cwd,
    commits: lines(out).map((l) => {
      const [hash, author, when, subject] = l.split(sep);
      return { hash, author, when, subject };
    }),
  };
}
module.exports = { status, branches, log };
