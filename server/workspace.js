"use strict";
/**
 * The set of tabs a person had open, per account.
 *
 * Terminals do not survive a reboot - ConPTY has no checkpoint, so a machine
 * that loses power loses every shell on it. What can survive is the *shape* of
 * the work: which terminals were open, on which machines, in what order, which
 * one was in front. Paired with the session history, that is enough to put the
 * same tabs back, in the same order, in the same folders.
 *
 *   .data/workspaces.json   { "<user>": { tabs: [...], activeIndex, savedAt } }
 *
 * A tab is stored as a *lineage* - the stable id of a terminal across every
 * reopen - and not as a session id, because the session id is the one thing
 * guaranteed to be different after the restart this file exists for. The
 * current entry id rides along as a hint for the common case where nothing
 * has changed.
 */
const fs = require("fs");
const path = require("path");

const MAX_TABS = 40;
const WRITE_DEBOUNCE_MS = 400;

const str = (v, n) => String(v === undefined || v === null ? "" : v).slice(0, n);

/**
 * @param {object} t
 * @param {string} localHostId what "local", or no host at all, stands for. The
 *   alias is never written: this file is carried between machines, and "local"
 *   would then mean the wrong one.
 */
function cleanTab(t, localHostId = "local") {
  if (!t || typeof t !== "object") return null;
  const lineage = str(t.lineage, 40);
  const entryId = str(t.entryId, 40);
  if (!lineage && !entryId) return null;
  const hostId = str(t.hostId, 40);
  return {
    lineage: lineage || entryId,
    entryId,
    hostId: !hostId || hostId === "local" ? localHostId : hostId,
    title: str(t.title, 80),
    color: str(t.color, 16),
    shell: str(t.shell, 40),
    cwd: str(t.cwd, 400),
  };
}

class Workspaces {
  constructor(dataDir, log, { localHostId = "local" } = {}) {
    this.file = path.join(dataDir, "workspaces.json");
    this.log = log;
    this.localHostId = localHostId;
    this.data = {};
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) this.data = raw;
    } catch {
      this.data = {};
    }
    this.rehostLocal();
  }

  /** Give tabs saved as "local" the id of the machine they were saved on. */
  rehostLocal() {
    if (this.localHostId === "local") return;
    let changed = 0;
    for (const w of Object.values(this.data)) {
      for (const t of (w && Array.isArray(w.tabs) ? w.tabs : [])) {
        if (t && (!t.hostId || t.hostId === "local")) {
          t.hostId = this.localHostId;
          changed++;
        }
      }
    }
    if (changed) {
      if (this.log && this.log.info) this.log.info("workspace_rehosted", { tabs: changed, hostId: this.localHostId });
      this.flush();
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Write now. Shutdown and tests both need the file to exist on the next line. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      if (this.log && this.log.warn) this.log.warn("workspace_save_failed", { error: err });
    }
  }

  /** Accounts share one file; an install with no accounts has one workspace. */
  key(user) {
    const name = (user && user.name) || "";
    return name.toLowerCase() || "__shared__";
  }

  get(user) {
    const w = this.data[this.key(user)];
    if (!w) return { tabs: [], activeIndex: -1, savedAt: null };
    return {
      tabs: Array.isArray(w.tabs) ? w.tabs : [],
      activeIndex: Number.isInteger(w.activeIndex) ? w.activeIndex : -1,
      savedAt: w.savedAt || null,
    };
  }

  set(user, { tabs, activeIndex } = {}) {
    const clean = (Array.isArray(tabs) ? tabs : [])
      .map((t) => cleanTab(t, this.localHostId))
      .filter(Boolean)
      .slice(0, MAX_TABS);
    const workspace = {
      tabs: clean,
      activeIndex: Number.isInteger(activeIndex) && activeIndex < clean.length ? activeIndex : -1,
      savedAt: new Date().toISOString(),
    };
    this.data[this.key(user)] = workspace;
    this.save();
    return workspace;
  }

  clear(user) {
    delete this.data[this.key(user)];
    this.save();
  }
}

module.exports = { Workspaces, MAX_TABS };
