"use strict";
/**
 * Web Terminal — HTTP + WebSocket front end.
 *
 * It owns no PTY. Every terminal lives in the separate PTY host process, so
 * restarting this server never kills a shell or a running Claude Code session.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const { WebSocketServer } = require("ws");

const { config, ensureDataDir } = require("./config");
const { createLogger } = require("./logger");
const auth = require("./auth");
const files = require("./files");
const dirs = require("./dirs");
const git = require("./git");
const profiles = require("./profiles");
const { HostRegistry } = require("./hosts");
const { Users } = require("./users");
const { Workspaces } = require("./workspace");
const tts = require("./tts");
const replay = require("./replay");

ensureDataDir();
const log = createLogger("web", config.dataDir);
const startedAt = Date.now();

const hosts = new HostRegistry().start();
const users = new Users(config.dataDir, log);
// Tabs saved before every machine had an id say "local", which is only true on
// the machine that wrote them - and this is that machine, since the file has
// not been anywhere else in that form.
const workspaces = new Workspaces(config.dataDir, log, { localHostId: hosts.local.id });
// Once accounts exist, a token that names nobody is not a way in.
auth.useAccounts(() => users.enabled);

/**
 * A terminal belongs to the account that opened it.
 *
 * Sessions created before accounts existed have no owner. They are shown to
 * admins only: "nobody owns it" is not the same as "everybody owns it", and a
 * shell is not a thing to hand out on a technicality.
 */
function canUse(user, session) {
  if (!users.enabled) return true; // shared-password install: one shell, one owner
  if (!user || !user.name) return false;
  if (user.role === "admin") return true;
  const owner = String((session && session.owner) || "");
  return owner.toLowerCase() === user.name.toLowerCase();
}

const visibleTo = (user, sessions) => sessions.filter((s) => canUse(user, s));

/** Route wrapper: a rejected promise becomes the error middleware's problem. */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** The machine that owns a session, or the one asked for by hostId. */
const hostFor = (sessionId) => hosts.hostFor(sessionId);
const hostById = (hostId) => hosts.client(hostId);
const app = express();
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", true);

/* ------------------------------------------------------------------ *
 * Baseline hardening
 * ------------------------------------------------------------------ */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});

const isSecure = (req) =>
  req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";

