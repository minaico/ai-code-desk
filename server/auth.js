"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { config, ensureDataDir } = require("./config");

/* ------------------------------------------------------------------ *
 * Secret key. Persisted so that restarting the web server does not
 * log every phone/browser out.
 * ------------------------------------------------------------------ */
function loadSecret() {
  ensureDataDir();
  const file = path.join(config.dataDir, "secret.key");
  try {
    const buf = fs.readFileSync(file);
    if (buf.length >= 32) return buf;
  } catch {}
  const secret = crypto.randomBytes(48);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SECRET = loadSecret();

/* ------------------------------------------------------------------ *
 * Password hashing (scrypt). WEB_TERMINAL_PASSWORD_HASH is preferred
 * over the plaintext WEB_TERMINAL_PASSWORD.
 * ------------------------------------------------------------------ */
function hashPassword(plain, salt = crypto.randomBytes(16)) {
  const derived = crypto.scryptSync(String(plain), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(plain) {
  if (!config.authRequired) return true;
  if (config.passwordHash) {
    const parts = String(config.passwordHash).split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    let salt, expect;
    try {
      salt = Buffer.from(parts[1], "hex");
      expect = Buffer.from(parts[2], "hex");
    } catch {
      return false;
    }
    const got = crypto.scryptSync(String(plain), salt, expect.length, { N: 16384, r: 8, p: 1 });
    return got.length === expect.length && crypto.timingSafeEqual(got, expect);
  }
  const a = crypto.createHash("sha256").update(String(plain)).digest();
  const b = crypto.createHash("sha256").update(config.password).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * Stateless HMAC tokens: base64url(payload).base64url(hmac)
 * ------------------------------------------------------------------ */
const revoked = new Set();

/**
 * @param {{sub?:string, role?:string, mustChange?:boolean}} who
 *   The account this token speaks for. Omitted in shared-password mode, where
 *   there is nobody to name.
 */
function issueToken(who = {}) {
  const payload = {
    jti: crypto.randomBytes(9).toString("base64url"),
    iat: Date.now(),
    exp: Date.now() + config.tokenTtlMs,
    sub: who.sub || "",
    role: who.role === "admin" ? "admin" : "user",
    // Carried in the token so a half-finished first login cannot be walked
    // around by simply not asking the server about it again.
    mc: !!who.mustChange,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return { token: `${body}.${sig}`, expiresAt: payload.exp };
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
  if (revoked.has(payload.jti)) return null;
  return payload;
}

function revokeToken(token) {
  const p = verifyToken(token);
  if (p) revoked.add(p.jti);
}

/* ------------------------------------------------------------------ *
 * Login brute-force throttle, per client IP.
 * ------------------------------------------------------------------ */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return String(cf).trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function throttleState(ip) {
  const rec = attempts.get(ip);
  if (!rec) return { blocked: false, retryAfter: 0 };
  if (Date.now() > rec.until) {
    attempts.delete(ip);
    return { blocked: false, retryAfter: 0 };
  }
  if (rec.fails >= MAX_FAILS) {
    return { blocked: true, retryAfter: Math.ceil((rec.until - Date.now()) / 1000) };
  }
  return { blocked: false, retryAfter: 0 };
}

function recordFail(ip) {
  const rec = attempts.get(ip) || { fails: 0, until: 0 };
  rec.fails += 1;
  // Back off harder the more failures we see.
  rec.until = Date.now() + Math.min(WINDOW_MS, 5000 * 2 ** Math.min(rec.fails, 8));
  attempts.set(ip, rec);
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

/* ------------------------------------------------------------------ *
 * Extraction helpers
 * ------------------------------------------------------------------ */
function readCookie(header, name) {
  if (!header) return "";
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

function tokenFromRequest(req, url) {
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (bearer) return bearer;
  const cookie = readCookie(req.headers.cookie, "wt_token");
  if (cookie) return cookie;
  if (url && url.searchParams) return url.searchParams.get("token") || "";
  return "";
}

/**
 * Whether this install has named accounts. Set once by the web server, which
 * owns the user store; auth.js only needs the answer, not the store.
 */
let accountsEnabled = () => false;
function useAccounts(fn) {
  accountsEnabled = typeof fn === "function" ? fn : () => false;
}

/** The account a request speaks for, or null. */
function identify(req) {
  const url = new URL(req.originalUrl || req.url, "http://localhost");
  const payload = verifyToken(tokenFromRequest(req, url));
  if (!payload) return null;
  // Tokens handed out before accounts existed name nobody. They stay
  // cryptographically valid for as long as their TTL, so turning accounts on
  // would otherwise leave every browser that was logged in under the old shared
  // password still logged in — as no one, past every ownership check that has
  // a name to compare against.
  if (accountsEnabled() && !payload.sub) return null;
  return {
    name: payload.sub || "",
    role: payload.role === "admin" ? "admin" : "user",
    mustChange: !!payload.mc,
  };
}

/**
 * Express middleware. Sets req.user when a token names one.
 *
 * A user who has not yet chosen their own password is authenticated but not
 * yet allowed to do anything except change it — otherwise "must change on first
 * login" is only a dialog, and a dialog is not a rule.
 */
function requireAuth(req, res, next) {
  if (!config.authRequired) return next();
  const user = identify(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  if (user.mustChange) {
    return res.status(403).json({ error: "Bạn phải đổi mật khẩu trước khi dùng tiếp", mustChange: true });
  }
  next();
}

/** Like requireAuth but allowed while the password still has to be changed. */
function requireLogin(req, res, next) {
  if (!config.authRequired) return next();
  const user = identify(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  // An install with no accounts has exactly one user, and they already hold the
  // shared password - which is a shell on this machine. Refusing them the admin
  // routes protects nobody, and it is what left the first account with no way to
  // be created except from the command line.
  if (!accountsEnabled()) return next();
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Chỉ quản trị viên làm được việc này" });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  revokeToken,
  identify,
  useAccounts,
  requireAuth,
  requireLogin,
  requireAdmin,
  tokenFromRequest,
  readCookie,
  clientIp,
  throttleState,
  recordFail,
  recordSuccess,
};
