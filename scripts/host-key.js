#!/usr/bin/env node
"use strict";
/**
 * Prints this machine's PTY host key, needed to add it as a remote machine on
 * another Web Terminal.
 *
 *   node scripts/host-key.js
 *
 * The key lives in .data/host.key and is created on first run. Anyone holding
 * it can open terminals on this machine, so treat it like a password: copy it
 * over a trusted channel and keep the PTY host on a LAN or VPN.
 */
const os = require("os");
const { config, hostKey } = require("../server/config");

const key = hostKey();

function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      out.push({ name, address: net.address });
    }
  }
  return out;
}

if (!process.stdout.isTTY) {
  process.stdout.write(key);
} else {
  console.log("");
  console.log("PTY host key for this machine:");
  console.log("");
  console.log("  " + key);
  console.log("");
  console.log(`Port: ${config.ptyHostPort}   Bind: ${config.ptyHostBind}`);
  if (config.ptyHostBind === "127.0.0.1") {
    console.log("");
    console.log("This host only listens on localhost, so other machines cannot reach it yet.");
    console.log("Start it so the LAN can:");
    console.log("");
    if (process.platform === "win32") {
      console.log('  [Environment]::SetEnvironmentVariable("PTY_HOST_BIND","0.0.0.0","Machine")');
      console.log("  # then restart the PTY host");
    } else {
      console.log("  ./scripts/start-remote-host.sh");
    }
  }
  const addresses = localAddresses();
  if (addresses.length) {
    console.log("");
    console.log("Reachable at:");
    for (const a of addresses) console.log(`  ${a.address}:${config.ptyHostPort}   (${a.name})`);
  }
  console.log("");
  console.log("On the other machine: Settings -> Máy -> Thêm máy, and paste the key.");
  console.log("The link is authenticated but NOT encrypted - use it on a trusted LAN or a VPN.");
  console.log("");
}
