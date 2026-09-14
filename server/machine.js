"use strict";
/**
 * Who this computer is, independent of which one runs the web server.
 *
 * Every machine in a group is listed the same way in `.data/hosts.json` - id,
 * name, address, port, key - and that file is meant to be carried from one
 * machine to another: copy it to machine 42 and 42 becomes the one serving the
 * UI, with this machine as one of its remotes. For that to work, each machine
 * has to be able to find *itself* in a list it did not write.
 *
 * So the identity is read from the operating system, not from `.data`:
 * Windows' MachineGuid, systemd's machine-id. A file in `.data` would travel
 * with the copy, and the machine it landed on would take the other one's place.
 */
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

function osMachineId() {
  // Tests run two PTY hosts on one computer and need them to be two machines.
  if (process.env.WEB_TERMINAL_MACHINE_ID) return process.env.WEB_TERMINAL_MACHINE_ID;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
      if (m) return m[1];
    } else {
      for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const v = fs.readFileSync(file, "utf8").trim();
          if (v) return v;
        } catch {}
      }
    }
  } catch {}
  // Unique enough on one LAN, and still not something a copied file can carry.
  return `host:${os.hostname()}`;
}

let cached = "";

/** Short, stable, not reversible to the raw OS id. */
function machineId() {
  if (!cached) {
    cached = crypto.createHash("sha256").update(`web-terminal:${osMachineId()}`).digest("hex").slice(0, 12);
  }
  return cached;
}

/** What the PTY host tells whoever connects to it. */
function machineInfo() {
  return { id: machineId(), hostname: os.hostname(), platform: process.platform };
}

/** "::ffff:192.168.1.5" is how Node reports an IPv4 peer on a dual-stack socket. */
function plainAddress(address) {
  return String(address || "").replace(/^::ffff:/i, "");
}

/**
 * A first guess at the address other machines reach this one by, for a machine
 * that has not connected to anyone yet. Once it has, the registry replaces this
 * with the address the operating system actually routed that connection from.
 */
function guessLanAddress() {
  // VPN adapters (ZeroTier, Tailscale) are not in this list on purpose: they
  // are often exactly the link between the machines.
  const virtual = /vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback/i;
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== "IPv4" || net.internal || net.address.startsWith("169.254.")) continue;
      candidates.push({ name, address: net.address, virtual: virtual.test(name) });
    }
  }
  const real = candidates.find((c) => !c.virtual) || candidates[0];
  return real ? real.address : "";
}

module.exports = { machineId, machineInfo, plainAddress, guessLanAddress };
