"use strict";
/**
 * User accounts.
 *
 * Lives in the web server, not the PTY host: the PTY host owns terminals and
 * knows nothing about who is asking. Ownership of a session is recorded on the
 * session, but deciding *who* someone is happens here, once, at login.
 *
 *   .data/users.json    [{ name, hash, role, mustChange, createdAt, lastLoginAt }]
 *
 * Only the scrypt hash is stored; the file is written 0600 and never leaves the
 * machine. An install with no such file keeps the older single shared password,
 * so upgrading does not lock anyone out - see config.authRequired. The moment
 * one account exists the shared password stops being accepted, because two ways
 * in is one more than anybody can keep track of.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIN_PASSWORD = 8;

/** A bad request is the caller's fault, not the server's: say 400, not 500. */
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/i;

function hashPassword(plain, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(String(plain), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function checkPassword(plain, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let salt;
  let expect;
  try {
    salt = Buffer.from(parts[1], "hex");
    expect = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  const got = crypto.scryptSync(String(plain), salt, expect.length, { N: 16384, r: 8, p: 1 });
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

class Users {
  constructor(dataDir, log) {
    this.file = path.join(dataDir, "users.json");
    this.log = log;
    this.users = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(raw)) {
        this.users = raw.filter((u) => u && typeof u.name === "string" && typeof u.hash === "string");
      }
    } catch {
      this.users = [];
    }
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.users, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** True once accounts exist, which is what switches the server out of shared-password mode. */
  get enabled() {
    return this.users.length > 0;
  }

  get count() {
    return this.users.length;
  }

  find(name) {
    const wanted = String(name || "").toLowerCase();
    return this.users.find((u) => u.name.toLowerCase() === wanted) || null;
  }

  /** What the UI is allowed to see. Never the hash. */
  publicOf(u) {
    if (!u) return null;
    return {
      name: u.name,
      role: u.role === "admin" ? "admin" : "user",
      mustChange: !!u.mustChange,
      createdAt: u.createdAt || null,
      lastLoginAt: u.lastLoginAt || null,
    };
  }

  list() {
    return this.users.map((u) => this.publicOf(u));
  }

  isAdmin(name) {
    const u = this.find(name);
    return !!u && u.role === "admin";
  }

  create({ name, password, role = "user", mustChange = true }) {
    const clean = String(name || "").trim();
    if (!NAME_RE.test(clean)) {
      throw bad("Tên đăng nhập chỉ gồm chữ, số, dấu chấm, gạch ngang, gạch dưới (3-32 ký tự)");
    }
    if (this.find(clean)) throw bad(`Người dùng "${clean}" đã tồn tại`);
    if (String(password || "").length < MIN_PASSWORD) {
      throw bad(`Mật khẩu phải có ít nhất ${MIN_PASSWORD} ký tự`);
    }
    const u = {
      name: clean,
      hash: hashPassword(password),
      role: role === "admin" ? "admin" : "user",
      mustChange: !!mustChange,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };
    this.users.push(u);
    this.save();
    return this.publicOf(u);
  }

  /**
   * @returns {{ok:true, user:object}|{ok:false}} — deliberately says nothing
   * about *which* half was wrong.
   */
  verify(name, password) {
    const u = this.find(name);
    if (!u) {
      // Spend the same time as a real check so the response cannot be used to
      // enumerate which names exist.
      hashPassword(String(password || ""));
      return { ok: false };
    }
    if (!checkPassword(password, u.hash)) return { ok: false };
    return { ok: true, user: u };
  }

  recordLogin(name) {
    const u = this.find(name);
    if (!u) return;
    u.lastLoginAt = new Date().toISOString();
    this.save();
  }

  setPassword(name, password, { mustChange = false } = {}) {
    const u = this.find(name);
    if (!u) throw bad("Không có người dùng này");
    if (String(password || "").length < MIN_PASSWORD) {
      throw bad(`Mật khẩu phải có ít nhất ${MIN_PASSWORD} ký tự`);
    }
    u.hash = hashPassword(password);
    u.mustChange = !!mustChange;
    this.save();
    return this.publicOf(u);
  }

  setRole(name, role) {
    const u = this.find(name);
    if (!u) throw bad("Không có người dùng này");
    const next = role === "admin" ? "admin" : "user";
    // An install with no admin left cannot create one: there would be nobody
    // allowed to do it. Refuse rather than produce that state.
    if (u.role === "admin" && next !== "admin" && this.users.filter((x) => x.role === "admin").length <= 1) {
      throw bad("Đây là quản trị viên cuối cùng");
    }
    u.role = next;
    this.save();
    return this.publicOf(u);
  }

  remove(name) {
    const u = this.find(name);
    if (!u) throw bad("Không có người dùng này");
    if (u.role === "admin" && this.users.filter((x) => x.role === "admin").length <= 1) {
      throw bad("Không thể xoá quản trị viên cuối cùng");
    }
    this.users = this.users.filter((x) => x !== u);
    this.save();
    return u.name;
  }
}

module.exports = { Users, hashPassword, checkPassword, MIN_PASSWORD };
