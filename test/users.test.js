"use strict";
/**
 * Accounts, and the boundary between them.
 *
 * The interesting part is not that logging in works. It is that a session id —
 * which is not a secret, it appears in URLs and logs — is not enough to reach
 * somebody else's shell.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Stack, wait, SHELL } = require("./helpers");

const { Users } = require("../server/users");

/* ------------------------------------------------------------------ *
 * The store on its own
 * ------------------------------------------------------------------ */
test("the user store keeps its own rules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-users-"));
  try {
    const users = new Users(dir, console);
    assert.equal(users.enabled, false, "no file, no accounts: shared-password mode");

    users.create({ name: "lan.pt", password: "first-pass-1", role: "admin" });
    assert.equal(users.enabled, true);

    assert.throws(() => users.create({ name: "lan.pt", password: "another-pass" }), /đã tồn tại/);
    assert.throws(() => users.create({ name: "bao.nv", password: "short" }), /ít nhất/);
    assert.throws(() => users.create({ name: "bo", password: "long-enough-1" }), /Tên đăng nhập/);
    assert.throws(() => users.create({ name: "has space", password: "long-enough-1" }), /Tên đăng nhập/);

    assert.equal(users.verify("lan.pt", "first-pass-1").ok, true);
    assert.equal(users.verify("LAN.PT", "first-pass-1").ok, true, "names are not case sensitive");
    assert.equal(users.verify("lan.pt", "wrong").ok, false);
    assert.equal(users.verify("nobody", "first-pass-1").ok, false);

    // An account someone else set up arrives owing a password change.
    assert.equal(users.find("lan.pt").mustChange, true);
    users.setPassword("lan.pt", "chosen-by-me-1", { mustChange: false });
    assert.equal(users.find("lan.pt").mustChange, false);
    assert.equal(users.verify("lan.pt", "chosen-by-me-1").ok, true);

    // Nobody left who could hand the role back out.
    assert.throws(() => users.remove("lan.pt"), /cuối cùng/);
    assert.throws(() => users.setRole("lan.pt", "user"), /cuối cùng/);

    // A second admin makes both removable again.
    users.create({ name: "an.nv", password: "second-pass-1", role: "admin" });
    assert.equal(users.remove("an.nv"), "an.nv");

    // The hash is never handed out.
    assert.equal(users.list().some((u) => "hash" in u), false);

    // It survives a reload, which is the whole point of writing the file.
    const again = new Users(dir, console);
    assert.equal(again.verify("lan.pt", "chosen-by-me-1").ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * The boundary, over a real server
 * ------------------------------------------------------------------ */
test("one account cannot reach another account's terminal", { timeout: 90000 }, async (t) => {
  const stack = await new Stack({
    users: [
      { name: "alice", password: "alice-pass-1" },
      { name: "bob", password: "bob-pass-1" },
      { name: "root", password: "root-pass-1", role: "admin" },
    ],
  }).start();
  t.after(() => stack.stop());

  let aliceSession = null;

  await t.test("the shared password stops working once accounts exist", async () => {
    const r = await stack.login(stack.password);
    assert.equal(r.status, 401);
  });

  await t.test("alice logs in and opens a terminal", async () => {
    const r = await stack.login({ username: "alice", password: "alice-pass-1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.name, "alice");
    assert.equal(r.body.user.mustChange, false);

    const created = await stack.api("POST", "/api/sessions", { shell: SHELL, title: "Alice" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    aliceSession = created.body.session.id;
    assert.equal(created.body.session.owner, "alice", "the session records who opened it");
  });

  await t.test("bob does not see it, and cannot touch it by id", async () => {
    await stack.as({ username: "bob", password: "bob-pass-1" }, async () => {
      const list = await stack.api("GET", "/api/sessions");
      assert.equal(list.status, 200);
      assert.equal(
        list.body.sessions.some((s) => s.id === aliceSession),
        false,
        "another account's terminal is not in the list"
      );

      // Knowing the id must not be enough.
      for (const [method, url] of [
        ["POST", `/api/sessions/${aliceSession}/kill`],
        ["POST", `/api/sessions/${aliceSession}/rename`],
        ["POST", `/api/sessions/${aliceSession}/attach`],
        ["DELETE", `/api/sessions/${aliceSession}`],
      ]) {
        const r = await stack.api(method, url, { title: "stolen" });
        assert.equal(r.status, 403, `${method} ${url} should be refused, got ${r.status}`);
      }
    });
  });

  await t.test("alice sees her terminal again when she logs back in", async () => {
    const r = await stack.login({ username: "alice", password: "alice-pass-1" });
    assert.equal(r.status, 200);
    const list = await stack.api("GET", "/api/sessions");
    const mine = list.body.sessions.find((s) => s.id === aliceSession);
    assert.ok(mine, "her own session is waiting for her");
    assert.equal(mine.title, "Alice");
  });

  await t.test("an admin sees every terminal", async () => {
    await stack.as({ username: "root", password: "root-pass-1" }, async () => {
      const list = await stack.api("GET", "/api/sessions");
      assert.ok(
        list.body.sessions.some((s) => s.id === aliceSession),
        "an admin has to be able to see what is running on the machine"
      );
    });
  });

  await t.test("only an admin may manage accounts", async () => {
    await stack.as({ username: "bob", password: "bob-pass-1" }, async () => {
      assert.equal((await stack.api("GET", "/api/users")).status, 403);
      assert.equal((await stack.api("POST", "/api/users", { name: "x.y", password: "aaaaaaaa" })).status, 403);
    });
    await stack.as({ username: "root", password: "root-pass-1" }, async () => {
      const list = await stack.api("GET", "/api/users");
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.body.users.map((u) => u.name).sort(),
        ["alice", "bob", "root"]
      );
    });
  });
});

test("a token from before accounts existed stops working", { timeout: 90000 }, async (t) => {
  // Turning accounts on is not a migration anyone performs twice, but it is the
  // one moment where the old world and the new one overlap: tokens issued under
  // the shared password stay signed and unexpired. They name nobody, so every
  // ownership check would wave them through for want of a name to compare.
  const stack = await new Stack().start();
  t.after(() => stack.stop());

  const before = await stack.login(stack.password);
  assert.equal(before.status, 200, "shared password works while there are no accounts");
  const legacyToken = before.body.token;
  assert.equal((await stack.api("GET", "/api/sessions")).status, 200);

  // Create the first account the way scripts/user.js does, then restart the web
  // server so it reads the file.
  const { hashPassword } = require("../server/users");
  fs.writeFileSync(
    path.join(stack.dataDir, "users.json"),
    JSON.stringify([
      { name: "lan.pt", hash: hashPassword("chosen-pass-1"), role: "admin", mustChange: false },
    ])
  );
  await stack.restartWeb();

  stack.token = legacyToken;
  assert.equal((await stack.api("GET", "/api/sessions")).status, 401, "the anonymous token is dead");
  assert.equal((await stack.api("GET", "/api/config")).body.authenticated, false);
  assert.equal((await stack.api("GET", "/api/files?path=.")).status, 401, "and not just for sessions");

  assert.equal((await stack.login(stack.password)).status, 401, "so is the shared password");
  assert.equal((await stack.login({ username: "lan.pt", password: "chosen-pass-1" })).status, 200);
});

test("a first login can do nothing but choose a password", { timeout: 90000 }, async (t) => {
  const stack = await new Stack({
    users: [{ name: "lan.pt", password: "temp-pass-1", role: "admin", mustChange: true }],
  }).start();
  t.after(() => stack.stop());

  const r = await stack.login({ username: "lan.pt", password: "temp-pass-1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.mustChange, true);

  // Authenticated, and still not allowed to do anything else. Otherwise "must
  // change on first login" is a dialog rather than a rule.
  const blocked = await stack.api("GET", "/api/sessions");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.mustChange, true);

  const wrong = await stack.api("POST", "/api/password", { current: "not-it", next: "chosen-pass-1" });
  assert.equal(wrong.status, 401);

  const tooShort = await stack.api("POST", "/api/password", { current: "temp-pass-1", next: "short" });
  assert.equal(tooShort.status, 400);

  const ok = await stack.api("POST", "/api/password", { current: "temp-pass-1", next: "chosen-pass-1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.mustChange, false);
  stack.token = ok.body.token;

  const allowed = await stack.api("GET", "/api/sessions");
  assert.equal(allowed.status, 200, "with a password of their own, the account works");

  // The temporary password is gone for good.
  assert.equal((await stack.login({ username: "lan.pt", password: "temp-pass-1" })).status, 401);
  assert.equal((await stack.login({ username: "lan.pt", password: "chosen-pass-1" })).status, 200);

  await wait(50);
});
