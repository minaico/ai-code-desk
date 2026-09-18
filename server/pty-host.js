"use strict";
/**
 * PTY host — the process that owns every ConPTY session.
 *
 * It is deliberately separate from the web server so that restarting the web
 * UI (or losing every browser) never kills a running shell / Claude Code.
 * It listens on 127.0.0.1 only and requires a shared secret read from
 * <dataDir>/host.key, so another local user cannot drive it.
 *
 * Wire format: newline-delimited JSON, both directions.
 */
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const pty = require("node-pty");

const { config, ensureDataDir, hostKey } = require("./config");
const tlspsk = require("./tlspsk");
const { createLogger } = require("./logger");
const profiles = require("./profiles");
const { History } = require("./history");
const { AgentLogger, detectAgent } = require("./agent-log");
const { machineInfo } = require("./machine");

ensureDataDir();
const log = createLogger("pty-host", config.dataDir);
const SECRET = hostKey();
const startedAt = Date.now();
const history = new History(config.dataDir, log);
const AGENT_LOG_FALLBACK = require("path").join(config.dataDir, "agent-logs");

/** id -> session */
const sessions = new Map();
/** every connected web server socket */
const clients = new Set();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
const newId = () => crypto.randomBytes(9).toString("hex");

function clampCols(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(20, Math.min(500, n)) : 120;
}
function clampRows(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(5, Math.min(200, n)) : 32;
}
function cleanTitle(v, dflt) {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (s || dflt).slice(0, 60);
}
/**
 * The tab name for a working directory: the last folder, or the drive itself
 * at the root. C:\work\Test -> "Test", C:\ -> "C:\".
 */
function titleFromCwd(cwd) {
  const raw = String(cwd || "");
  const trimmed = raw.replace(/[\\/]+$/, "");
  // The POSIX root trims away to nothing, and a tab sitting at / should say so
  // rather than fall back to the name of the shell.
  if (!trimmed) return raw.startsWith("/") ? "/" : "";
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + "\\";
  return path.basename(trimmed) || trimmed;
}

/** A tab colour is either nothing or a plain #rrggbb. */
function cleanColor(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : "";
}

function resolveCwd(requested) {
  const candidate = String(requested || "").trim();
  if (candidate) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  return config.defaultCwd || process.env.USERPROFILE || os.homedir() || process.cwd();
}

/**
 * The tab's name, on disk, one file per session.
 *
 * The shells this app starts wrap `claude` so that a bare invocation becomes
 * `claude --remote-control "<tab name>"` - otherwise claude.ai lists a wall of
 * hostname-plus-random-word names with nothing to tell them apart. A file
 * rather than an environment variable because a tab gets renamed and follows
 * its working directory: the environment a shell was spawned with is a
 * snapshot, and this is read at the moment the command is typed.
 */
const TITLE_DIR = path.join(config.dataDir, "titles");

function titleFile(sessionId) {
  return path.join(TITLE_DIR, `${sessionId}.txt`);
}

/**
 * Variables a coding agent sets to tell a process it spawns "you are running
 * inside my session".
 *
 * They are correct for that process and wrong for everything downstream of it.
 * Start this host from a terminal that an agent owns - which is exactly how you
 * restart it while working on this app - and every shell it goes on to spawn
 * inherits the markers through process.env. Claude Code then reads them and
 * behaves as a nested child: it stops saving a transcript and does not bring up
 * Remote Control, so the tab-name feature above silently does nothing. Measured
 * on a real session: "Transcript saving is off - inherited
 * CLAUDE_CODE_CHILD_SESSION marker".
 *
 * A terminal must not depend on who happened to launch the host. Only the
 * per-session markers are dropped; settings a user chose deliberately, such as
 * CLAUDE_CONFIG_DIR or ANTHROPIC_*, are theirs and are passed through.
 */
const AGENT_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX",
  "AGY_REMOTE_CONTROL_SESSION_NAME_PREFIX",
];

/** process.env with the launching agent's session markers removed. */
function cleanEnv() {
  const env = { ...process.env };
  for (const name of AGENT_SESSION_VARS) delete env[name];
  return env;
}

