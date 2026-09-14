"use strict";
/** Boots a real web server + a real PTY host on throwaway ports. */
const { spawn } = require("child_process");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch (err) {
      lastErr = err;
    }
    await wait(150);
  }
  throw new Error(`Server did not become healthy: ${lastErr && lastErr.message}`);
}

class Stack {
  constructor(opts = {}) {
    this.opts = opts;
    this.procs = [];
  }

  async start() {
    this.port = await freePort();
    this.hostPort = await freePort();
    this.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-data-"));
    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-root-"));
    this.password = this.opts.password === undefined ? "test-pass-123" : this.opts.password;

    // Seed accounts before either process reads the data directory. Their mere
    // existence is what switches the server from shared-password to accounts.
    if (this.opts.users) {
      const { hashPassword } = require(path.join(ROOT, "server", "users.js"));
      const seeded = this.opts.users.map((u) => ({
        name: u.name,
        hash: hashPassword(u.password),
        role: u.role === "admin" ? "admin" : "user",
        mustChange: !!u.mustChange,
        createdAt: new Date().toISOString(),
        lastLoginAt: null,
      }));
      fs.writeFileSync(path.join(this.dataDir, "users.json"), JSON.stringify(seeded, null, 1));
    }

    this.env = {
      ...process.env,
      PORT: String(this.port),
      HOST: "127.0.0.1",
      PTY_HOST_PORT: String(this.hostPort),
      WEB_TERMINAL_DATA: this.dataDir,
      WEB_TERMINAL_ROOTS: this.workDir,
      WEB_TERMINAL_PASSWORD: this.password,
      WEB_TERMINAL_LOG_CONSOLE: "0",
      WEB_TERMINAL_LOG_LEVEL: "warn",
      WEB_TERMINAL_EXITED_KEEP_MIN: "5",
    };

    this.host = this.spawnProc("pty-host.js");
    await wait(400);
    this.web = this.spawnProc("server.js");
    this.base = `http://127.0.0.1:${this.port}`;
    await waitForHealth(this.base);
    return this;
  }

  spawnProc(file) {
    const p = spawn(process.execPath, [path.join(ROOT, "server", file)], {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    p.stdout.on("data", () => {});
    p.stderr.on("data", () => {});
    this.procs.push(p);
    return p;
  }

  /** Restart only the web server: sessions must survive. */
  async restartWeb() {
    this.web.kill();
    await wait(500);
    this.web = this.spawnProc("server.js");
    await waitForHealth(this.base);
  }

  /** @param {string|{username?:string,password?:string}} who */
  async login(who = this.password) {
    const creds = typeof who === "string" ? { password: who } : who;
    const res = await fetch(`${this.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WT-Client": "1" },
      body: JSON.stringify({ username: creds.username || "", password: creds.password }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) this.token = body.token;
    return { status: res.status, body };
  }

  /** Run a block as another account without losing the current one. */
  async as(who, fn) {
    const previous = this.token;
    try {
      const r = await this.login(who);
      if (r.status !== 200) throw new Error(`login failed for ${JSON.stringify(who)}: ${r.status}`);
      return await fn(this);
    } finally {
      this.token = previous;
    }
  }

  async api(method, url, body, extraHeaders = {}) {
    const headers = { "X-WT-Client": "1", ...extraHeaders };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload = body;
    if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.base}${url}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, text };
  }

  wsUrl() {
    return `ws://127.0.0.1:${this.port}/terminal?token=${encodeURIComponent(this.token || "")}`;
  }

  async stop() {
    for (const p of this.procs) {
      try {
        p.kill();
      } catch {}
    }
    await wait(300);
    for (const dir of [this.dataDir, this.workDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

const WINDOWS = process.platform === "win32";

/**
 * What the tests open terminals with. Every machine has one of these, and the
 * tests care that a shell starts and echoes - not which shell it is.
 */
const SHELL = WINDOWS ? "cmd" : "bash";

/**
 * A shell that reports its working directory through the injected startup hook.
 * On Windows that is PowerShell; on POSIX, bash with the generated rc file.
 */
const CWD_SHELL = WINDOWS ? "powershell" : "bash";

/** A directory that exists but must never be offered as a place to start one. */
const SYSTEM_DIR = WINDOWS ? "C:\\Windows" : "/proc";

/** An absolute path that does not exist, in the platform's own shape. */
const MISSING_DIR = WINDOWS ? "C:\\no-such-folder-4711" : "/no-such-folder-4711";

module.exports = { Stack, freePort, wait, waitForHealth, WINDOWS, SHELL, CWD_SHELL, SYSTEM_DIR, MISSING_DIR };
