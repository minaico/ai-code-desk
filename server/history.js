"use strict";
/**
 * Persistent record of every terminal ever opened on this machine.
 *
 * Lives in the PTY host because that is what owns sessions, so the history
 * survives a web-server restart and follows the machine it belongs to (a
 * remote machine reports its own history).
 *
 * Only metadata is stored - shell, title, working directory, timings. No
 * terminal output and no typed input ever reach this file.
 */
const fs = require("fs");
const path = require("path");

const MAX_ENTRIES = 500;
const WRITE_DEBOUNCE_MS = 800;

class History {
  constructor(dataDir, log) {
    this.file = path.join(dataDir, "session-history.json");
    this.log = log;
    this.entries = [];
    this.byId = new Map();
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(raw)) {
        this.entries = raw.filter((e) => e && typeof e.id === "string");
      }
    } catch {
      this.entries = [];
    }

    const byIdRaw = new Map(this.entries.map((e) => [e.id, e]));

    /**
     * The id of the first terminal in a reopen chain. Reopening produces a new
     * session, so without this every reopen would leave another identical row
     * behind and the list would slowly stop being a list of terminals.
     */
    const lineageOf = (entry) => {
      const seen = new Set();
      let cur = entry;
      while (cur && cur.reopenedFrom && !seen.has(cur.id)) {
        seen.add(cur.id);
        const parent = byIdRaw.get(cur.reopenedFrom);
        if (!parent) return cur.reopenedFrom; // ancestor already aged out
        cur = parent;
      }
      return cur ? cur.id : entry.id;
    };

    const kept = [];
    const seenLineage = new Set();
    let dirty = false;
    for (const e of this.entries) {
      if (!e.lineage) {
        e.lineage = lineageOf(e);
        dirty = true;
      }
      // Nothing this file calls "running" can still be running: the process
      // that owned those terminals is the one that just started. A host that is
      // killed - or a machine that reboots - never gets to write "closed", so
      // believing the file here is how every row ends up with a green dot.
      if (e.status === "running") {
        e.status = "closed";
        e.closedAt = e.closedAt || e.lastSeenAt || new Date().toISOString();
        dirty = true;
      }
      // Entries are newest first, so the first one seen for a lineage is the
      // one worth keeping.
      if (seenLineage.has(e.lineage)) continue;
      seenLineage.add(e.lineage);
      kept.push(e);
    }

    const collapsed = this.entries.length - kept.length;
    this.entries = kept;
    this.byId = new Map(kept.map((e) => [e.id, e]));
    if (collapsed && this.log && this.log.info) this.log.info("history_collapsed", { removed: collapsed });
    if (dirty || collapsed) this.save();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /**
   * Write now.
   *
   * The debounce exists for touch(), which fires on every `cd`. Everything else
   * here happens once per terminal and matters more than it costs: a session
   * created eight hundred milliseconds before the power goes out is a session
   * that was never written down, and a tab that cannot be restored is exactly
   * what the history is for.
   */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      if (this.log && this.log.warn) this.log.warn("history_save_failed", { error: err });
    }
  }

  /**
   * Called when a session is created.
   *
   * A terminal reopened from this list is a new session, but it is not a new
   * terminal: it is the same shell, in the same folder, under the same name.
   * It takes over the row it came from instead of adding one beside it.
   */
  record(session) {
    const parent = session.reopenedFrom ? this.byId.get(session.reopenedFrom) : null;
    const lineage = parent ? parent.lineage || parent.id : session.reopenedFrom || session.id;

    const fields = {
      id: session.id,
      lineage,
      title: session.title,
      color: session.color || "",
      autoTitle: session.autoTitle !== false,
      shell: session.shell,
      cwd: session.cwd,
      autoRun: session.autoRun || "",
      createdAt: session.createdAt,
      lastSeenAt: new Date().toISOString(),
      closedAt: null,
      exitCode: null,
      reopenedFrom: session.reopenedFrom || null,
      owner: session.owner || "",
      // Which agent has been run here, remembered across reopens: the row is
      // the folder's history, and "Claude has worked in this one" outlives the
      // session that did it.
      agent: session.agent || (this.byId.get(session.id) || {}).agent || "",
      status: "running",
    };

    const existing = this.entries.find((e) => e.lineage === lineage);
    if (existing) {
      // Re-key: touch() and close() find the row by the live session's id.
      this.byId.delete(existing.id);
      Object.assign(existing, fields);
      this.byId.set(existing.id, existing);
      this.entries = [existing, ...this.entries.filter((e) => e !== existing)];
      this.flush();
      return existing;
    }

    const entry = { ...fields };
    this.byId.set(entry.id, entry);
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      for (const dropped of this.entries.splice(MAX_ENTRIES)) this.byId.delete(dropped.id);
    }
    this.flush();
    return entry;
  }

  /** Keep the last known title / working directory up to date. */
  /** Note that an agent ran in this terminal; it stays noted. */
  setAgent(sessionId, kind) {
    const entry = this.byId.get(sessionId);
    if (!entry || !kind || entry.agent === kind) return;
    entry.agent = kind;
    this.save();
  }

  touch(session) {
    const entry = this.byId.get(session.id);
    if (!entry) return;
    entry.title = session.title;
    entry.color = session.color || "";
    entry.autoTitle = session.autoTitle !== false;
    entry.cwd = session.cwd; // the directory it was in when it closed
    entry.lastSeenAt = new Date().toISOString();
    if (session.status) entry.status = session.status;
    this.save();
  }

  close(session, exitCode) {
    const entry = this.byId.get(session.id);
    if (!entry) return;
    entry.cwd = session.cwd;
    entry.closedAt = new Date().toISOString();
    entry.exitCode = exitCode === undefined ? entry.exitCode : exitCode;
    entry.status = "closed";
    entry.lastSeenAt = entry.closedAt;
    this.flush();
  }

  get(id) {
    return this.byId.get(String(id || "")) || null;
  }

  list(limit = 200) {
    const n = Math.max(1, Math.min(MAX_ENTRIES, Number(limit) || 200));
    return this.entries.slice(0, n);
  }

  remove(id) {
    const entry = this.byId.get(String(id || ""));
    if (!entry) return false;
    this.byId.delete(entry.id);
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.save();
    return true;
  }

  clear() {
    this.entries = [];
    this.byId.clear();
    this.save();
  }
}

module.exports = { History };