function writeTitleFile(s) {
  try {
    fs.mkdirSync(TITLE_DIR, { recursive: true });
    fs.writeFileSync(titleFile(s.id), String(s.title || ""), "utf8");
  } catch (err) {
    // A name is a convenience; failing to write one must not fail a terminal.
    log.warn("title_file_write_failed", { sessionId: s.id, error: err });
  }
}

function removeTitleFile(sessionId) {
  try {
    fs.rmSync(titleFile(sessionId), { force: true });
  } catch {}
}

function info(s) {
  return {
    id: s.id,
    title: s.title,
    color: s.color,
    autoTitle: s.autoTitle,
    shell: s.shell,
    cwd: s.cwd,
    pid: s.pid,
    createdAt: s.createdAt,
    lastAttachedAt: s.lastAttachedAt,
    status: s.status,
    exitCode: s.exitCode,
    cols: s.cols,
    rows: s.rows,
    autoRun: s.autoRun ? true : false,
    owner: s.owner || "",
    // The terminal's identity across reopens, so a saved workspace can find
    // this session again after the machine that ran it has been restarted.
    lineage: s.lineage || s.id,
    // The agent running here *now*, cleared when the shell prompt comes back
    // (noteShellPrompt) so a terminal someone has left goes back to looking like
    // the plain shell it is again. What once ran here is in the history record.
    agent: s.agentLogger ? s.agentLogger.agent.kind : s.agent || null,
    agentLogFile: s.agentLogger ? s.agentLogger.file : null,
    bufferBytes: s.bufferBytes,
  };
}
const listInfo = () => [...sessions.values()].map(info);

function send(sock, msg) {
  if (!sock || sock.destroyed || !sock.authed) return;
  try {
    sock.write(JSON.stringify(msg) + "\n");
  } catch (err) {
    log.warn("client_write_failed", { error: err });
  }
}
function toSubscribers(sessionId, msg) {
  for (const c of clients) if (c.subs && c.subs.has(sessionId)) send(c, msg);
}
function broadcast(msg) {
  for (const c of clients) send(c, msg);
}
function announce() {
  broadcast({ type: "sessions", sessions: listInfo() });
}

/* ------------------------------------------------------------------ *
 * Scrollback ring buffer — this is what makes reconnect show history.
 * ------------------------------------------------------------------ */
function pushBuffer(s, chunk) {
  s.buffer.push(chunk);
  s.bufferBytes += chunk.length;
  while (s.bufferBytes > config.scrollbackBytes && s.buffer.length > 1) {
    s.bufferBytes -= s.buffer.shift().length;
  }
}

/* ------------------------------------------------------------------ *
 * OSC 9;9 current-directory reporting (emitted by our shell init).
 * The raw stream is forwarded untouched; we only *read* a copy.
 * ------------------------------------------------------------------ */
const OSC_CWD = /\u001b\]9;9;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
const PROMPT_CWD = /(?:^|\n)(?:PS\s+)?([A-Za-z]:\\[^\r\n>]{0,240})>/g;

/**
 * The shell prompt has run again, so whatever was in front of it is gone: an
 * agent running in this terminal has exited.
 *
 * The tab colour and the newline encoding both read this flag, so leaving it set
 * after `/exit` left the tab claiming Claude was there and made a pasted newline
 * go out as ESC CR to a plain shell.
 *
 * Only our own OSC 9;9 reaches here. The prompt-shaped regex used as a fallback
 * on shells that do not emit it would also match a TUI drawing something that
 * looks like a prompt, and would clear the flag mid-session.
 */
function noteShellPrompt(s) {
  if (!s.agentLogger && !s.agent) return;
  if (s.agentLogger) {
    s.agentLogger.close("agent exited: the shell prompt came back");
    s.agentLogger = null;
  }
  s.agent = null;
  log.info("agent_ended", { sessionId: s.id });
  announce();
}

