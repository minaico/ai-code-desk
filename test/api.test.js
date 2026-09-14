"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { Stack, WINDOWS, SHELL, SYSTEM_DIR } = require("./helpers");

test("HTTP API", { timeout: 120000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  t.after(() => stack.stop());

  await t.test("health is public", async () => {
    const res = await fetch(`${stack.base}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
  });

  await t.test("a machine can be renamed, including this one", async () => {
    await stack.login();
    const before = await stack.api("GET", "/api/hosts");
    assert.equal(before.status, 200);
    const local = before.body.hosts.find((h) => h.local);
    assert.ok(local, "the local machine is always in the list");
    // A real id, like every other machine: "local" names a different computer
    // depending on who reads it, so it is only ever an alias.
    assert.notEqual(local.id, "local");
    assert.ok(local.name, "every machine has a name, this one too");

    // The alias still resolves, for callers written before there were ids.
    const renamed = await stack.api("POST", "/api/hosts/local/rename", { name: "May chinh" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.host.name, "May chinh");
    assert.equal(renamed.body.host.id, local.id);
    assert.equal((await stack.api("GET", "/api/hosts")).body.hosts.find((h) => h.local).name, "May chinh");

    // Only the label changes: the address and the key are what make a machine
    // reachable, and changing those is adding a different machine.
    assert.equal(renamed.body.host.local, true);

    const empty = await stack.api("POST", "/api/hosts/local/rename", { name: "   " });
    assert.equal(empty.status, 400, "a machine with no name is a machine you cannot pick");
    const missing = await stack.api("POST", "/api/hosts/nope/rename", { name: "x" });
    assert.equal(missing.status, 404);

    // It has to outlive the process that was told about it.
    await stack.restartWeb();
    const after = (await stack.api("GET", "/api/hosts")).body.hosts.find((h) => h.local);
    assert.equal(after.name, "May chinh", "the new name survives a restart");
    assert.equal(after.id, local.id, "and so does the id - saved tabs point at it");
    await stack.api("POST", "/api/hosts/local/rename", { name: "This machine" });
    stack.token = "";
  });

  await t.test("protected routes reject anonymous callers", async () => {
    const res = await fetch(`${stack.base}/api/sessions`);
    assert.equal(res.status, 401);
  });

  await t.test("login rejects a wrong password", async () => {
    const r = await stack.login("definitely-wrong");
    assert.equal(r.status, 401);
  });

  await t.test("login succeeds and returns a token", async () => {
    const r = await stack.login();
    assert.equal(r.status, 200);
    assert.ok(r.body.token && r.body.token.length > 20);
  });

  await t.test("state-changing requests need the CSRF header", async () => {
    const res = await fetch(`${stack.base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `wt_token=${stack.token}` },
      body: "{}",
    });
    assert.equal(res.status, 403);
  });

  await t.test("profiles lists the shells present on this machine", async () => {
    const r = await stack.api("GET", "/api/profiles");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.shells) && r.body.shells.length > 0);
    assert.ok(r.body.launchers.some((l) => l.id === "claude"));
  });

  await t.test("file listing is scoped to the allowed root", async () => {
    fs.writeFileSync(path.join(stack.workDir, "hello.txt"), "xin chao");
    const r = await stack.api("GET", `/api/files?path=${encodeURIComponent(stack.workDir)}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.some((i) => i.name === "hello.txt"));
    assert.equal(r.body.isRoot, true);
  });

  await t.test("path traversal outside the roots is refused", async () => {
    const outside = path.join(stack.workDir, "..", "..", "..");
    const r = await stack.api("GET", `/api/files?path=${encodeURIComponent(outside)}`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /outside allowed roots|not found/i);
  });

  await t.test("an absolute escape to a system folder is refused", async () => {
    const r = await stack.api("GET", `/api/files?path=${encodeURIComponent(SYSTEM_DIR)}`);
    assert.equal(r.status, 400);
  });

  await t.test("download returns file bytes", async () => {
    const res = await fetch(
      `${stack.base}/api/download?path=${encodeURIComponent(path.join(stack.workDir, "hello.txt"))}`,
      { headers: { Authorization: `Bearer ${stack.token}` } }
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "xin chao");
  });

  await t.test("download refuses a path outside the roots", async () => {
    const outside = WINDOWS ? "C:\\Windows\\win.ini" : "/etc/hostname";
    const res = await fetch(`${stack.base}/api/download?path=${encodeURIComponent(outside)}`, {
      headers: { Authorization: `Bearer ${stack.token}` },
    });
    assert.equal(res.status, 400);
  });

  await t.test("upload writes into the chosen directory", async () => {
    const r = await stack.api(
      "POST",
      `/api/upload?path=${encodeURIComponent(stack.workDir)}`,
      Buffer.from("noi dung upload"),
      { "X-File-Name": encodeURIComponent("tài liệu.txt"), "Content-Type": "application/octet-stream" }
    );
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(r.body.path, "utf8"), "noi dung upload");
    assert.ok(r.body.path.startsWith(stack.workDir));
  });

  await t.test("upload cannot escape via a crafted file name", async () => {
    const r = await stack.api(
      "POST",
      `/api/upload?path=${encodeURIComponent(stack.workDir)}`,
      Buffer.from("x"),
      { "X-File-Name": encodeURIComponent("..\\..\\evil.txt"), "Content-Type": "application/octet-stream" }
    );
    assert.equal(r.status, 200);
    assert.ok(r.body.path.startsWith(stack.workDir), `escaped to ${r.body.path}`);
  });

  await t.test("mkdir / rename / delete round trip", async () => {
    let r = await stack.api("POST", "/api/files/mkdir", { path: stack.workDir, name: "thu-muc" });
    assert.equal(r.status, 200);
    r = await stack.api("POST", "/api/files/rename", { path: r.body.item.path, name: "thu-muc-2" });
    assert.equal(r.status, 200);
    assert.equal(path.basename(r.body.item.path), "thu-muc-2");
    r = await stack.api("POST", "/api/files/delete", { path: r.body.item.path });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(path.join(stack.workDir, "thu-muc-2")), false);
  });

  await t.test("delete refuses an allowed root itself", async () => {
    const r = await stack.api("POST", "/api/files/delete", { path: stack.workDir });
    assert.equal(r.status, 400);
    assert.ok(fs.existsSync(stack.workDir));
  });

  await t.test("dir picker lists the top of the filesystem when no path is given", async () => {
    const r = await stack.api("GET", "/api/dirs");
    assert.equal(r.status, 200);
    assert.equal(r.body.isDriveList, true);
    // Drives on Windows, the single root on POSIX - either way, somewhere to
    // start from rather than an empty list.
    assert.ok(r.body.items.length > 0);
    if (WINDOWS) assert.ok(r.body.items.some((i) => /^[A-Z]:\\$/i.test(i.name)));
  });

  await t.test("dir picker reaches folders outside the roots", async () => {
    const root = WINDOWS ? "C:\\" : "/";
    const r = await stack.api("GET", `/api/dirs?path=${encodeURIComponent(root)}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.length > 0);
    const blocked = path.basename(SYSTEM_DIR);
    assert.equal(
      r.body.items.some((i) => i.name.toLowerCase() === blocked.toLowerCase()),
      false,
      `${blocked} must not be offered as a place to start a terminal`
    );
  });

  await t.test("dir picker refuses a system folder", async () => {
    const r = await stack.api("GET", `/api/dirs?path=${encodeURIComponent(SYSTEM_DIR)}`);
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /system folder/i);
  });

  await t.test("dir picker lists no files, only folders", async () => {
    const fsx = require("fs");
    const px = require("path");
    fsx.writeFileSync(px.join(stack.workDir, "not-a-folder.txt"), "x");
    fsx.mkdirSync(px.join(stack.workDir, "a-folder"), { recursive: true });
    const r = await stack.api("GET", `/api/dirs?path=${encodeURIComponent(stack.workDir)}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.items.some((i) => i.name === "a-folder"));
    assert.equal(r.body.items.some((i) => i.name === "not-a-folder.txt"), false);
  });

  await t.test("dir picker requires authentication", async () => {
    const res = await fetch(`${stack.base}/api/dirs`);
    assert.equal(res.status, 401);
  });

  await t.test("git status reports a clear error outside a repository", async () => {
    const r = await stack.api("GET", `/api/git/status?cwd=${encodeURIComponent(stack.workDir)}`);
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /not a git repository/i);
  });

  await t.test("git status works inside a repository", async (tt) => {
    const { execFileSync } = require("child_process");
    try {
      execFileSync("git", ["init", "-q"], { cwd: stack.workDir, windowsHide: true });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: stack.workDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: stack.workDir });
    } catch {
      tt.skip("git is not installed");
      return;
    }
    const r = await stack.api("GET", `/api/git/status?cwd=${encodeURIComponent(stack.workDir)}`);
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.branch === "string");
    assert.ok(r.body.untracked >= 1);
  });

  await t.test("system diagnostics report the PTY host", async () => {
    const r = await stack.api("GET", "/api/system");
    assert.equal(r.status, 200);
    assert.equal(r.body.ptyHost.connected, true);
    assert.ok(r.body.web.pid > 0);
  });

  await t.test("unknown API routes return JSON 404", async () => {
    const r = await stack.api("GET", "/api/nope");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Not found");
  });

  await t.test("logout revokes the token", async () => {
    const token = stack.token;
    const r = await stack.api("POST", "/api/logout", {});
    assert.equal(r.status, 200);
    const after = await fetch(`${stack.base}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401);
    await stack.login();
  });
});