function setSessionCookie(req, res, token, maxAgeMs) {
  const parts = [
    `wt_token=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isSecure(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(req, res) {
  const parts = ["wt_token=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecure(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/**
 * State-changing requests must carry a custom header. A cross-site form or
 * image cannot set one, so cookie-authenticated CSRF is blocked while plain
 * GET downloads keep working from a normal browser navigation.
 */
function csrfGuard(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const bearer = /^Bearer\s+/i.test(String(req.headers.authorization || ""));
  if (bearer || req.headers["x-wt-client"]) return next();
  res.status(403).json({ error: "Missing X-WT-Client header" });
}

app.use(express.json({ limit: "1mb" }));
app.use(csrfGuard);

const requireAuth = auth.requireAuth;

/* ------------------------------------------------------------------ *
 * Static assets
 * ------------------------------------------------------------------ */
const dist = path.join(config.rootDir, "dist");
const pub = path.join(config.rootDir, "public");
const staticDir = fs.existsSync(path.join(dist, "index.html")) ? dist : pub;
app.use(
  express.static(staticDir, {
    index: "index.html",
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
      else res.setHeader("Cache-Control", "public, max-age=86400");
    },
  })
);

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
app.post("/api/login", (req, res) => {
  const ip = auth.clientIp(req);
  if (!config.authRequired) return res.json({ ok: true, authRequired: false, token: "" });

  const state = auth.throttleState(ip);
  if (state.blocked) {
    log.warn("login_throttled", { ip, retryAfter: state.retryAfter });
    return res.status(429).json({ error: `Too many attempts. Retry in ${state.retryAfter}s` });
  }
  const password = req.body && req.body.password;
  const username = String((req.body && req.body.username) || "").trim();

  let who = {};
  if (users.enabled) {
    // Accounts exist, so the shared password is no longer a way in.
    const r = typeof password === "string" ? users.verify(username, password) : { ok: false };
    if (!r.ok) {
      auth.recordFail(ip);
      log.warn("login_failed", { ip, username });
      return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu" });
    }
    users.recordLogin(r.user.name);
    who = { sub: r.user.name, role: r.user.role, mustChange: !!r.user.mustChange };
  } else if (typeof password !== "string" || !auth.verifyPassword(password)) {
    auth.recordFail(ip);
    log.warn("login_failed", { ip });
    return res.status(401).json({ error: "Invalid password" });
  }

  auth.recordSuccess(ip);
  const { token, expiresAt } = auth.issueToken(who);
  setSessionCookie(req, res, token, config.tokenTtlMs);
  log.info("login_ok", { ip, username: who.sub || "" });
  res.json({
    ok: true,
    authRequired: true,
    token,
    expiresAt,
    user: who.sub ? { name: who.sub, role: who.role, mustChange: !!who.mustChange } : null,
  });
});

/**
 * Change your own password. Reachable while mustChange is still set — it is the
 * one thing a first-time login is allowed to do, and the only way to clear it.
 */
app.post(
  "/api/password",
  auth.requireLogin,
  asyncRoute(async (req, res) => {
    if (!users.enabled) throw Object.assign(new Error("Cài đặt này chưa dùng tài khoản"), { status: 400 });
    const me = req.user && req.user.name;
    if (!me) throw Object.assign(new Error("Phiên đăng nhập không gắn với tài khoản nào"), { status: 400 });
    const current = String((req.body && req.body.current) || "");
    const next = String((req.body && req.body.next) || "");
    if (!users.verify(me, current).ok) {
      log.warn("password_change_rejected", { username: me });
      throw Object.assign(new Error("Mật khẩu hiện tại không đúng"), { status: 401 });
    }
    if (next === current) throw Object.assign(new Error("Mật khẩu mới phải khác mật khẩu cũ"), { status: 400 });
    users.setPassword(me, next, { mustChange: false });
    // The old token still carries mustChange, so hand out a fresh one rather
    // than leaving the browser to argue with a stale claim.
    const u = users.find(me);
    const { token, expiresAt } = auth.issueToken({ sub: u.name, role: u.role, mustChange: false });
    setSessionCookie(req, res, token, config.tokenTtlMs);
    log.info("password_changed", { username: me });
    res.json({ ok: true, token, expiresAt, user: users.publicOf(u) });
  })
);

/* ------------------------------------------------------------------ *
 * User management (admin only)
 * ------------------------------------------------------------------ */
app.get("/api/users", requireAuth, auth.requireAdmin, (_req, res) => {
  res.json({ users: users.list() });
});

app.post(
  "/api/users",
  requireAuth,
  auth.requireAdmin,
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const created = users.create({
      name: b.name,
      password: b.password,
      role: b.role,
      // A password someone else chose is a password to be replaced on arrival.
      mustChange: b.mustChange === undefined ? true : !!b.mustChange,
    });
    log.info("user_create", { username: created.name, role: created.role });
    res.status(201).json({ user: created });
  })
);

app.post(
  "/api/users/:name/password",
  requireAuth,
  auth.requireAdmin,
  asyncRoute(async (req, res) => {
    const u = users.setPassword(req.params.name, (req.body || {}).password, { mustChange: true });
    log.info("user_password_reset", { username: u.name });
    res.json({ user: u });
  })
);

app.post(
  "/api/users/:name/role",
  requireAuth,
  auth.requireAdmin,
  asyncRoute(async (req, res) => {
    res.json({ user: users.setRole(req.params.name, (req.body || {}).role) });
  })
);

app.delete(
  "/api/users/:name",
  requireAuth,
  auth.requireAdmin,
  asyncRoute(async (req, res) => {
    if (req.user && req.user.name.toLowerCase() === String(req.params.name).toLowerCase()) {
      throw Object.assign(new Error("Không thể tự xoá chính mình"), { status: 400 });
    }
    const name = users.remove(req.params.name);
    log.info("user_remove", { username: name });
    res.json({ ok: true });
  })
);

app.post("/api/logout", (req, res) => {
  const token = auth.tokenFromRequest(req, new URL(req.originalUrl, "http://localhost"));
  if (token) auth.revokeToken(token);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  const me = auth.identify(req);
  const authed = !config.authRequired || !!me;
  res.json({
    authRequired: config.authRequired,
    authenticated: authed,
    accounts: users.enabled,
    user: me && me.name ? { name: me.name, role: me.role, mustChange: me.mustChange } : null,
    // With accounts in use, each person's own password is the thing that matters.
    usingDefaultPassword: users.enabled ? false : config.usingDefaultPassword,
    roots: authed ? config.roots : [],
    maxUploadBytes: config.maxUploadBytes,
    maxSessions: config.maxSessions,
    version: require("../package.json").version,
    ttsRemote: config.ttsEnabled,
  });
});

/**
 * Which shells exist, per machine.
 *
 * This used to answer for the machine running the web server and let the
 * browser offer that list for every machine — so a Windows browser offered
 * PowerShell and Command Prompt for a Linux host, and the only thing that said
 * otherwise was the error after you pressed Create. Each machine is asked about
 * itself now; one that is not answering contributes an empty list and says so.
 */
app.get(
  "/api/profiles",
  requireAuth,
  asyncRoute(async (req, res) => {
    const local = {
      shells: profiles.availableProfiles().map((p) => ({ id: p.id, label: p.label, icon: p.icon })),
      launchers: profiles.launchers(),
    };
    const byHost = await Promise.all(
      [...hosts.clients.values()].map(async (client) => {
        if (client.local) {
          return { hostId: client.id, hostName: client.name, connected: true, platform: process.platform, ...local };
        }
        if (!client.connected) {
          return { hostId: client.id, hostName: client.name, connected: false, shells: [], launchers: [] };
        }
        try {
          const r = await client.request({ type: "profiles" });
          return {
            hostId: client.id,
            hostName: client.name,
            connected: true,
            platform: r.platform || "",
            shells: r.shells || [],
            launchers: r.launchers || [],
          };
        } catch (err) {
          // Connected but unable to answer - an older PTY host that predates
          // this question. Saying "not connected" there would be a second wrong
          // answer on top of the first.
          log.warn("profiles_fetch_failed", { hostId: client.id, message: err.message });
          return {
            hostId: client.id,
            hostName: client.name,
            connected: client.connected,
            error: err.message,
            shells: [],
            launchers: [],
          };
        }
      })
    );
    // The top-level fields stay the local machine's: the sidebar launchers open
    // terminals here, and that is what they have always meant.
    res.json({ ...local, byHost });
  })
);

/* ------------------------------------------------------------------ *
 * Read out loud — proxied to a local VieNeu-TTS (bilingual vi/en)
 * ------------------------------------------------------------------ */
app.get("/api/tts/voices", requireAuth, async (_req, res) => {
  if (!config.ttsEnabled) return res.json({ enabled: false, voices: [] });
  try {
    res.json({ enabled: true, voices: await tts.listVoices() });
  } catch (err) {
    // Not running is the normal case on a machine without the model, so this
    // is a plain empty answer and not an error the UI has to apologise for.
    log.info("tts_unavailable", { error: err.message });
    res.json({ enabled: true, voices: [], unavailable: err.message });
  }
});

app.post("/api/tts", requireAuth, async (req, res) => {
  if (!config.ttsEnabled) return res.status(404).json({ error: "TTS disabled" });
  const text = req.body && typeof req.body.text === "string" ? req.body.text : "";
  const voiceId = req.body && typeof req.body.voiceId === "string" ? req.body.voiceId : "";
  if (!text.trim()) return res.status(400).json({ error: "text required" });
  try {
    const wav = await tts.synth(text, voiceId);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(wav.length));
    res.setHeader("Cache-Control", "no-store");
    res.end(wav);
  } catch (err) {
    log.warn("tts_failed", { error: err.message });
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Sessions — the server is the source of truth
 * ------------------------------------------------------------------ */
app.get(
  "/api/sessions",
  requireAuth,
  asyncRoute(async (req, res) => {
    // Authoritative: ask every reachable machine rather than trusting the
    // event-driven cache, which does not see silent changes such as a resize.
    const sessions = await hosts.refresh();
    res.json({ sessions: visibleTo(req.user, sessions), hosts: hosts.list() });
  })
);

/**
 * Guard for every route that names a session: it must exist, and it must be
 * yours. Without this the id is the only thing standing between one account
 * and another account's shell.
 */
const ownSession = asyncRoute(async (req, _res, next) => {
  const id = String(req.params.id || "");
  let s = hosts.allSessions().find((x) => x.id === id);
  if (!s) {
    await hosts.refresh();
    s = hosts.allSessions().find((x) => x.id === id);
  }
  if (!s) throw httpError(404, "Session not found");
  if (!canUse(req.user, s)) {
    log.warn("session_forbidden", { sessionId: id, username: (req.user && req.user.name) || "" });
    throw httpError(403, "Terminal này thuộc về người dùng khác");
  }
  req.session = s;
  next();
});

app.post(
  "/api/sessions",
  requireAuth,
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    // A terminal may start in any folder except the Windows system ones: the
    // shell can cd anywhere once running, so locking the start directory to
    // WEB_TERMINAL_ROOTS would only get in the way. The file manager stays
    // inside the roots.
    const client = hostById(b.hostId);
    // Only the local machine's folders can be validated here; a remote host
    // applies the same rule itself before it spawns anything.
    const cwd = b.cwd ? (client.local ? dirs.resolveStartDir(b.cwd) : String(b.cwd)) : "";
    const r = await client.request({
      type: "create",
      shell: b.shell,
      cwd,
      title: b.title,
      cols: b.cols,
      rows: b.rows,
      autoRun: b.autoRun,
      color: b.color,
      owner: (req.user && req.user.name) || "",
    });
    log.info("api_session_create", {
      sessionId: r.session && r.session.id,
      shell: b.shell,
      hostId: client.id,
      owner: (req.user && req.user.name) || "",
    });
    res.status(201).json({ session: { ...r.session, hostId: client.id, hostName: client.name } });
  })
);

app.post(
  "/api/sessions/:id/attach",
  requireAuth,
  ownSession,
  asyncRoute(async (req, res) => {
    const r = await hostFor(req.params.id).request({
      type: "attach",
      sessionId: req.params.id,
      cols: req.body?.cols,
      rows: req.body?.rows,
      claim: req.body?.claim,
    });
    res.json({ session: r.session, history: r.data || "" });
  })
);

// Everything the session ever drew, not just what the screen still holds.
// A terminal is a window: when a program reprints a block taller than the
// screen, the earlier copy has already scrolled past and cannot be overwritten,
// so what survives is the tail several times over and the opening not at all.
// The recording is complete, so the answer is rebuilt from that instead.
app.get(
  "/api/sessions/:id/transcript",
  requireAuth,
  ownSession,
  asyncRoute(async (req, res) => {
    const r = await hostFor(req.params.id).request({ type: "buffer", sessionId: req.params.id });
    const lines = await replay.reconstruct(r.data || "", r.replay || {});
    res.json({ lines });
  })
);

app.post(
  "/api/sessions/:id/restart",
  requireAuth,
  ownSession,
  asyncRoute(async (req, res) => {
    const r = await hostFor(req.params.id).request({ type: "restart", sessionId: req.params.id });
    log.info("api_session_restart", { sessionId: req.params.id });
    res.json({ session: r.session });
  })
);

app.post(
  "/api/sessions/:id/kill",
  requireAuth,
  ownSession,
  asyncRoute(async (req, res) => {
    const r = await hostFor(req.params.id).request({ type: "kill", sessionId: req.params.id });
    log.info("api_session_kill", { sessionId: req.params.id });
    res.json({ session: r.session });
  })
);

app.post(
  "/api/sessions/:id/rename",
  requireAuth,
  ownSession,
  asyncRoute(async (req, res) => {
    const r = await hostFor(req.params.id).request({ type: "rename", sessionId: req.params.id, title: req.body?.title });
    res.json({ session: r.session });
  })
);

/** Tab name, colour, and whether the name follows the working directory. */
app.post(
  "/api/sessions/:id/update",
  requireAuth,
  ownSession,
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const r = await hostFor(req.params.id).request({
      type: "update",
      sessionId: req.params.id,
      title: b.title,
      color: b.color,
      autoTitle: b.autoTitle,
    });
    res.json({ session: r.session });
  })
);

app.post(
  "/api/sessions/:id/resize",
  requireAuth,
  ownSession,
  asyncRoute(async (req, res) => {
    hostFor(req.params.id).notify({
      type: "resize",
      sessionId: req.params.id,
      cols: req.body?.cols,
      rows: req.body?.rows,
    });
    res.json({ ok: true });
  })
);

app.delete(
  "/api/sessions/:id",
  requireAuth,
  ownSession,
  asyncRoute(async (req, res) => {
    await hostFor(req.params.id).request({ type: "remove", sessionId: req.params.id });
    log.info("api_session_remove", { sessionId: req.params.id });
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ *
 * Workspace — which tabs were open, so a reboot is not a fresh start
 * ------------------------------------------------------------------ */

/**
 * Every history entry this account may see, across every reachable machine,
 * plus the machines that could not be reached.
 *
 * Both halves matter. A machine that does not answer has not lost anything -
 * we simply cannot see it yet - and the difference between "not answering" and
 * "no longer there" is the difference between waiting and giving up. The
 * connected flag alone is not enough to tell them apart: a host that dies
 * without closing its socket still reads as connected until the next attempt
 * fails, which is exactly the moment someone is asking about their tabs.
 */
async function historyFor(user, { hostId, limit } = {}) {
  const wanted = hostId ? [hostById(hostId)] : [...hosts.clients.values()];
  const entries = [];
  const unreachable = new Set();
  for (const client of wanted) {
    if (!client.connected) {
      unreachable.add(client.id);
      continue;
    }
    try {
      const r = await client.request({ type: "history", limit });
      for (const e of r.entries || []) entries.push({ ...e, hostId: client.id, hostName: client.name });
    } catch (err) {
      unreachable.add(client.id);
      log.warn("history_fetch_failed", { hostId: client.id, message: err.message });
    }
  }
  entries.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  return { entries: visibleTo(user, entries), unreachable };
}

/**
 * Pair each saved tab with what is available for it right now: the session it
 * refers to if that is still running, otherwise the history entry it can be
 * reopened from, otherwise nothing at all.
 */
function resolveTabs(tabs, sessions, entries, unreachable = new Set()) {
  const byLineage = (list) => {
    const m = new Map();
    for (const x of list) {
      const key = String(x.lineage || x.id || "");
      if (key && !m.has(key)) m.set(key, x);
    }
    return m;
  };
  const liveByLineage = byLineage(sessions);
  const entryByLineage = byLineage(entries);

  return tabs.map((t) => {
    const session = liveByLineage.get(t.lineage) || null;
    const entry = entryByLineage.get(t.lineage) || null;
    // A killed session stays in the list for half an hour so the UI can offer
    // Restart. It is listed, but it is not running, and calling it "live" is
    // what left the Restore button with nothing to do.
    const running = !!session && session.status === "running";
    const offline = !session && !entry && unreachable.has(hosts.resolveId(t.hostId));
    return {
      ...t,
      sessionId: session ? session.id : null,
      entryId: entry ? entry.id : t.entryId,
      hostId: session ? session.hostId || t.hostId : t.hostId,
      // From the live session if there is one, else from the history row,
      // which remembers what has run in that folder across reopens.
      agent: (session && session.agent) || (entry && entry.agent) || "",
      state: running ? "live" : session ? "exited" : entry ? "restorable" : offline ? "offline" : "gone",
    };
  });
}

app.get(
  "/api/workspace",
  requireAuth,
  asyncRoute(async (req, res) => {
    const saved = workspaces.get(req.user);
    const sessions = visibleTo(req.user, await hosts.refresh());
    const { entries, unreachable } = await historyFor(req.user);
    res.json({ ...saved, tabs: resolveTabs(saved.tabs, sessions, entries, unreachable) });
  })
);

app.put(
  "/api/workspace",
  requireAuth,
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    res.json(workspaces.set(req.user, { tabs: b.tabs, activeIndex: b.activeIndex }));
  })
);

/**
 * Put the tabs back. A terminal that is still running is reused as it is — the
 * point is to restore the workspace, not to replace the work in it.
 */
app.post(
  "/api/workspace/restore",
  requireAuth,
  asyncRoute(async (req, res) => {
    const saved = workspaces.get(req.user);
    const sessions = visibleTo(req.user, await hosts.refresh());
    const { entries, unreachable } = await historyFor(req.user);
    const plan = resolveTabs(saved.tabs, sessions, entries, unreachable);

    const restored = [];
    const failed = [];
    for (const tab of plan) {
      if (tab.state === "live") {
        restored.push({ ...tab, reused: true });
        continue;
      }
      if (tab.state === "offline") {
        failed.push({ ...tab, reason: "Máy đó chưa kết nối - thử lại khi nó lên" });
        continue;
      }
      if (tab.state === "gone") {
        failed.push({ ...tab, reason: "Không còn trong lịch sử của máy đó" });
        continue;
      }
      try {
        const client = hostById(tab.hostId);
        // A session that exited but is still listed can be restarted where it
        // is: same id, same tab, same folder. Reopening it from history would
        // work too, and would needlessly turn one terminal into two rows.
        const r =
          tab.state === "exited"
            ? await client.request({ type: "restart", sessionId: tab.sessionId })
            : await client.request({
                type: "reopen",
                entryId: tab.entryId,
                owner: (req.user && req.user.name) || "",
              });
        restored.push({
          ...tab,
          reused: false,
          restarted: tab.state === "exited",
          sessionId: r.session.id,
          session: { ...r.session, hostId: client.id, hostName: client.name },
          restoredCwd: r.restoredCwd,
        });
      } catch (err) {
        failed.push({ ...tab, reason: err.message });
      }
    }
    log.info("workspace_restore", {
      username: (req.user && req.user.name) || "",
      restored: restored.length,
      failed: failed.length,
    });
    res.json({ restored, failed });
  })
);

/* ------------------------------------------------------------------ *
 * Machines
 * ------------------------------------------------------------------ */
app.get("/api/hosts", requireAuth, (_req, res) => {
  res.json({ hosts: hosts.list(), localKeyHint: "run scripts\\host-key.js on the other machine" });
});

app.post(
  "/api/hosts/probe",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await hosts.probe({ address: req.body?.address, port: req.body?.port }));
  })
);

app.post(
  "/api/hosts",
  requireAuth,
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const added = hosts.add({ name: b.name, address: b.address, port: b.port, key: b.key });
    res.status(201).json({ host: added });
  })
);

app.post(
  "/api/hosts/:id/rename",
  requireAuth,
  auth.requireAdmin,
  asyncRoute(async (req, res) => {
    res.json({ host: hosts.rename(req.params.id, (req.body || {}).name) });
  })
);

app.delete(
  "/api/hosts/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(hosts.remove(req.params.id));
  })
);

/* ------------------------------------------------------------------ *
 * Session history
 * ------------------------------------------------------------------ */
app.get(
  "/api/history",
  requireAuth,
  asyncRoute(async (req, res) => {
    // "Reopen my terminals" only means anything if the list is mine.
    const { entries } = await historyFor(req.user, { hostId: req.query.hostId, limit: req.query.limit });
    res.json({ entries });
  })
);

app.post(
  "/api/history/:entryId/reopen",
  requireAuth,
  asyncRoute(async (req, res) => {
    const client = hostById(req.body?.hostId);
    const r = await client.request({
      type: "reopen",
      entryId: req.params.entryId,
      cols: req.body?.cols,
      rows: req.body?.rows,
      owner: (req.user && req.user.name) || "",
    });
    log.info("api_history_reopen", { entryId: req.params.entryId, hostId: client.id });
    res.status(201).json({
      session: { ...r.session, hostId: client.id, hostName: client.name },
      restoredCwd: r.restoredCwd,
    });
  })
);

app.delete(
  "/api/history/:entryId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const client = hostById(req.query.hostId);
    res.json(await client.request({ type: "history-remove", entryId: req.params.entryId }));
  })
);

app.delete(
  "/api/history",
  requireAuth,
  asyncRoute(async (req, res) => {
    const client = hostById(req.query.hostId);
    await client.request({ type: "history-clear" });
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */
app.get(
  "/api/files",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(files.list(req.query.path));
  })
);

/**
 * Folder picker for "new terminal here". Wider than /api/files on purpose (see
 * server/dirs.js): it lists folder names anywhere except Windows system
 * directories, and can neither read nor modify file contents.
 */
app.get(
  "/api/dirs",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json(dirs.list(req.query.path));
  })
);

app.post(
  "/api/files/mkdir",
  requireAuth,
  asyncRoute(async (req, res) => {
    const item = files.mkdir(req.body?.path, req.body?.name);
    log.info("file_mkdir", { path: item.path });
    res.json({ item });
  })
);

app.post(
  "/api/files/rename",
  requireAuth,
  asyncRoute(async (req, res) => {
    const item = files.rename(req.body?.path, req.body?.name);
    log.info("file_rename", { path: item.path });
    res.json({ item });
  })
);

app.post(
  "/api/files/delete",
  requireAuth,
  asyncRoute(async (req, res) => {
    const r = files.remove(req.body?.path);
    log.info("file_delete", { path: r.path });
    res.json({ ok: true });
  })
);

app.get("/api/download", requireAuth, (req, res, next) => {
  try {
    const p = files.safePath(req.query.path);
    if (fs.statSync(p).isDirectory()) throw new files.PathError("Cannot download a directory");
    log.info("file_download", { path: p });
    res.download(p);
  } catch (err) {
    next(err);
  }
});

app.post("/api/upload", requireAuth, (req, res, next) => {
  let target;
  try {
    // The browser percent-encodes the name so the header stays latin1-safe.
    const raw = String(req.headers["x-file-name"] || "upload.bin");
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {}
    target = files.uploadTarget(req.query.path, name);
  } catch (err) {
    return next(err);
  }
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > config.maxUploadBytes) {
    return res.status(413).json({ error: "File too large" });
  }

  let written = 0;
  let aborted = false;
  const out = fs.createWriteStream(target);
  const fail = (status, message) => {
    if (aborted) return;
    aborted = true;
    req.unpipe(out);
    out.destroy();
    fs.rm(target, { force: true }, () => {});
    log.warn("file_upload_failed", { path: target, message });
    if (!res.headersSent) res.status(status).json({ error: message });
  };

  req.on("data", (chunk) => {
    written += chunk.length;
    if (written > config.maxUploadBytes) fail(413, "File too large");
  });
  req.on("aborted", () => fail(400, "Upload aborted"));
  out.on("error", (err) => fail(500, err.message));
  out.on("finish", () => {
    if (aborted) return;
    log.info("file_upload", { path: target, bytes: written });
    res.json({ ok: true, path: target, name: path.basename(target), size: written });
  });
  req.pipe(out);
});

/* ------------------------------------------------------------------ *
 * Git (read-only)
 * ------------------------------------------------------------------ */
app.get("/api/git/status", requireAuth, asyncRoute(async (req, res) => res.json(await git.status(req.query.cwd))));
app.get("/api/git/branches", requireAuth, asyncRoute(async (req, res) => res.json(await git.branches(req.query.cwd))));
app.get("/api/git/log", requireAuth, asyncRoute(async (req, res) => res.json(await git.log(req.query.cwd, req.query.limit))));
// Backwards-compatible alias used by earlier builds of the UI.
app.get(
  "/api/git",
  requireAuth,
  asyncRoute(async (req, res) => {
    const s = await git.status(req.query.cwd);
    res.json({ ...s, status: s.files.map((f) => `${f.code} ${f.path}`) });
  })
);

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */
app.get("/health", (_req, res) => {
  const h = hosts.local.status();
  res.json({
    ok: true,
    hostConnected: h.connected,
    machines: hosts.list().length,
    sessions: hosts.allSessions().length,
    uptimeMs: Date.now() - startedAt,
    node: process.version,
    platform: process.platform,
  });
});

app.get(
  "/api/system",
  requireAuth,
  asyncRoute(async (req, res) => {
    let hostStats = null;
    try {
      hostStats = await hosts.local.request({ type: "stats" });
    } catch (err) {
      hostStats = { error: err.message };
    }
    res.json({
      web: {
        pid: process.pid,
        node: process.version,
        uptimeMs: Date.now() - startedAt,
        memory: process.memoryUsage(),
        port: config.port,
        authRequired: config.authRequired,
        roots: config.roots,
        staticDir,
        wsClients: wss ? wss.clients.size : 0,
      },
      ptyHost: { ...hosts.local.status(), stats: hostStats },
      machines: hosts.list(),
      system: {
        hostname: os.hostname(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        uptimeSec: os.uptime(),
      },
      logs: req.query.logs === "1" ? log.tail(120) : undefined,
    });
  })
);

/* ------------------------------------------------------------------ *
 * Errors — always JSON, never a stack trace to the client
 * ------------------------------------------------------------------ */
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, _next) => {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) log.error("request_failed", { url: req.originalUrl, error: err, stack: err && err.stack });
  else log.warn("request_rejected", { url: req.originalUrl, message: err && err.message });
  if (res.headersSent) return;
  res.status(status).json({ error: (err && err.message) || "Server error" });
});

/* ------------------------------------------------------------------ *
 * HTTP(S) server
 * ------------------------------------------------------------------ */
let server;
if (config.tlsCert && config.tlsKey && fs.existsSync(config.tlsCert) && fs.existsSync(config.tlsKey)) {
  server = https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, app);
  log.info("tls_enabled", { cert: config.tlsCert });
} else {
  server = http.createServer(app);
}

/* ------------------------------------------------------------------ *
 * WebSocket terminal multiplexer
 * ------------------------------------------------------------------ */
const wss = new WebSocketServer({ noServer: true });
/** sessionId -> number of browser sockets attached */
const refs = new Map();

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client
  try {
    return new URL(origin).host === String(req.headers.host || "");
  } catch {
    return false;
  }
}

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/terminal") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!sameOrigin(req)) {
    log.warn("ws_bad_origin", { origin: req.headers.origin });
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  let user = null;
  if (config.authRequired) {
    user = auth.identify(req);
    if (!user) {
      log.warn("ws_unauthorized", { ip: auth.clientIp(req) });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    // The REST side refuses everything until the first password is chosen; a
    // socket that streams terminals must refuse it too, or it is the way round.
    if (user.mustChange) {
      log.warn("ws_must_change_password", { username: user.name });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    wss.emit("connection", ws, req);
  });
});

function subscribe(ws, sessionId) {
  if (ws.subs.has(sessionId)) return false;
  ws.subs.add(sessionId);
  refs.set(sessionId, (refs.get(sessionId) || 0) + 1);
  return true;
}
function unsubscribe(ws, sessionId) {
  if (!ws.subs.delete(sessionId)) return;
  const n = (refs.get(sessionId) || 1) - 1;
  if (n <= 0) {
    refs.delete(sessionId);
    try {
      hostFor(sessionId).notify({ type: "detach", sessionId });
    } catch {
      // the session (or its machine) is already gone
    }
  } else {
    refs.set(sessionId, n);
  }
}

function wsSend(ws, msg) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

wss.on("connection", (ws, req) => {
  ws.subs = new Set();
  ws.isAlive = true;
  ws.msgWindow = { start: Date.now(), count: 0 };
  const ip = auth.clientIp(req);
  log.info("ws_connect", { ip });

  wsSend(ws, {
    type: "ready",
    hostConnected: hosts.local.connected,
    sessions: visibleTo(ws.user, hosts.allSessions()),
    hosts: hosts.list(),
    user: ws.user && ws.user.name ? { name: ws.user.name, role: ws.user.role } : null,
  });

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (raw) => {
    // Cheap flood guard: a human cannot generate 2000 messages in 5 seconds.
    const now = Date.now();
    if (now - ws.msgWindow.start > 5000) ws.msgWindow = { start: now, count: 0 };
    if (++ws.msgWindow.count > 2000) {
      log.warn("ws_flood", { ip });
      ws.close(1008, "Too many messages");
      return;
    }
    if (raw.length > 1_000_000) {
      wsSend(ws, { type: "error", message: "Message too large" });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      wsSend(ws, { type: "error", message: "Malformed message" });
      return;
    }
    if (!msg || typeof msg.type !== "string") {
      wsSend(ws, { type: "error", message: "Malformed message" });
      return;
    }

    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";

    try {
      switch (msg.type) {
        case "ping":
          return wsSend(ws, { type: "pong" });

        case "attach": {
          if (!sessionId) throw new Error("sessionId required");
          // Ownership is checked here and nowhere later: everything else on
          // this socket is gated on having attached first.
          const target = hosts.allSessions().find((x) => x.id === sessionId);
          if (!target) throw new Error("Session not found");
          if (!canUse(ws.user, target)) {
            log.warn("ws_session_forbidden", { sessionId, username: (ws.user && ws.user.name) || "" });
            throw new Error("Terminal này thuộc về người dùng khác");
          }
          subscribe(ws, sessionId);
          log.info("ws_attach_size", { sessionId, cols: msg.cols, rows: msg.rows, claim: msg.claim !== false });
          const r = await hostFor(sessionId).request({
            type: "attach",
            sessionId,
            cols: msg.cols,
            rows: msg.rows,
            claim: msg.claim, // forwarded: a background tab must not reshape the PTY
          });
          wsSend(ws, { type: "history", sessionId, data: r.data || "", replay: r.replay, session: r.session });
          return;
        }

        case "detach":
          if (sessionId) unsubscribe(ws, sessionId);
          return;

        case "input": {
          if (!sessionId || !ws.subs.has(sessionId)) throw new Error("Not attached to this session");
          if (typeof msg.data !== "string") throw new Error("data must be a string");
          hostFor(sessionId).notify({ type: "input", sessionId, data: msg.data });
          return;
        }

        case "resize": {
          if (!sessionId || !ws.subs.has(sessionId)) throw new Error("Not attached to this session");
          log.info("ws_resize_size", { sessionId, cols: msg.cols, rows: msg.rows });
          hostFor(sessionId).notify({ type: "resize", sessionId, cols: msg.cols, rows: msg.rows });
          return;
        }

        default:
          throw new Error(`Unsupported message: ${msg.type.slice(0, 30)}`);
      }
    } catch (err) {
      log.warn("ws_message_error", { message: err.message });
      wsSend(ws, { type: "error", sessionId, message: err.message });
    }
  });

  ws.on("close", () => {
    for (const id of [...ws.subs]) unsubscribe(ws, id);
    log.info("ws_disconnect", { ip });
  });
  ws.on("error", (err) => log.warn("ws_error", { error: err }));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30_000);
heartbeat.unref();

/* Fan host events out to the browsers that asked for them. */
hosts.on("event", (msg) => {
  if (!msg.sessionId) return;
  for (const ws of wss.clients) {
    if (ws.subs && ws.subs.has(msg.sessionId)) wsSend(ws, msg);
  }
});
hosts.on("sessions", (sessions) => {
  // One list per browser: each account is told about its own terminals only.
  for (const ws of wss.clients) {
    wsSend(ws, { type: "sessions", sessions: visibleTo(ws.user, sessions), hosts: hosts.list() });
  }
});
hosts.on("hostState", (client, connected) => {
  // Attach ref-counts are keyed by session id only; a machine coming back
  // triggers a re-attach from every browser, which rebuilds them.
  if (!connected) refs.clear();
  for (const ws of wss.clients) {
    wsSend(ws, {
      type: "hostState",
      hostId: client.id,
      hostName: client.name,
      connected,
      hosts: hosts.list(),
      sessions: hosts.allSessions(),
      rehydrate: connected,
    });
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
server.on("error", (err) => {
  log.error("http_listen_error", { error: err });
  process.exit(1);
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    log.info("web_started", {
      port: config.port,
      host: config.host,
      authRequired: config.authRequired,
      roots: config.roots,
      staticDir,
    });
    console.log(`Web Terminal listening on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
    log.info("machines", { count: hosts.list().length });
    if (!config.authRequired) {
      console.log("WARNING: authentication is disabled - anyone who can reach this port gets a shell.");
    } else if (config.usingDefaultPassword) {
      console.log("WARNING: using the built-in default password (123123). Change it before exposing this beyond a trusted network:");
      console.log("         node scripts\hash-password.js   then set WEB_TERMINAL_PASSWORD_HASH");
    }
  });
}

process.on("uncaughtException", (err) => log.error("uncaught_exception", { error: err, stack: err.stack }));
process.on("unhandledRejection", (err) => log.error("unhandled_rejection", { error: err }));

module.exports = { app, server, hosts, config };