function trackCwd(s, chunk) {
  const text = s.cwdTail + chunk;
  let found = "";
  let promptRan = false;
  let consumed = 0;
  let m;
  OSC_CWD.lastIndex = 0;
  while ((m = OSC_CWD.exec(text))) {
    found = m[1];
    promptRan = true;
    consumed = OSC_CWD.lastIndex;
  }
  if (!found && !s.reportsCwd) {
    PROMPT_CWD.lastIndex = 0;
    while ((m = PROMPT_CWD.exec(text))) {
      found = m[1];
      consumed = PROMPT_CWD.lastIndex;
    }
  }
  // Carry forward only what came *after* the last sequence read. Keeping a flat
  // 512 characters meant one prompt could be read again in the next chunk -
  // harmless for the cwd, but it would clear the agent flag that the command
  // typed at that very prompt had just set.
  s.cwdTail = text.slice(Math.max(consumed, text.length - 512));
  if (promptRan) noteShellPrompt(s);
  if (!found) return;
  const next = found.replace(/^["']|["']$/g, "").trim();
  if (!next || next === s.cwd) return;
  s.cwd = next;
  if (s.autoTitle) {
    const auto = titleFromCwd(next);
    if (auto) s.title = auto;
  }
  writeTitleFile(s);
  history.touch(s);
  broadcast({ type: "cwd", sessionId: s.id, cwd: next });
  announce();
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */
function spawnPty(s) {
  const exe = profiles.resolveExe(s.shell);
  if (!exe) throw new Error(`Shell not available on this machine: ${s.shell}`);
  const args = profiles.profileArgs(s.shell);
  const child = pty.spawn(exe, args, {
    name: "xterm-256color",
    cols: s.cols,
    rows: s.rows,
    cwd: s.cwd,
    // Some shells cannot be handed an init script as an argument and have to be
    // hooked through the environment instead - zsh through ZDOTDIR.
    env: {
      ...cleanEnv(),
      ...profiles.profileEnv(s.shell),
      TERM: "xterm-256color",
      WT_SESSION_ID: s.id,
      WT_TITLE_FILE: titleFile(s.id),
    },
    useConpty: true,
  });

  s.pty = child;
  s.pid = child.pid;
  s.status = "running";
  s.exitCode = null;
  s.reportsCwd = !!(profiles.PROFILES[s.shell] && profiles.PROFILES[s.shell].reportsCwd);

  child.onData((data) => {
    pushBuffer(s, data);
    trackCwd(s, data);
    if (s.agentLogger) s.agentLogger.noteOutput(data);
    toSubscribers(s.id, { type: "output", sessionId: s.id, data });
  });

  child.onExit(({ exitCode, signal }) => {
    s.status = "exited";
    s.exitCode = exitCode;
    s.exitedAt = Date.now();
    s.pty = null;
    const note = `\r\n\u001b[33m[process exited: ${exitCode}${signal ? " signal " + signal : ""}]\u001b[0m\r\n`;
    pushBuffer(s, note);
    toSubscribers(s.id, { type: "output", sessionId: s.id, data: note });
    toSubscribers(s.id, { type: "exit", sessionId: s.id, exitCode, signal });
    if (s.agentLogger) {
      s.agentLogger.close(`process exited: ${exitCode}`);
      s.agentLogger = null;
    }
    history.close(s, exitCode);
    log.info("session_exit", { sessionId: s.id, shell: s.shell, exitCode, signal });
    announce();
  });

  // Type the launcher command into the real PTY, exactly like a human would -
  // including through the same input watcher, so a launched agent is recognised
  // at the same moment a hand-typed one is, and not before its first prompt.
  if (s.autoRun) {
    setTimeout(() => {
      if (s.pty && s.status === "running") {
        try {
          noteInputForAgent(s, s.autoRun + "\r");
          s.pty.write(s.autoRun + "\r");
        } catch {}
      }
    }, 600);
  }
  return child;
}

/**
 * Start (or keep) a transcript for this session when the command being run is
 * an AI CLI. Detection is on the command line the user actually submitted, so
 * typing "claude" by hand starts logging just like the launcher does.
 */
function startAgentLogIfNeeded(s, commandLine) {
  if (s.agentLogger) return;
  const agent = detectAgent(commandLine);
  if (!agent) return;
  try {
    s.agentLogger = new AgentLogger(s, agent, AGENT_LOG_FALLBACK, log);
    log.info("agent_log_started", { sessionId: s.id, agent: agent.kind, file: s.agentLogger.file });
    s.agent = agent.kind;
    history.setAgent(s.id, agent.kind);
    announce();
  } catch (err) {
    log.warn("agent_log_start_failed", { sessionId: s.id, error: err });
  }
}

/** Watch typed lines so "claude" typed by hand also starts a transcript. */
function noteInputForAgent(s, data) {
  if (s.agentLogger) {
    s.agentLogger.noteInput(data);
    return;
  }
  for (const ch of String(data)) {
    if (ch === "\r" || ch === "\n") {
      const line = s.inputLine.trim();
      s.inputLine = "";
      if (line) startAgentLogIfNeeded(s, line);
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      s.inputLine = s.inputLine.slice(0, -1);
      continue;
    }
    if (ch < " " && ch !== "\t") continue;
    s.inputLine += ch;
    if (s.inputLine.length > 4000) s.inputLine = s.inputLine.slice(-4000);
  }
}

function createSession(opts = {}) {
  // Only when a limit was asked for (WEB_TERMINAL_MAX_SESSIONS > 0).
  if (config.maxSessions > 0) {
    const running = [...sessions.values()].filter((s) => s.status === "running").length;
    if (running >= config.maxSessions) throw new Error(`Session limit reached (${config.maxSessions})`);
  }

  const shell = String(opts.shell || "powershell");
  if (!profiles.PROFILES[shell]) throw new Error(`Unknown shell profile: ${shell}`);

  const cwd = resolveCwd(opts.cwd);
  // A tab with no name of its own follows the folder it is sitting in.
  const named = !!String(opts.title || "").trim();
  const s = {
    id: newId(),
    shell,
    cwd,
    autoTitle: opts.autoTitle === undefined ? !named : !!opts.autoTitle,
    color: cleanColor(opts.color),
    title: cleanTitle(named ? opts.title : titleFromCwd(cwd), profiles.PROFILES[shell].label),
    cols: clampCols(opts.cols),
    rows: clampRows(opts.rows),
    autoRun: String(opts.autoRun || "").replace(/[\r\n]/g, "").slice(0, 400),
    createdAt: new Date().toISOString(),
    lastAttachedAt: null,
    status: "starting",
    exitCode: null,
    pid: 0,
    buffer: [],
    bufferBytes: 0,
    cwdTail: "",
    pty: null,
    agentLogger: null,
    inputLine: "",
    reopenedFrom: opts.reopenedFrom ? String(opts.reopenedFrom).slice(0, 40) : null,
    // Who this terminal belongs to. The PTY host authenticates nobody — the web
    // server does that and passes the name down — but ownership has to live on
    // the session, because the session outlives the login that created it.
    owner: String(opts.owner || "").slice(0, 64),
  };
  sessions.set(s.id, s);
  writeTitleFile(s); // before the shell starts, so it is there when read
  try {
    spawnPty(s);
  } catch (err) {
    sessions.delete(s.id);
    throw err;
  }
  const entry = history.record(s);
  s.lineage = entry.lineage;
  // A launcher's command is detected when it is typed (below), not here: the
  // first prompt arrives before it, and that prompt now means "nothing running".
  log.info("session_create", { sessionId: s.id, shell, cwd: s.cwd, pid: s.pid, autoRun: !!s.autoRun });
  announce();
  return s;
}

/** Restart in place: same session id, same tab, fresh process. */
function restartSession(s) {
  if (s.pty) {
    try {
      s.pty.kill();
    } catch {}
  }
  if (s.agentLogger) {
    s.agentLogger.close("restarted");
    s.agentLogger = null;
  }
  // A fresh process is running nothing yet, whatever the old one was running.
  s.agent = null;
  s.buffer = [];
  s.bufferBytes = 0;
  s.cwdTail = "";
  s.inputLine = "";
  s.createdAt = new Date().toISOString();
  setTimeout(() => {
    try {
      spawnPty(s);
      toSubscribers(s.id, { type: "reset", sessionId: s.id });
      log.info("session_restart", { sessionId: s.id, shell: s.shell, pid: s.pid });
      announce();
    } catch (err) {
      s.status = "exited";
      log.error("session_restart_failed", { sessionId: s.id, error: err });
      toSubscribers(s.id, { type: "error", sessionId: s.id, message: err.message });
      announce();
    }
  }, 250);
}

function killSession(s) {
  if (s.pty) {
    try {
      s.pty.kill();
    } catch (err) {
      log.warn("session_kill_failed", { sessionId: s.id, error: err });
    }
  }
  s.status = "exited";
  s.exitedAt = Date.now();
  if (s.agentLogger) {
    s.agentLogger.close("killed");
    s.agentLogger = null;
  }
  history.close(s);
  log.info("session_kill", { sessionId: s.id });
}

function removeSession(s) {
  killSession(s);
  sessions.delete(s.id);
  removeTitleFile(s.id);
  for (const c of clients) c.subs.delete(s.id);
  log.info("session_remove", { sessionId: s.id });
  announce();
}

// Reap exited sessions that nobody restarted.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const s of [...sessions.values()]) {
    if (s.status === "exited" && s.exitedAt && now - s.exitedAt > config.exitedKeepMs) {
      sessions.delete(s.id);
      changed = true;
    }
  }
  if (changed) announce();
}, 60_000).unref();

