"use strict";
/**
 * Web server -> PTY host link. One instance per machine.
 *
 * The local machine's host is spawned on demand; remote machines must already
 * be running their own PTY host with PTY_HOST_BIND set, and are authenticated
 * with that machine's shared key.
 *
 * Requests are correlated by reqId so REST handlers can await a real answer.
 * Events (output/exit/sessions/cwd) are emitted for the WebSocket layer.
 */
const net = require("net");
const tls = require("tls");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const path = require("path");
const crypto = require("crypto");

const { config, hostKey } = require("./config");
const { createLogger } = require("./logger");
const { plainAddress } = require("./machine");
const tlspsk = require("./tlspsk");

const log = createLogger("web", config.dataDir);
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A handshake that failed says nothing useful by itself ("wrong version
 * number"), and the two causes need opposite fixes: the same key is missing, or
 * the machine at the far end is old enough that it only speaks plaintext.
 */
const isHandshakeError = (err) =>
  /ssl|tls|handshake|decrypt|psk|wrong version/i.test(String((err && (err.code || err.message)) || ""));

function handshakeHint(client, err) {
  const how = client.local ? "" : ` node scripts/machines.js tls ${client.id} off`;
  return (
    `${err.message} - the encrypted link to "${client.name}" did not come up. ` +
    `Either the key there differs from the one saved here, or that machine still runs a ` +
    `version without TLS; in that case upgrade it, or accept plaintext with${how || " PTY_HOST_TLS=0"}.`
  );
}

class HostClient extends EventEmitter {
  /**
   * @param {{id?:string, name?:string, address?:string, port?:number, key?:string, local?:boolean,
   *   machineId?:string, publicAddress?:string}} opts
   *   publicAddress: for the local machine, the address the *other* machines
   *   reach it by. It is connected to over loopback, so `address` says nothing.
   */
  constructor(opts = {}) {
    super();
    this.id = opts.id || "local";
    this.name = opts.name || (opts.local === false ? this.id : "This machine");
    this.address = opts.address || "127.0.0.1";
    this.port = Number(opts.port) || config.ptyHostPort;
    this.local = opts.local !== false;
    this.key = opts.key || (this.local ? hostKey() : "");
    /**
     * Encrypt this link with TLS-PSK (server/tlspsk.js). Our own machine's host
     * runs this same code, so it follows this machine's setting; a remote
     * machine is whatever its registry entry says, because it may still be
     * running a version that only speaks plaintext.
     */
    this.tls = this.local ? config.ptyTls : opts.tls !== false;
    this.publicAddress = opts.publicAddress || "";
    /** Reported by the PTY host itself; empty for one older than the field. */
    this.machineId = opts.machineId || "";
    this.hostname = "";
    this.platform = "";
    /** Our end of the link: the address this machine is seen by from there. */
    this.localAddress = "";

    this.socket = null;
    this.connected = false;
    this.buffer = "";
    this.pending = new Map();
    this.queue = [];
    this.retryMs = 300;
    this.sessions = [];
    this.hostPid = 0;
    this.hostStartedAt = 0;
    this.spawning = false;
    this.stopped = false;
    this.lastError = "";
  }

  start() {
    this.connect();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
    }
    this.socket = null;
    this.connected = false;
  }

  /** Only the local host may be started by us. */
  spawnHost() {
    if (!this.local || this.spawning || this.stopped) return;
    this.spawning = true;
    try {
      const child = spawn(process.execPath, [path.join(__dirname, "pty-host.js")], {
        detached: true,
        stdio: "ignore",
        env: process.env,
        windowsHide: true,
      });
      child.unref();
      log.info("pty_host_spawned", { pid: child.pid });
    } catch (err) {
      log.error("pty_host_spawn_failed", { error: err });
    }
    setTimeout(() => {
      this.spawning = false;
    }, 3000);
  }

  connect() {
    if (this.stopped || this.socket) return;
    // A tls.Socket is not usable until "secureConnect"; sending the hello on
    // "connect" would put the key on the wire before the handshake finished.
    const sock = this.tls
      ? tls.connect({ port: this.port, host: this.address, ...tlspsk.clientOptions(this.key) })
      : net.createConnection({ port: this.port, host: this.address });
    this.socket = sock;
    sock.setEncoding("utf8");
    sock.setNoDelay(true);
    sock.setTimeout(20_000);

    sock.on(this.tls ? "secureConnect" : "connect", () => {
      this.retryMs = 300;
      this.buffer = "";
      this.localAddress = plainAddress(sock.localAddress);
      this.rawSend({ type: "hello", key: this.key, reqId: "hello" });
    });

    sock.on("timeout", () => {
      if (!this.connected) sock.destroy();
    });

    sock.on("data", (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 64 * 1024 * 1024) {
        this.buffer = "";
        sock.destroy();
        return;
      }
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this.dispatch(msg);
      }
    });

    const drop = () => {
      if (this.socket !== sock) return;
      this.socket = null;
      const was = this.connected;
      this.connected = false;
      this.sessions = [];
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`PTY host "${this.name}" is not reachable`));
      }
      this.pending.clear();
      if (was) {
        log.warn("pty_host_disconnected", { hostId: this.id });
        this.emit("disconnected", this);
      }
      if (this.stopped) return;
      this.spawnHost();
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.local ? 5000 : 15000, Math.round(this.retryMs * 1.7));
    };

    sock.on("close", drop);
    sock.on("error", (err) => {
      this.lastError = this.tls && isHandshakeError(err) ? handshakeHint(this, err) : err.message;
    });
  }

  dispatch(msg) {
    if (msg.type === "hello" && msg.reqId === "hello") {
      this.connected = true;
      this.lastError = "";
      this.hostPid = msg.pid;
      this.hostStartedAt = msg.startedAt;
      if (msg.machine && msg.machine.id) {
        this.machineId = String(msg.machine.id);
        this.hostname = String(msg.machine.hostname || "");
        this.platform = String(msg.machine.platform || "");
      }
      this.sessions = msg.sessions || [];
      log.info("pty_host_connected", { hostId: this.id, hostPid: msg.pid, sessions: this.sessions.length });
      this.flushQueue();
      this.emit("connected", this);
      this.emit("sessions", this.sessions, this);
      return;
    }
    if (msg.type === "error" && msg.reqId === "hello") {
      this.lastError = msg.message || "Rejected by the PTY host";
      log.warn("pty_host_rejected", { hostId: this.id, message: this.lastError });
      return;
    }

    if (msg.reqId && this.pending.has(msg.reqId)) {
      const p = this.pending.get(msg.reqId);
      this.pending.delete(msg.reqId);
      clearTimeout(p.timer);
      if (msg.type === "error") p.reject(new Error(msg.message || "PTY host error"));
      else p.resolve(msg);
      if (msg.type === "sessions") this.sessions = msg.sessions || this.sessions;
      return;
    }

    if (msg.type === "sessions") {
      this.sessions = msg.sessions || [];
      this.emit("sessions", this.sessions, this);
      return;
    }
    this.emit("event", msg, this);
  }

  rawSend(msg) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(JSON.stringify(msg) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  flushQueue() {
    for (const m of this.queue.splice(0)) this.rawSend(m);
  }

  /** Fire and forget (input, resize, detach). */
  notify(msg) {
    if (this.connected) return this.rawSend(msg);
    if (this.queue.length < 500) this.queue.push(msg);
    return false;
  }

  /** Request/response. */
  request(msg) {
    return new Promise((resolve, reject) => {
      const reqId = crypto.randomBytes(6).toString("hex");
      const payload = { ...msg, reqId };
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`PTY host "${this.name}" did not answer in time`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer });
      if (this.connected) {
        if (!this.rawSend(payload)) {
          clearTimeout(timer);
          this.pending.delete(reqId);
          reject(new Error(`PTY host "${this.name}" is not reachable`));
        }
      } else if (this.local) {
        this.queue.push(payload);
        this.spawnHost();
      } else {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new Error(`Machine "${this.name}" is offline${this.lastError ? ` (${this.lastError})` : ""}`));
      }
    });
  }

  status() {
    return {
      id: this.id,
      name: this.name,
      address: (this.local && this.publicAddress) || this.address,
      port: this.port,
      local: this.local,
      machineId: this.machineId,
      hostname: this.hostname,
      platform: this.platform,
      connected: this.connected,
      /** Whether the terminal traffic to this machine is encrypted. */
      tls: this.tls,
      hostPid: this.hostPid,
      hostStartedAt: this.hostStartedAt,
      sessionCount: this.sessions.length,
      lastError: this.connected ? "" : this.lastError,
    };
  }
}

module.exports = { HostClient };
