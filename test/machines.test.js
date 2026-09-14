"use strict";
/**
 * Moving the main role: export the group on one machine, import it on another,
 * and the other one must find itself in the list and take over.
 *
 * Two machines are simulated by two data directories, two keys and two
 * machine ids - the same three things that tell real machines apart.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { execFile } = require("child_process");
const { freePort } = require("./helpers");

const SCRIPT = path.join(__dirname, "..", "scripts", "machines.js");

function run(machine, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: {
          ...process.env,
          WEB_TERMINAL_DATA: machine.dir,
          WEB_TERMINAL_MACHINE_ID: machine.osId,
          PORT: String(machine.port),
          PTY_HOST_PORT: "8777",
          WEB_TERMINAL_LOG_CONSOLE: "0",
        },
        windowsHide: true,
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, stdout, stderr })
    );
  });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the main role moves with the exported group", { timeout: 60000 }, async (t) => {
  const make = async (name, keyChar) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wt-${name}-`));
    fs.writeFileSync(path.join(dir, "host.key"), keyChar.repeat(64));
    return { dir, osId: `os-${name}`, key: keyChar.repeat(64), port: await freePort() };
  };
  const here = await make("here", "a");
  const m42 = await make("m42", "b");
  const bundle = path.join(os.tmpdir(), `wt-group-${Date.now()}.json`);
  t.after(() => {
    for (const p of [here.dir, m42.dir, bundle]) fs.rmSync(p, { recursive: true, force: true });
  });

  // The state this machine is in today: 42 added as a remote before machines
  // reported their ids, and tabs saved under the old "local" alias.
  fs.writeFileSync(
    path.join(here.dir, "hosts.json"),
    JSON.stringify([{ id: "21f80dc71c", name: "Máy 42", address: "192.168.192.42", port: 8777, key: m42.key }])
  );
  fs.writeFileSync(path.join(here.dir, "local-name.txt"), "Máy 231");
  fs.writeFileSync(
    path.join(here.dir, "workspaces.json"),
    JSON.stringify({ thanh: { tabs: [{ lineage: "l1", hostId: "local" }, { lineage: "l2", hostId: "21f80dc71c" }] } })
  );
  fs.writeFileSync(path.join(here.dir, "users.json"), JSON.stringify([{ name: "thanh", hash: "x", role: "admin" }]));

  let selfId;

  await t.test("export puts this machine in the list, named", async () => {
    const r = await run(here, ["export", bundle]);
    assert.equal(r.code, 0, r.stderr);
    const b = readJson(bundle);
    assert.equal(b.hosts.length, 2);
    const self = b.hosts[0];
    selfId = self.id;
    assert.equal(self.name, "Máy 231", "the name it already had is kept");
    assert.equal(self.key, here.key, "42 needs this key to reach this machine");
    assert.equal(fs.existsSync(path.join(here.dir, "local-name.txt")), false, "one place for a name, not two");
    // Tabs name machines by id now, so they mean the same thing on 42.
    assert.deepEqual(b.workspaces.thanh.tabs.map((x) => x.hostId), [selfId, "21f80dc71c"]);
    assert.equal(b.users[0].name, "thanh");
  });

  await t.test("import refuses while a web server is running there", async () => {
    const server = net.createServer().listen(m42.port, "127.0.0.1");
    await new Promise((res) => server.once("listening", res));
    try {
      const r = await run(m42, ["import", bundle]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /đang chạy/);
      assert.equal(fs.existsSync(path.join(m42.dir, "hosts.json")), false, "nothing written");
    } finally {
      server.close();
    }
  });

  await t.test("on 42, the list is the same list - and 42 is the main machine", async () => {
    const r = await run(m42, ["import", bundle]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Máy này là "Máy 42"/);

    const hosts = readJson(path.join(m42.dir, "hosts.json"));
    assert.deepEqual(hosts.map((h) => h.id), [selfId, "21f80dc71c"], "same ids, same order, same shapes");
    const self = hosts.find((h) => h.id === "21f80dc71c");
    assert.equal(self.key, m42.key);
    assert.ok(self.machineId, "found by its key, then given its id");
    assert.equal(hosts.find((h) => h.id === selfId).key, here.key, "this machine is now a remote of 42");

    // 42 keeps its own key; carrying it would make two machines answer to one.
    assert.equal(fs.readFileSync(path.join(m42.dir, "host.key"), "utf8"), m42.key);
    assert.equal(readJson(path.join(m42.dir, "workspaces.json")).thanh.tabs.length, 2);
    assert.equal(readJson(path.join(m42.dir, "users.json"))[0].name, "thanh");

    const list = await run(m42, ["list"]);
    assert.match(list.stdout, /\* 2\. Máy 42/);
    assert.match(list.stdout, /  1\. Máy 231/);
  });

  await t.test("and back again, nothing is lost or duplicated", async () => {
    const back = path.join(os.tmpdir(), `wt-group-back-${Date.now()}.json`);
    t.after(() => fs.rmSync(back, { force: true }));
    assert.equal((await run(m42, ["export", back])).code, 0);
    const r = await run(here, ["import", back]);
    assert.equal(r.code, 0, r.stderr);
    const hosts = readJson(path.join(here.dir, "hosts.json"));
    assert.deepEqual(hosts.map((h) => h.id), [selfId, "21f80dc71c"]);
    assert.match((await run(here, ["list"])).stdout, /\* 1\. Máy 231/);
  });
});