/* ------------------------------------------------------------------ *
 * Request handling
 * ------------------------------------------------------------------ */
function requireSession(msg) {
  const s = sessions.get(String(msg.sessionId || ""));
  if (!s) throw new Error("Session not found");
  return s;
}

function handle(sock, msg) {
  const reqId = msg.reqId;
  const ok = (extra) => send(sock, { type: "ok", reqId, ...extra });

  if (!sock.authed) {
    if (msg.type !== "hello") throw new Error("Not authenticated");
    const given = Buffer.from(String(msg.key || ""));
    const want = Buffer.from(SECRET);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      log.warn("host_auth_failed", {});
      throw new Error("Bad host key");
    }
    sock.authed = true;
    send(sock, { type: "hello", reqId, pid: process.pid, startedAt, machine: machineInfo(), sessions: listInfo() });
    return;
  }

  switch (msg.type) {
    case "hello":
      return void send(sock, {
        type: "hello",
        reqId,
        pid: process.pid,
        startedAt,
        machine: machineInfo(),
        sessions: listInfo(),
      });

    case "profiles":
      // Which shells exist *here*. The web server cannot answer this for another
      // machine: a Windows browser was offering PowerShell for a Linux host and
      // nothing but the error message said otherwise.
      return void send(sock, {
        type: "profiles",
        reqId,
        platform: process.platform,
        shells: profiles.availableProfiles().map((p) => ({ id: p.id, label: p.label, icon: p.icon })),
        launchers: profiles.launchers(),
      });

    case "list":
      return void send(sock, { type: "sessions", reqId, sessions: listInfo() });

    case "stats":
      return void send(sock, {
        type: "stats",
        reqId,
        pid: process.pid,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        memory: process.memoryUsage(),
        node: process.version,
        sessionCount: sessions.size,
        runningCount: [...sessions.values()].filter((s) => s.status === "running").length,
      });

    case "create": {
      const s = createSession(msg);
      sock.subs.add(s.id);
      s.lastAttachedAt = new Date().toISOString();
      return void send(sock, { type: "created", reqId, session: info(s) });
    }

    case "attach": {
      const s = requireSession(msg);
      sock.subs.add(s.id);
      s.lastAttachedAt = new Date().toISOString();
      // The size the buffer was drawn at, captured before this attach changes
      // it. The buffer is a recording of a terminal of that width, and a
      // recording only replays correctly at the width it was made at.
      const replay = { cols: s.cols, rows: s.rows };
      // claim: whether this attach speaks for a person looking at the screen.
      // A reconnecting socket and a background tab both attach with
      // claim:false, and neither may reshape the terminal - one measured "tt"
      // was drawn for 49x33 because a phone tab left open in the background
      // kept re-attaching and squeezing the PTY out from under the desktop
      // that was actually being read. The client has sent this flag since the
      // reattach logic was written; it was dropped on the way here.
      if (msg.claim !== false && msg.cols && msg.rows && s.pty) {
        s.cols = clampCols(msg.cols);
        s.rows = clampRows(msg.rows);
        try {
          s.pty.resize(s.cols, s.rows);
        } catch {}
      }
      log.info("session_attach", { sessionId: s.id });
      send(sock, {
        type: "history",
        reqId,
        sessionId: s.id,
        data: s.buffer.join(""),
        replay,
        session: info(s),
      });
      announce();
      return;
    }

    // The scrollback, read without attaching, resizing or claiming anything.
    // The screen cannot hold a Claude Code answer that is taller than it is -
    // each reprint of the growing block pushes another partial copy away - but
    // every frame it ever drew is still here, so the whole answer can be
    // rebuilt from this even when the terminal no longer shows it.
    case "buffer": {
      const s = requireSession(msg);
      return void send(sock, {
        type: "buffer",
        reqId,
        sessionId: s.id,
        data: s.buffer.join(""),
        replay: { cols: s.cols, rows: s.rows },
      });
    }

    case "detach": {
      const s = sessions.get(String(msg.sessionId || ""));
      sock.subs.delete(String(msg.sessionId || ""));
      if (s) log.info("session_detach", { sessionId: s.id });
      return void ok({});
    }

    case "input": {
      const s = requireSession(msg);
      if (!s.pty) throw new Error("Session is not running");
      const data = String(msg.data ?? "");
      if (data.length > 100_000) throw new Error("Input too large");
      noteInputForAgent(s, data);
      s.pty.write(data);
      return;
    }

    case "resize": {
      const s = requireSession(msg);
      s.cols = clampCols(msg.cols);
      s.rows = clampRows(msg.rows);
      if (s.agentLogger) s.agentLogger.resize(s.cols, s.rows);
      if (s.pty) {
        try {
          s.pty.resize(s.cols, s.rows);
        } catch (err) {
          log.warn("resize_failed", { sessionId: s.id, error: err });
        }
      }
      return;
    }

    case "rename":
    case "update": {
      const s = requireSession(msg);
      if (msg.autoTitle !== undefined) s.autoTitle = !!msg.autoTitle;
      if (msg.title !== undefined) {
        const wanted = String(msg.title || "").trim();
        if (wanted) {
          // A name given explicitly always wins, even when the same request
          // also asks for auto-naming. Anything else silently throws the
          // name away, which is exactly what a caller never expects.
          s.title = cleanTitle(wanted, s.shell);
          s.autoTitle = false;
        } else if (msg.autoTitle === undefined) {
          // Clearing the name hands the tab back to the folder-follows rule.
          s.autoTitle = true;
        }
      }
      if (s.autoTitle) {
        const auto = titleFromCwd(s.cwd);
        if (auto) s.title = cleanTitle(auto, s.shell);
      }
      if (msg.color !== undefined) s.color = cleanColor(msg.color);
      writeTitleFile(s);
      history.touch(s);
      announce();
      return void ok({ session: info(s) });
    }

    case "kill": {
      const s = requireSession(msg);
      killSession(s);
      announce();
      return void ok({ session: info(s) });
    }

    case "remove": {
      const s = requireSession(msg);
      removeSession(s);
      return void ok({});
    }

    case "restart": {
      const s = requireSession(msg);
      restartSession(s);
      return void ok({ session: info(s) });
    }

    case "history":
      return void send(sock, { type: "history-list", reqId, entries: history.list(msg.limit) });

    case "history-remove": {
      const removed = history.remove(msg.entryId);
      return void ok({ removed });
    }

    case "history-clear": {
      history.clear();
      return void ok({});
    }

    case "reopen": {
      const entry = history.get(msg.entryId);
      if (!entry) throw new Error("History entry not found");
      let cwd = entry.cwd;
      try {
        if (!cwd || !fs.statSync(cwd).isDirectory()) cwd = "";
      } catch {
        cwd = "";
      }
      const fresh = createSession({
        shell: entry.shell,
        cwd,
        title: entry.autoTitle ? "" : entry.title,
        autoTitle: entry.autoTitle,
        color: entry.color,
        cols: msg.cols,
        rows: msg.rows,
        autoRun: entry.autoRun,
        reopenedFrom: entry.id,
        owner: msg.owner || entry.owner || "",
      });
      sock.subs.add(fresh.id);
      fresh.lastAttachedAt = new Date().toISOString();
      return void send(sock, {
        type: "created",
        reqId,
        session: info(fresh),
        restoredCwd: cwd === entry.cwd,
      });
    }

    case "ping":
      return void ok({ pong: true });

    default:
      throw new Error(`Unknown message type: ${String(msg.type).slice(0, 40)}`);
  }
}

