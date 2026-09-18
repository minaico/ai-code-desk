"use strict";
/**
 * The machines in the group, and which one of them this is.
 *
 * Every machine - including the one running this web server - is an entry in
 * `.data/hosts.json` with the same fields: id, name, address, port, key. No
 * entry is special on disk. Which one is "local" is decided at startup, by
 * finding this computer in the list (see server/machine.js), so the same file
 * works on every machine in the group: copy it to machine 42 and 42 serves the
 * UI, with this machine listed as one of its remotes, under the same id, the
 * same name and the same shape.
 *
 * "local" still works as a host id, as an alias for whichever machine this is.
 * It is never stored: a saved tab that says "local" means a different computer
 * depending on who reads it.
 *
 * Remote machines run their PTY host with PTY_HOST_BIND=0.0.0.0 and are
 * authenticated with that machine's own key (.data/host.key there). The link
 * is a plain TCP connection - good enough for a trusted LAN or a VPN, and
 * nothing more. It is not encrypted, so do not route it across the internet.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const { config, ensureDataDir, hostKey } = require("./config");
const { createLogger } = require("./logger");
const { HostClient } = require("./host-client");
const { machineId, guessLanAddress } = require("./machine");

const log = createLogger("web", config.dataDir);
const FILE = path.join(config.dataDir, "hosts.json");
// Where this machine's label lived before it had an entry of its own. Read once
// when that entry is created, then removed: two places for one name is how
// they end up disagreeing.
const LEGACY_LOCAL_NAME_FILE = path.join(config.dataDir, "local-name.txt");
const LOCAL_ALIAS = "local";
const MAX_HOSTS = 12;

class HostError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function loadStored() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e === "object" && e.id) : [];
  } catch {
    return [];
  }
}

function saveStored(list) {
  ensureDataDir();
  try {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (err) {
    log.warn("hosts_save_failed", { error: err });
  }
}

function takeLegacyLocalName() {
  try {
    const v = String(fs.readFileSync(LEGACY_LOCAL_NAME_FILE, "utf8")).trim().slice(0, 40);
    fs.unlinkSync(LEGACY_LOCAL_NAME_FILE);
    return v;
  } catch {
    return "";
  }
}

function cleanName(value) {
  const printable = [...String(value || "")].filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127);
  return printable.join("").trim().slice(0, 40);
}

function validAddress(value) {
  const address = String(value || "").trim();
  if (!address) throw new HostError("Address is required");
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(address)) throw new HostError("Invalid address");
  return address;
}

const isLoopback = (address) => /^(127\.|::1$|localhost$)/i.test(String(address || ""));

/** Set it when the address other machines should use cannot be worked out. */
const pinnedAddress = () => String(process.env.WEB_TERMINAL_ADDRESS || "").trim();

/**
 * Where this computer is in the list, or -1.
 *
 * By machine id first. An entry saved before machines reported their id is
 * recognised by its key instead: every machine generates its own, so the entry
 * holding this machine's key is this machine.
 */
function findSelf(stored) {
  const me = machineId();
  const i = stored.findIndex((e) => e.machineId === me);
  if (i >= 0) return i;
  const key = hostKey();
  return stored.findIndex((e) => !e.machineId && e.key === key);
}

/**
 * Put this computer in the list if it is not there, and make what the list
 * says about it true. Mutates `stored`; returns this machine's index.
 *
 * Shared by the server and by scripts/machines.js, which may run on a machine
 * whose server has not started since the list arrived.
 */
function ensureSelf(stored) {
  let index = findSelf(stored);
  if (index < 0) {
    // The first start of this version here, or a list copied from a group this
    // computer was not in yet. Either way it joins as the first entry, which is
    // also the circle it has always been drawn with.
    stored.unshift({
      id: crypto.randomBytes(5).toString("hex"),
      name: takeLegacyLocalName() || os.hostname(),
      address: "",
      port: config.ptyHostPort,
      key: "",
      machineId: "",
    });
    index = 0;
    log.info("host_self_added", { hostId: stored[0].id, name: stored[0].name });
  }
  // Facts about this machine are read from this machine, whatever the file
  // says: it may have been written on another one.
  const self = stored[index];
  self.machineId = machineId();
  self.key = hostKey();
  self.port = config.ptyHostPort;
  // Carried into the export so the machines we are added to know this one's
  // channel is encrypted, the way AIHubManager's join code carries its flag.
  self.tls = config.ptyTls;
  if (pinnedAddress()) self.address = pinnedAddress();
  if (!self.address) self.address = guessLanAddress();
  return index;
}

