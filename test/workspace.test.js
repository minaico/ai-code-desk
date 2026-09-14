"use strict";
/**
 * The workspace: which terminals were open, and putting them back.
 *
 * The case this exists for is the one that cannot be tested by being careful —
 * the machine loses power. Every shell dies. What has to survive is enough
 * information to open the same tabs again, and it has to survive in a form that
 * does not depend on session ids, because those are exactly what a restart
 * throws away.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Stack, SHELL } = require("./helpers");
const { Workspaces } = require("../server/workspace");

test("the workspace store keeps one layout per account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-ws-"));
  try {
    const ws = new Workspaces(dir, console);
    assert.deepEqual(ws.get({ name: "alice" }).tabs, []);

    ws.set({ name: "alice" }, { tabs: [{ lineage: "l1", hostId: "local", title: "A" }], activeIndex: 0 });
    ws.set({ name: "bob" }, { tabs: [{ lineage: "l2", hostId: "local", title: "B" }], activeIndex: 0 });

    assert.equal(ws.get({ name: "alice" }).tabs[0].title, "A");
    assert.equal(ws.get({ name: "bob" }).tabs[0].title, "B");
    assert.equal(ws.get({ name: "ALICE" }).tabs[0].title, "A", "names are not case sensitive");

    // Junk in, nothing out: a tab with no identity cannot be restored, so it is
    // not worth storing.
    ws.set({ name: "alice" }, { tabs: [{ title: "no id" }, null, "nope"], activeIndex: 9 });
    assert.deepEqual(ws.get({ name: "alice" }).tabs, []);
    assert.equal(ws.get({ name: "alice" }).activeIndex, -1, "an index past the end is no index");

    // It is a file, not a memory: that is the whole point.
    ws.set({ name: "alice" }, { tabs: [{ lineage: "l1", title: "A" }], activeIndex: 0 });
    ws.flush();
    const again = new Workspaces(dir, console);
    assert.equal(again.get({ name: "alice" }).tabs[0].lineage, "l1");
    ws.flush();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a workspace outlives the terminals it describes", { timeout: 120000 }, async (t) => {
  const stack = await new Stack({
    users: [{ name: "lan.pt", password: "chosen-pass-1", role: "admin" }],
  }).start();
  t.after(() => stack.stop());

  await stack.login({ username: "lan.pt", password: "chosen-pass-1" });

  const open = async (title) => {
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, title });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.session;
  };
  const alpha = await open("Alpha");
  const beta = await open("Beta");
  assert.ok(alpha.lineage, "a session knows its own lineage");

  const asTab = (s) => ({
    lineage: s.lineage,
    entryId: s.id,
    hostId: s.hostId || "local",
    title: s.title,
    shell: s.shell,
    cwd: s.cwd,
  });

  await t.test("what the browser saves comes back", async () => {
    const put = await stack.api("PUT", "/api/workspace", {
      tabs: [asTab(alpha), asTab(beta)],
      activeIndex: 1,
    });
    assert.equal(put.status, 200);

    const got = await stack.api("GET", "/api/workspace");
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.tabs.map((x) => x.title), ["Alpha", "Beta"]);
    assert.deepEqual(got.body.tabs.map((x) => x.state), ["live", "live"]);
    assert.equal(got.body.activeIndex, 1);
  });

  await t.test("the machine goes down and every tab becomes restorable", async () => {
    for (const s of [alpha, beta]) {
      const r = await stack.api("DELETE", `/api/sessions/${s.id}`);
      assert.equal(r.status, 200);
    }
    const list = await stack.api("GET", "/api/sessions");
    assert.equal(list.body.sessions.length, 0, "nothing is running");

    const got = await stack.api("GET", "/api/workspace");
    assert.deepEqual(got.body.tabs.map((x) => x.state), ["restorable", "restorable"]);
  });

  let restoredIds = [];

  await t.test("restore opens them again, in the same folders", async () => {
    const r = await stack.api("POST", "/api/workspace/restore", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.failed.length, 0, JSON.stringify(r.body.failed));
    assert.equal(r.body.restored.length, 2);
    assert.equal(r.body.restored.every((x) => x.reused === false), true, "both had to be reopened");

    const list = await stack.api("GET", "/api/sessions");
    const titles = list.body.sessions.map((s) => s.title).sort();
    assert.deepEqual(titles, ["Alpha", "Beta"]);
    restoredIds = list.body.sessions.map((s) => s.id).sort();

    // New sessions, same terminals.
    assert.equal(restoredIds.includes(alpha.id), false, "a restored terminal is a new session");
    const lineages = list.body.sessions.map((s) => s.lineage).sort();
    assert.deepEqual(lineages, [alpha.lineage, beta.lineage].sort(), "but the same lineage");
  });

  await t.test("restoring twice does not open anything twice", async () => {
    const r = await stack.api("POST", "/api/workspace/restore", {});
    assert.equal(r.status, 200);
    assert.equal(r.body.restored.every((x) => x.reused === true), true, "already-running tabs are left alone");

    const list = await stack.api("GET", "/api/sessions");
    assert.deepEqual(list.body.sessions.map((s) => s.id).sort(), restoredIds, "no duplicates");
  });

  await t.test("a killed terminal is not 'live', and restore restarts it", async () => {
    const list = await stack.api("GET", "/api/sessions");
    const victim = list.body.sessions.find((s) => s.title === "Alpha");
    assert.ok(victim);

    const killed = await stack.api("POST", `/api/sessions/${victim.id}/kill`);
    assert.equal(killed.status, 200);

    // A killed session stays listed for half an hour so Restart can be offered.
    // Reading that as "live" is what left the Restore button with nothing to do.
    const got = await stack.api("GET", "/api/workspace");
    const alphaTab = got.body.tabs.find((x) => x.title === "Alpha");
    assert.equal(alphaTab.state, "exited", "listed but not running");

    const r = await stack.api("POST", "/api/workspace/restore", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const back = r.body.restored.find((x) => x.title === "Alpha");
    assert.equal(back.restarted, true, "restarted in place, not reopened as a second row");
    assert.equal(back.sessionId, victim.id, "same session, same tab");

    // restartSession spawns after a short delay so the old pty is fully gone.
    let state = "";
    for (let i = 0; i < 20 && state !== "live"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const after = await stack.api("GET", "/api/workspace");
      state = after.body.tabs.find((x) => x.title === "Alpha").state;
    }
    assert.equal(state, "live");
  });

  await t.test("the whole machine goes down and comes back", async () => {
    // The case this feature exists for. Restarting the PTY host is what a
    // reboot does to sessions: every shell is gone, the files are not.
    const saved = await stack.api("GET", "/api/workspace");
    assert.equal(saved.body.tabs.length, 2);

    await new Promise((resolve) => {
      stack.host.once("exit", resolve);
      stack.host.kill();
    });
    // Neither platform frees the port the instant the process dies, and a host
    // that cannot bind exits immediately and silently. Wait for the port rather
    // than for a number someone guessed.
    const net = require("net");
    const portFree = () =>
      new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(stack.hostPort, "127.0.0.1", () => probe.close(() => resolve(true)));
      });
    for (let i = 0; i < 40 && !(await portFree()); i++) await new Promise((r) => setTimeout(r, 250));
    stack.host = stack.spawnProc("pty-host.js");
    // Wait for the machine to be answering again, not merely for time to pass:
    // history coming back is the precondition for anything being restorable.
    for (let i = 0; i < 60; i++) {
      const h = await stack.api("GET", "/api/history");
      if (h.status === 200 && (h.body.entries || []).length) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const live = await stack.api("GET", "/api/sessions");
    assert.equal(live.body.sessions.length, 0, "a reboot leaves no shells behind");

    const got = await stack.api("GET", "/api/workspace");
    assert.deepEqual(
      got.body.tabs.map((x) => x.state),
      ["restorable", "restorable"],
      "but the tabs are still described, and still openable"
    );

    const r = await stack.api("POST", "/api/workspace/restore", {});
    assert.equal(r.body.failed.length, 0, JSON.stringify(r.body.failed));
    const list = await stack.api("GET", "/api/sessions");
    assert.deepEqual(list.body.sessions.map((s) => s.title).sort(), ["Alpha", "Beta"]);
    assert.deepEqual(
      list.body.sessions.map((s) => s.cwd).sort(),
      [alpha.cwd, beta.cwd].sort(),
      "in the folders they were in"
    );
  });

  await t.test("one account's tabs are not another's", async () => {
    await stack.as({ username: "lan.pt", password: "chosen-pass-1" }, async () => {});
    // A second account starts with nothing saved, even on the same machine.
    const admin = stack.token;
    const created = await stack.api("POST", "/api/users", { name: "an.nv", password: "second-pass-1" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await stack.api("POST", "/api/users/an.nv/password", { password: "second-pass-1" });

    await stack.as({ username: "an.nv", password: "second-pass-1" }, async () => {
      // A brand-new account owes a password change, so it cannot read anything.
      const blocked = await stack.api("GET", "/api/workspace");
      assert.equal(blocked.status, 403);
      const changed = await stack.api("POST", "/api/password", {
        current: "second-pass-1",
        next: "an-chosen-pass-1",
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      stack.token = changed.body.token;

      const mine = await stack.api("GET", "/api/workspace");
      assert.equal(mine.status, 200);
      assert.deepEqual(mine.body.tabs, [], "a new account has no tabs to restore");
    });
    stack.token = admin;
  });
});