/* ------------------------------------------------------------------ *
 * TCP server
 *
 * TLS-PSK by default (server/tlspsk.js): the key in .data/host.key both
 * encrypts the channel and authenticates it, so a wrong key now fails the
 * handshake before any message is parsed. The plaintext path remains only for
 * talking to an older peer, and says so in the log.
 * ------------------------------------------------------------------ */
const onConnection = (sock) => {
  sock.authed = false;
  sock.subs = new Set();
  sock.setEncoding("utf8");
  sock.setNoDelay(true);
  clients.add(sock);

  let buf = "";
  sock.on("data", (chunk) => {
    buf += chunk;
    if (buf.length > 8 * 1024 * 1024) {
      buf = "";
      send(sock, { type: "error", message: "Request buffer overflow" });
      sock.destroy();
      return;
    }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send(sock, { type: "error", message: "Malformed JSON" });
        continue;
      }
      try {
        handle(sock, msg);
      } catch (err) {
        send(sock, { type: "error", reqId: msg && msg.reqId, message: err.message });
        if (!sock.authed) sock.destroy();
      }
    }
  });

  sock.on("close", () => clients.delete(sock));
  sock.on("error", (err) => {
    log.warn("client_socket_error", { error: err });
    clients.delete(sock);
  });
};

const server = config.ptyTls
  ? tls.createServer(tlspsk.serverOptions(SECRET), onConnection)
  : net.createServer(onConnection);

