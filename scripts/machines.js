#!/usr/bin/env node
"use strict";
/**
 * The machine group, and moving the main role from one machine to another.
 *
 * Every machine is an equal entry in .data/hosts.json. "Main" is only the one
 * running the web server, and it finds itself in that list at startup - so to
 * make machine 42 the main one, 42 needs the same list, plus the accounts and
 * the saved tabs that go with it:
 *
 *   node scripts/machines.js                     list the group, mark this machine
 *   node scripts/machines.js export [file]       on the current main machine
 *   node scripts/machines.js import <file>       on the machine that takes over
 *
 * then scripts\resume.ps1 on the new main machine.
 *
 * What is deliberately NOT carried: host.key (each machine's own key - copying
 * it would make two machines answer to one key) and secret.key (it signs login
 * cookies, which belong to one address anyway).
 *
 * The export file holds the key of every machine in it. Treat it like a
 * password and delete it once imported.
 */
const fs = require("fs");
const net = require("net");
const path = require("path");

const { config, ensureDataDir } = require("../server/config");
const { FILE, loadStored, saveStored, findSelf, ensureSelf } = require("../server/hosts");
const { Workspaces } = require("../server/workspace");

const KIND = "web-terminal-group";
const USERS_FILE = path.join(config.dataDir, "users.json");
const WORKSPACES_FILE = path.join(config.dataDir, "workspaces.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The list as the server would see it: this machine present and accurate. */
function currentGroup() {
  const stored = loadStored();
  const before = JSON.stringify(stored);
  const index = ensureSelf(stored);
  if (JSON.stringify(stored) !== before) saveStored(stored);
  return { stored, self: stored[index] };
}

function serverRunningHere() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: config.port });
    const done = (yes) => {
      sock.destroy();
      resolve(yes);
    };
    sock.setTimeout(1500);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

function printGroup(stored, selfId) {
  stored.forEach((e, i) => {
    const mark = e.id === selfId ? "*" : " ";
    console.log(`${mark} ${i + 1}. ${e.name}  [${e.id}]  ${e.address || "?"}:${e.port}${e.key ? "" : "  (thiếu key)"}`);
  });
  console.log("");
  console.log("* = máy này. Hình trên tab theo thứ tự trên: 1 tròn, 2 tam giác, 3 vuông...");
}

function list() {
  const { stored, self } = currentGroup();
  console.log(`Nhóm máy trong ${FILE}:`);
  console.log("");
  printGroup(stored, self.id);
  if (config.ptyHostBind === "127.0.0.1" && stored.length > 1) {
    console.log("");
    console.log("Lưu ý: PTY_HOST_BIND chưa đặt, nhưng scripts\\resume.ps1 tự mở PTY host ra LAN khi nhóm");
    console.log("có từ 2 máy trở lên. Chạy PTY host bằng cách khác thì các máy kia không tới được máy này.");
  }
}

function exportGroup(target) {
  ensureDataDir();
  const { stored, self } = currentGroup();
  // Loading rewrites tabs saved as "local" to this machine's id - the step
  // that makes the file mean the same thing on another computer.
  new Workspaces(config.dataDir, null, { localHostId: self.id });

  const bundle = {
    kind: KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedFrom: self.name,
    hosts: stored,
    users: readJson(USERS_FILE),
    workspaces: readJson(WORKSPACES_FILE),
  };
  const file = path.resolve(target || path.join(config.dataDir, "web-terminal-group.json"));
  writeJson(file, bundle);

  console.log(`Đã xuất ${stored.length} máy, ${(bundle.users || []).length} tài khoản, ` +
    `${Object.keys(bundle.workspaces || {}).length} phiên làm việc:`);
  console.log(`  ${file}`);
  console.log("");
  printGroup(stored, self.id);
  console.log("");
  console.log("File này chứa key của mọi máy trong nhóm - chép qua đường tin cậy rồi xoá đi.");
  console.log("Trên máy sẽ làm máy chính:");
  console.log("  node scripts/machines.js import <đường dẫn tới file này>");
  console.log("  .\\scripts\\resume.ps1");
}

async function importGroup(source, force) {
  if (!source) throw new Error("Cần đường dẫn tới file export: node scripts/machines.js import <file>");
  const bundle = readJson(path.resolve(source));
  if (!bundle || bundle.kind !== KIND || !Array.isArray(bundle.hosts)) {
    throw new Error(`${source} không phải file export của web terminal`);
  }

  // A running server holds the tabs in memory and writes them back on the next
  // change, which would quietly undo this import.
  if (!force && (await serverRunningHere())) {
    throw new Error(
      `Web server đang chạy ở cổng ${config.port} trên máy này. Dừng nó trước ` +
        "(.\\scripts\\stop-service.ps1), hoặc thêm --force nếu biết mình đang làm gì."
    );
  }

  ensureDataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const file of [FILE, USERS_FILE, WORKSPACES_FILE]) {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.before-import-${stamp}`);
  }

  const hosts = bundle.hosts.filter((e) => e && e.id);
  const found = findSelf(hosts);
  const index = ensureSelf(hosts);
  saveStored(hosts);
  if (bundle.users) writeJson(USERS_FILE, bundle.users);
  if (bundle.workspaces) writeJson(WORKSPACES_FILE, bundle.workspaces);

  const self = hosts[index];
  console.log(`Đã nhập nhóm từ "${bundle.exportedFrom || "?"}" (${bundle.exportedAt || "?"}).`);
  console.log("");
  printGroup(hosts, self.id);
  console.log("");
  if (found >= 0) {
    console.log(`Máy này là "${self.name}" - khởi động web server ở đây thì nó là máy chính.`);
  } else {
    console.log(`Máy này chưa có trong nhóm nên được thêm vào với tên "${self.name}".`);
    console.log("Các máy còn lại chưa biết key của nó; đổi tên được trong panel Máy.");
  }
  console.log("Bản cũ (nếu có) được giữ lại với đuôi .before-import-" + stamp);
  console.log("");
  console.log("Tiếp theo: .\\scripts\\resume.ps1   (hoặc -Restart nếu PTY host đang chạy bản cũ)");
  console.log("Các máy khác trong nhóm cần PTY host nghe trên LAN (resume.ps1 tự làm) và mở");
  console.log(`cổng ${config.ptyHostPort} ở firewall, để máy chính mới tới được chúng.`);
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const force = [arg, ...rest].includes("--force");
  const value = arg === "--force" ? rest.find((x) => x !== "--force") : arg;
  switch (cmd || "list") {
    case "list":
      return list();
    case "export":
      return exportGroup(value);
    case "import":
      return importGroup(value, force);
    default:
      console.log("node scripts/machines.js [list | export [file] | import <file> [--force]]");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