class HostRegistry extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map();
    /** sessionId -> hostId, rebuilt from every session list we receive. */
    this.sessionHost = new Map();
    /** Registry id of the machine this web server runs on. */
    this.selfId = "";
  }

  start() {
    const stored = loadStored();
    const before = JSON.stringify(stored);
    const self = stored[ensureSelf(stored)];
    if (JSON.stringify(stored) !== before) saveStored(stored);
    this.selfId = self.id;

    for (const entry of stored) {
      try {
        const local = entry.id === self.id;
        this.attach(
          local
            ? new HostClient({
                id: entry.id,
                name: entry.name,
                port: config.ptyHostPort,
                local: true,
                publicAddress: entry.address,
                machineId: entry.machineId,
              })
            : new HostClient({
                id: entry.id,
                name: entry.name,
                address: entry.address,
                port: entry.port,
                key: entry.key,
                machineId: entry.machineId,
                // Absent means an entry written before the channel could be
                // encrypted, so that machine is assumed to still speak plaintext.
                tls: entry.tls === true,
                local: false,
              })
        );
      } catch (err) {
        log.warn("host_restore_failed", { hostId: entry.id, error: err });
      }
    }
    for (const client of this.clients.values()) client.start();
    return this;
  }

  attach(client) {
    this.clients.set(client.id, client);
    client.on("sessions", (sessions, from) => {
      for (const [sid, hid] of [...this.sessionHost]) if (hid === from.id) this.sessionHost.delete(sid);
      for (const s of sessions) this.sessionHost.set(s.id, from.id);
      this.emit("sessions", this.allSessions());
    });
    client.on("event", (msg, from) => this.emit("event", { ...msg, hostId: from.id }));
    client.on("connected", (from) => {
      if (!from.local && !this.learn(from)) return;
      this.emit("hostState", from, true);
    });
    client.on("disconnected", (from) => {
      for (const [sid, hid] of [...this.sessionHost]) if (hid === from.id) this.sessionHost.delete(sid);
      this.emit("hostState", from, false);
      this.emit("sessions", this.allSessions());
    });
    return client;
  }

  /**
   * What a remote machine's answer tells us, written back to the list.
   * Returns false when the "remote" turned out to be this machine.
   */
  learn(client) {
    if (client.machineId && client.machineId === machineId()) {
      // Every local terminal would be listed twice, once under each name.
      client.stop();
      client.connected = false;
      client.sessions = [];
      client.lastError = "Địa chỉ này trỏ về chính máy đang chạy web";
      log.warn("host_is_self", { hostId: client.id, address: client.address });
      this.emit("sessions", this.allSessions());
      return false;
    }

    const stored = loadStored();
    const before = JSON.stringify(stored);
    const entry = stored.find((e) => e.id === client.id);
    if (entry) {
      if (client.machineId) entry.machineId = client.machineId;
      // A machine added by address alone is named by its address; the name it
      // gives itself says more.
      if (client.hostname && entry.name === entry.address) {
        entry.name = client.hostname.slice(0, 40);
        client.name = entry.name;
      }
    }

    // The address this machine is reached by is the one the operating system
    // just used to reach that one. Better than any guess from the interface
    // list, and it follows DHCP.
    const self = stored.find((e) => e.id === this.selfId);
    const seenAs = client.localAddress;
    if (self && seenAs && !isLoopback(seenAs) && !pinnedAddress() && self.address !== seenAs) {
      log.info("host_self_address", { from: self.address, to: seenAs, via: client.id });
      self.address = seenAs;
      if (this.local) this.local.publicAddress = seenAs;
    }

    if (JSON.stringify(stored) !== before) saveStored(stored);
    return true;
  }

  get local() {
    return this.clients.get(this.selfId);
  }

  /** A host id as stored, with the "local" alias resolved. */
  resolveId(hostId) {
    const id = String(hostId || LOCAL_ALIAS);
    return id === LOCAL_ALIAS ? this.selfId : id;
  }

  client(hostId) {
    const client = this.clients.get(this.resolveId(hostId));
    if (!client) throw new HostError("Unknown machine", 404);
    return client;
  }

  /** Which machine owns this session. */
  hostFor(sessionId) {
    const hostId = this.sessionHost.get(String(sessionId || ""));
    if (!hostId) throw new HostError("Session not found", 404);
    return this.client(hostId);
  }

  /**
   * Ask every reachable machine for its current session list.
   * The cached view is event-driven and only refreshes when a host announces a
   * change, so fields it does not announce (cols/rows) can lag; REST callers
   * that must be authoritative use this.
   */
  async refresh() {
    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        if (!client.connected && !client.local) return;
        try {
          const r = await client.request({ type: "list" });
          client.sessions = r.sessions || [];
          for (const [sid, hid] of [...this.sessionHost]) if (hid === client.id) this.sessionHost.delete(sid);
          for (const s of client.sessions) this.sessionHost.set(s.id, client.id);
        } catch {
          // an offline machine simply contributes nothing
        }
      })
    );
    return this.allSessions();
  }

  /** Every session from every machine, tagged with its host. */
  allSessions() {
    const out = [];
    for (const client of this.clients.values()) {
      for (const s of client.sessions) out.push({ ...s, hostId: client.id, hostName: client.name });
    }
    return out;
  }

  /** In list order, which is also the order shapes are handed out in. */
  list() {
    return [...this.clients.values()].map((c) => c.status());
  }

  add({ name, address, port, key, tls }) {
    if (this.clients.size >= MAX_HOSTS) throw new HostError(`At most ${MAX_HOSTS} machines`);
    const addr = validAddress(address);
    const p = Number(port) || config.ptyHostPort;
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new HostError("Invalid port");
    const secret = String(key || "").trim();
    if (secret.length < 32) throw new HostError("The machine key looks wrong - run scripts\\host-key.js there");

    for (const c of this.clients.values()) {
      if (!c.local && c.address.toLowerCase() === addr.toLowerCase() && c.port === p) {
        throw new HostError("That machine is already added");
      }
    }

    const id = crypto.randomBytes(5).toString("hex");
    // Encrypted unless the caller says otherwise: a machine being added now is
    // expected to run this version, and the fix for the other case is one
    // command (`machines.js tls <id> off`) with a message that names it.
    const entry = {
      id,
      name: cleanName(name) || addr,
      address: addr,
      port: p,
      key: secret,
      machineId: "",
      tls: tls !== false,
    };
    saveStored([...loadStored(), entry]);
    const client = this.attach(new HostClient({ ...entry, local: false }));
    client.start();
    log.info("host_added", { hostId: id, address: addr, port: p });
    return client.status();
  }

  /**
   * Rename a machine. Only the label: the address, the port and the key are
   * what make it reachable, and changing those is adding a different machine.
   */
  rename(hostId, name) {
    const client = this.client(hostId);
    const clean = cleanName(name);
    if (!clean) throw new HostError("Tên máy không được để trống");

    client.name = clean;
    saveStored(loadStored().map((e) => (e.id === client.id ? { ...e, name: clean } : e)));

    log.info("host_renamed", { hostId: client.id, name: clean });
    // Session cards and tabs carry the machine name, so they have to be redrawn.
    this.emit("sessions", this.allSessions());
    return client.status();
  }

  /**
   * Turn the encrypted channel to one machine on or off, and reconnect.
   *
   * This exists for the days a group spans two versions of this code: a machine
   * still running an older PTY host only speaks plaintext, and until it is
   * upgraded the link to it has to be told so. Turning it off is a real
   * downgrade, so it is logged as one.
   */
  setTls(hostId, on) {
    const client = this.client(hostId);
    if (client.local) throw new HostError("This machine's own channel follows PTY_HOST_TLS, not the registry");
    const want = !!on;
    if (client.tls === want) return client.status();

    client.tls = want;
    saveStored(loadStored().map((e) => (e.id === client.id ? { ...e, tls: want } : e)));
    if (!want) log.warn("host_tls_disabled", { hostId: client.id, name: client.name });
    else log.info("host_tls_enabled", { hostId: client.id, name: client.name });

    // The setting only takes effect on a new socket.
    client.stop();
    client.stopped = false;
    client.retryMs = 300;
    client.start();
    return client.status();
  }

  remove(hostId) {
    const client = this.client(hostId);
    if (client.local) throw new HostError("The local machine cannot be removed");
    const id = client.id;
    client.stop();
    this.clients.delete(id);
    for (const [sid, hid] of [...this.sessionHost]) if (hid === id) this.sessionHost.delete(sid);
    saveStored(loadStored().filter((e) => e.id !== id));
    log.info("host_removed", { hostId: id });
    this.emit("sessions", this.allSessions());
    return { ok: true };
  }

  /** Is anything listening there? Used before adding, to give a clear error. */
  probe({ address, port }) {
    const addr = validAddress(address);
    const p = Number(port) || config.ptyHostPort;
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: addr, port: p });
      const done = (reachable, error) => {
        try {
          sock.destroy();
        } catch {}
        resolve({ address: addr, port: p, reachable, error: error || "" });
      };
      sock.setTimeout(4000);
      sock.on("connect", () => done(true));
      sock.on("timeout", () => done(false, "Timed out"));
      sock.on("error", (err) => done(false, err.message));
    });
  }
}

module.exports = { HostRegistry, HostError, LOCAL_ALIAS, FILE, loadStored, saveStored, findSelf, ensureSelf };