// A failed handshake never reaches onConnection, so this is the only place a
// wrong key or an old plaintext peer shows up.
server.on("tlsClientError", (err, sock) => {
  log.warn("tls_handshake_failed", {
    error: err && err.message,
    peer: sock && sock.remoteAddress,
  });
});

server.on("error", (err) => {
  log.error("host_listen_error", { error: err });
  process.exit(1);
});

server.listen(config.ptyHostPort, config.ptyHostBind, () => {
  log.info("host_started", {
    port: config.ptyHostPort,
    bind: config.ptyHostBind,
    tls: config.ptyTls,
    pid: process.pid,
    node: process.version,
  });
  if (!config.ptyTls) {
    console.log("WARNING: PTY_HOST_TLS=0 - this channel is not encrypted. Every keystroke and");
    console.log("         everything the terminal prints crosses the network readable.");
  }
  if (config.ptyHostBind !== "127.0.0.1") {
    console.log(`PTY host is reachable from the network on ${config.ptyHostBind}:${config.ptyHostPort}.`);
    console.log(
      config.ptyTls
        ? "The channel is TLS-PSK: only machines holding the key in .data/host.key complete the handshake."
        : "Only machines holding the key in .data/host.key can connect."
    );
    console.log("Keep this on a trusted LAN or a VPN.");
  }
});

process.on("uncaughtException", (err) => log.error("uncaught_exception", { error: err, stack: err.stack }));
process.on("unhandledRejection", (err) => log.error("unhandled_rejection", { error: err }));

function shutdown() {
  log.info("host_stopping", { sessions: sessions.size });
  for (const s of sessions.values()) {
    if (s.agentLogger) {
      try {
        s.agentLogger.close("host stopping");
      } catch {}
    }
    history.close(s);
    if (s.pty) {
      try {
        s.pty.kill();
      } catch {}
    }
  }
  // close() only schedules a debounced write, and process.exit throws pending
  // timers away. Everything recorded in the last second of this process's life
  // would be lost - which is the second that matters after a crash.
  history.flush();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
