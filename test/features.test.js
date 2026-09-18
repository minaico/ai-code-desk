"use strict";
/** Session history, agent transcripts, and multi-machine routing. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Stack, wait, freePort, SHELL, CWD_SHELL, WINDOWS } = require("./helpers");

test("Session history", { timeout: 120000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  await stack.login();
  t.after(() => stack.stop());

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-hist-"));
  t.after(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  });

  let sessionId;
  let entryId;

  await t.test("a new session appears in the history", async () => {
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, title: "Lich su", cwd: workDir });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    sessionId = r.body.session.id;

    const h = await stack.api("GET", "/api/history");
    assert.equal(h.status, 200);
    const entry = h.body.entries.find((e) => e.id === sessionId);
    assert.ok(entry, "the session must be in the history");
    assert.equal(entry.title, "Lich su");
    assert.equal(entry.shell, SHELL);
    assert.equal(entry.status, "running");
    const self = (await stack.api("GET", "/api/hosts")).body.hosts.find((h) => h.local);
    assert.equal(entry.hostId, self.id);
    entryId = entry.id;
  });

  await t.test("history survives deleting the session", async () => {
    await stack.api("DELETE", `/api/sessions/${sessionId}`);
    await wait(600);
    const sessions = (await stack.api("GET", "/api/sessions")).body.sessions;
    assert.equal(sessions.some((s) => s.id === sessionId), false, "session is gone");

    const h = await stack.api("GET", "/api/history");
    const entry = h.body.entries.find((e) => e.id === entryId);
    assert.ok(entry, "but the history entry stays");
    assert.equal(entry.status, "closed");
    assert.ok(entry.closedAt);
    assert.equal(entry.cwd.toLowerCase(), fs.realpathSync.native(workDir).toLowerCase());
  });

  await t.test("history survives a web server restart", async () => {
    await stack.restartWeb();
    const h = await stack.api("GET", "/api/history");
    assert.ok(h.body.entries.some((e) => e.id === entryId));
  });

  await t.test("reopening restores the shell and the directory it closed in", async () => {
    const r = await stack.api("POST", `/api/history/${entryId}/reopen`, { hostId: "local" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.restoredCwd, true);
    assert.equal(r.body.session.shell, SHELL);
    assert.equal(r.body.session.title, "Lich su");
    assert.equal(r.body.session.cwd.toLowerCase(), fs.realpathSync.native(workDir).toLowerCase());
    assert.notEqual(r.body.session.id, entryId, "reopening starts a fresh session");
    await stack.api("DELETE", `/api/sessions/${r.body.session.id}`);
  });

  await t.test("reopening falls back when the directory is gone", async () => {
    const doomed = fs.mkdtempSync(path.join(os.tmpdir(), "wt-gone-"));
    const created = await stack.api("POST", "/api/sessions", { shell: SHELL, cwd: doomed, title: "Mat thu muc" });
    assert.equal(created.status, 201);
    const id = created.body.session.id;
    await stack.api("DELETE", `/api/sessions/${id}`);
    await wait(600);
    fs.rmSync(doomed, { recursive: true, force: true });

    const r = await stack.api("POST", `/api/history/${id}/reopen`, { hostId: "local" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.restoredCwd, false, "it must say the directory could not be restored");
    assert.notEqual(r.body.session.cwd.toLowerCase(), doomed.toLowerCase());
    await stack.api("DELETE", `/api/sessions/${r.body.session.id}`);
  });

  await t.test("a history entry can be removed", async () => {
    const r = await stack.api("DELETE", `/api/history/${entryId}?hostId=local`);
    assert.equal(r.status, 200);
    const h = await stack.api("GET", "/api/history");
    assert.equal(h.body.entries.some((e) => e.id === entryId), false);
  });

  await t.test("history is refused without authentication", async () => {
    const res = await fetch(`${stack.base}/api/history`);
    assert.equal(res.status, 401);
  });
});

test("Agent transcript", { timeout: 120000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  await stack.login();
  t.after(() => stack.stop());

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-agent-"));
  t.after(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test("typing an agent command starts a transcript in that folder", async () => {
    const WebSocket = require("ws");
    // A stand-in agent, not the real one. Detection is on the command line the
    // user submits, so a line that merely mentions the name is recognised
    // exactly like `claude` itself - and unlike the real thing this is the same
    // program on every machine: it reads a line, answers it, and leaves on a
    // word. Running the real agent made this test depend on whether it happened
    // to be installed on the machine, and on how fast it started.
    const fake = WINDOWS
      ? `& { while($true){ $l = Read-Host; if($l -eq 'thoat'){ break }; "tra loi: $l" } } # claude`
      : `while read l; do [ "$l" = thoat ] && break; echo "tra loi: $l"; done # claude`;
    const created = await stack.api("POST", "/api/sessions", { shell: CWD_SHELL, cwd: workDir, title: "Agent" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.session.id;
    const agentNow = async () => {
      const list = await stack.api("GET", "/api/sessions");
      const s = (list.body.sessions || []).find((x) => x.id === id);
      return s ? s.agent : undefined;
    };

    const ws = new WebSocket(stack.wsUrl());
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    ws.send(JSON.stringify({ type: "attach", sessionId: id }));
    await wait(2500); // the shell's first prompt

    ws.send(JSON.stringify({ type: "input", sessionId: id, data: `${fake}\r` }));
    await wait(2000);
    ws.send(JSON.stringify({ type: "input", sessionId: id, data: "lam tiep\r" }));
    await wait(1500);
    ws.send(JSON.stringify({ type: "input", sessionId: id, data: "ket-qua-cua-agent\r" }));
    await wait(2000);

    assert.equal(await agentNow(), "claude", "while it runs, the session must say which agent it is");

    // Leaving the agent ends the transcript, and ending it flushes it.
    ws.send(JSON.stringify({ type: "input", sessionId: id, data: "thoat\r" }));
    const deadline = Date.now() + 15000;
    let after = await agentNow();
    while (after && Date.now() < deadline) {
      await wait(250);
      after = await agentNow();
    }
    assert.ok(!after, `the tab must stop reporting an agent after it exits, got ${JSON.stringify(after)}`);

    const file = path.join(workDir, ".claudehis.txt");
    assert.ok(fs.existsSync(file), ".claudehis.txt must be created in the session folder");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /CLAUDE session .* started/);
    assert.match(text, /--- YOU/, "the typed message must be recorded");
    assert.match(text, /lam tiep/, "the exact text typed must be there");
    assert.match(text, /--- CLAUDE/, "the answer block must be recorded");
    assert.match(text, /ket-qua-cua-agent/, "terminal output must be captured");
    assert.equal(/\u001b\[/.test(text), false, "ANSI escapes must not reach the transcript");

    ws.close();
    await stack.api("DELETE", `/api/sessions/${id}`);
  });

  await t.test("an ordinary session writes no transcript", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "wt-plain-"));
    const created = await stack.api("POST", "/api/sessions", { shell: SHELL, cwd: plain });
    const id = created.body.session.id;
    const WebSocket = require("ws");
    const ws = new WebSocket(stack.wsUrl());
    await new Promise((res) => ws.once("open", res));
    ws.send(JSON.stringify({ type: "attach", sessionId: id }));
    await wait(1000);
    ws.send(JSON.stringify({ type: "input", sessionId: id, data: "echo hello\r" }));
    await wait(1500);
    assert.equal(fs.existsSync(path.join(plain, ".claudehis.txt")), false);
    assert.equal(fs.existsSync(path.join(plain, ".agyhis.txt")), false);
    ws.close();
    await stack.api("DELETE", `/api/sessions/${id}`);
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

test("A background viewer cannot reshape the terminal", { timeout: 120000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  await stack.login();
  t.after(() => stack.stop());

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-claim-"));
  t.after(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test("an attach without a claim leaves the size alone", async () => {
    const created = await stack.api("POST", "/api/sessions", { shell: SHELL, cwd: workDir, cols: 120, rows: 40 });
    const id = created.body.session.id;
    const WebSocket = require("ws");

    // A phone tab in the background: it re-attaches with its own tiny size but
    // no claim. One real "tt" was drawn for 49x33 because exactly this attach
    // was allowed to resize the PTY out from under the desktop reading it.
    const phone = new WebSocket(stack.wsUrl());
    await new Promise((res) => phone.once("open", res));
    phone.send(JSON.stringify({ type: "attach", sessionId: id, cols: 49, rows: 33, claim: false }));
    await wait(1200);

    let list = await stack.api("GET", "/api/sessions");
    let session = list.body.sessions.find((x) => x.id === id);
    assert.equal(`${session.cols}x${session.rows}`, "120x40", "a claimless attach must not resize");

    // The person actually looking at it attaches normally - that one counts.
    const desktop = new WebSocket(stack.wsUrl());
    await new Promise((res) => desktop.once("open", res));
    desktop.send(JSON.stringify({ type: "attach", sessionId: id, cols: 204, rows: 100 }));
    await wait(1200);

    list = await stack.api("GET", "/api/sessions");
    session = list.body.sessions.find((x) => x.id === id);
    assert.equal(`${session.cols}x${session.rows}`, "204x100", "a claimed attach still resizes");

    phone.close();
    desktop.close();
    await stack.api("DELETE", `/api/sessions/${id}`);
  });
});

test("A session gives back more than its screen holds", { timeout: 120000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  await stack.login();
  t.after(() => stack.stop());

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-tran-"));
  t.after(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test("lines that scrolled away are still returned", async () => {
    const shell = WINDOWS ? "powershell" : "bash";
    const created = await stack.api("POST", "/api/sessions", { shell, cwd: workDir, title: "Doc lai" });
    const id = created.body.session.id;
    const WebSocket = require("ws");
    const ws = new WebSocket(stack.wsUrl());
    await new Promise((res) => ws.once("open", res));
    // A deliberately short screen, so most of what follows leaves it.
    ws.send(JSON.stringify({ type: "attach", sessionId: id, cols: 80, rows: 8 }));
    await wait(4000); // a shell with a profile to load is not ready in a blink

    const count = 60;
    const loop = WINDOWS
      ? `1..${count} | ForEach-Object { Write-Output ("dong-" + $_) }`
      : `for i in $(seq 1 ${count}); do echo dong-$i; done`;
    ws.send(JSON.stringify({ type: "input", sessionId: id, data: loop }));
    // PowerShell holds a braced line open until a blank one closes it.
    await wait(500);
    ws.send(JSON.stringify({ type: "input", sessionId: id, data: String.fromCharCode(13) }));
    await wait(5000);

    const r = await stack.api("GET", `/api/sessions/${id}/transcript`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const text = r.body.lines.map((l) => l.trim());
    // The screen is eight rows; every one of the sixty has to come back.
    for (let i = 1; i <= count; i++) {
      assert.ok(text.includes(`dong-${i}`), `dong-${i} phai con trong ban dung lai`);
    }
    ws.close();
    await stack.api("DELETE", `/api/sessions/${id}`);
  });
});

test("Multiple machines", { timeout: 120000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  await stack.login();

  // A second PTY host, standing in for another computer on the LAN. It shares
  // the data directory so it shares the key, exactly as a real second machine
  // would once you copy its key across. Its machine id is what makes it a
  // different computer - on a real one that comes from the OS.
  const secondPort = await freePort();
  const second = spawn(process.execPath, [path.join(__dirname, "..", "server", "pty-host.js")], {
    env: {
      ...stack.env,
      PTY_HOST_PORT: String(secondPort),
      PTY_HOST_BIND: "127.0.0.1",
      WEB_TERMINAL_MACHINE_ID: "the-second-machine",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  second.stdout.on("data", () => {});
  second.stderr.on("data", () => {});
  await wait(1500);

  t.after(async () => {
    try {
      second.kill();
    } catch {}
    await stack.stop();
  });

  const key = fs.readFileSync(path.join(stack.dataDir, "host.key"), "utf8").trim();
  let hostId;
  let localId;

  await t.test("the local machine is listed by default", async () => {
    const r = await stack.api("GET", "/api/hosts");
    assert.equal(r.status, 200);
    assert.equal(r.body.hosts.length, 1);
    assert.equal(r.body.hosts[0].local, true);
    localId = r.body.hosts[0].id;
    assert.notEqual(localId, "local", "a real id, so the list means the same on any machine");
  });

  await t.test("this machine is an entry in the list like any other", async () => {
    // Same fields as a remote, so the file can be carried to another machine
    // and read from there - where this one is a remote.
    const stored = JSON.parse(fs.readFileSync(path.join(stack.dataDir, "hosts.json"), "utf8"));
    assert.equal(stored.length, 1);
    const self = stored[0];
    assert.equal(self.id, localId);
    assert.ok(self.name);
    assert.equal(self.key, key, "its own key, which is what the other machines need to reach it");
    assert.equal(self.port, stack.hostPort);
    assert.match(self.machineId, /^[0-9a-f]{12}$/);
  });

  await t.test("probe reports whether a machine answers", async () => {
    const ok = await stack.api("POST", "/api/hosts/probe", { address: "127.0.0.1", port: secondPort });
    assert.equal(ok.body.reachable, true);
    const bad = await stack.api("POST", "/api/hosts/probe", { address: "127.0.0.1", port: 1 });
    assert.equal(bad.body.reachable, false);
    assert.ok(bad.body.error);
  });

  await t.test("a machine cannot be added without a plausible key", async () => {
    const r = await stack.api("POST", "/api/hosts", { name: "Bad", address: "127.0.0.1", port: secondPort, key: "short" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /key/i);
  });

  await t.test("adding a machine connects to it", async () => {
    const r = await stack.api("POST", "/api/hosts", {
      name: "May 2",
      address: "127.0.0.1",
      port: secondPort,
      key,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    hostId = r.body.host.id;
    await wait(1200);
    const list = await stack.api("GET", "/api/hosts");
    const remote = list.body.hosts.find((h) => h.id === hostId);
    assert.ok(remote);
    assert.equal(remote.connected, true, "must reach the second machine");
    assert.equal(remote.local, false);
    // It says who it is, and that is written down so the list can find it again.
    assert.ok(remote.machineId);
    const stored = JSON.parse(fs.readFileSync(path.join(stack.dataDir, "hosts.json"), "utf8"));
    assert.equal(stored.find((e) => e.id === hostId).machineId, remote.machineId);
  });

  await t.test("an address that leads back to this machine is refused", async () => {
    // Otherwise every local terminal is listed twice, under two names.
    const r = await stack.api("POST", "/api/hosts", { name: "Loop", address: "127.0.0.1", port: stack.hostPort, key });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await wait(1200);
    const loop = (await stack.api("GET", "/api/hosts")).body.hosts.find((h) => h.id === r.body.host.id);
    assert.equal(loop.connected, false);
    assert.match(loop.lastError, /chính máy/);
    const sessions = (await stack.api("GET", "/api/sessions")).body.sessions;
    assert.equal(sessions.some((s) => s.hostId === r.body.host.id), false);
    await stack.api("DELETE", `/api/hosts/${r.body.host.id}`);
  });

  await t.test("each machine says which shells it has", async () => {
    // The web server cannot answer this for anyone but itself. Asking it to was
    // how a Windows browser came to offer PowerShell for a Linux machine, with
    // nothing but the error after Create to say otherwise.
    const r = await stack.api("GET", "/api/profiles");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.byHost), "every machine is listed");
    assert.deepEqual(r.body.byHost.map((h) => h.hostId).sort(), [localId, hostId].sort());

    for (const entry of r.body.byHost) {
      assert.equal(entry.connected, true);
      assert.ok(entry.shells.length > 0, `${entry.hostName} must report a shell`);
      assert.ok(
        entry.shells.some((sh) => sh.id === SHELL),
        `${entry.hostName} must offer ${SHELL}`
      );
      // A shell id is only meaningful with a label to show for it.
      for (const sh of entry.shells) assert.ok(sh.id && sh.label, JSON.stringify(sh));
    }

    // The top-level fields stay the local machine's: the sidebar launchers open
    // terminals here, and that is what they have always meant.
    assert.deepEqual(
      r.body.shells.map((sh) => sh.id),
      r.body.byHost.find((h) => h.hostId === localId).shells.map((sh) => sh.id)
    );
  });

  await t.test("a terminal can be created on the other machine", async () => {
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, hostId, title: "Tren may 2" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.session.hostId, hostId);
    assert.ok(r.body.session.pid > 0);

    const sessions = (await stack.api("GET", "/api/sessions")).body.sessions;
    const mine = sessions.find((s) => s.id === r.body.session.id);
    assert.equal(mine.hostId, hostId, "the session list must say which machine it is on");
    assert.equal(mine.hostName, "May 2");

    // And it is routable: input reaches that machine's PTY.
    const WebSocket = require("ws");
    const ws = new WebSocket(stack.wsUrl());
    const seen = [];
    ws.on("message", (raw) => seen.push(JSON.parse(raw.toString())));
    await new Promise((res) => ws.once("open", res));
    ws.send(JSON.stringify({ type: "attach", sessionId: r.body.session.id }));
    await wait(1200);
    ws.send(JSON.stringify({ type: "input", sessionId: r.body.session.id, data: "echo tu-may-hai\r" }));
    await wait(2500);
    const text = seen
      .filter((m) => (m.type === "output" || m.type === "history") && m.sessionId === r.body.session.id)
      .map((m) => m.data)
      .join("");
    assert.match(text, /tu-may-hai/);
    ws.close();
    await stack.api("DELETE", `/api/sessions/${r.body.session.id}`);
  });

  await t.test("a machine that is not answering reports no shells, not the wrong ones", async () => {
    second.kill();
    await wait(1500);
    const r = await stack.api("GET", "/api/profiles");
    const gone = r.body.byHost.find((h) => h.hostId === hostId);
    assert.equal(gone.connected, false);
    assert.deepEqual(gone.shells, [], "an unreachable machine offers nothing rather than a guess");
    // The local machine is unaffected by the other one being down.
    assert.ok(r.body.byHost.find((h) => h.hostId === localId).shells.length > 0);
  });

  await t.test("removing a machine drops it and its sessions", async () => {
    const r = await stack.api("DELETE", `/api/hosts/${hostId}`);
    assert.equal(r.status, 200);
    const list = await stack.api("GET", "/api/hosts");
    assert.equal(list.body.hosts.some((h) => h.id === hostId), false);
    const sessions = (await stack.api("GET", "/api/sessions")).body.sessions;
    assert.equal(sessions.some((s) => s.hostId === hostId), false);
  });

  await t.test("the local machine cannot be removed", async () => {
    for (const id of ["local", localId]) {
      const r = await stack.api("DELETE", `/api/hosts/${id}`);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /cannot be removed/i);
    }
  });
});

test("Tab name and colour", { timeout: 120000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  await stack.login();
  t.after(() => stack.stop());

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wt-tab-"));
  const child = path.join(parent, "Test");
  fs.mkdirSync(child, { recursive: true });
  t.after(() => {
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch {}
  });

  let id;

  await t.test("an unnamed tab takes the name of its folder", async () => {
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, cwd: child });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    id = r.body.session.id;
    assert.equal(r.body.session.title, "Test", "…/Test must show as Test");
    assert.equal(r.body.session.autoTitle, true);
    assert.equal(r.body.session.color, "");
  });

  await t.test("the filesystem root shows as the root", async () => {
    // A tab sitting at the top of the filesystem has no folder name to take, so
    // it says where it is rather than falling back to the name of the shell.
    const root = WINDOWS ? "C:\\" : "/";
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, cwd: root });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.session.title, root);
    await stack.api(`DELETE`, `/api/sessions/${r.body.session.id}`);
  });

  await t.test("the name follows the terminal into another folder", async () => {
    const WebSocket = require("ws");
    const ws = new WebSocket(stack.wsUrl());
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    ws.send(JSON.stringify({ type: "attach", sessionId: id }));
    await wait(1200);
    ws.send(JSON.stringify({ type: "input", sessionId: id, data: "cd ..\r" }));
    await wait(2500);
    const s = (await stack.api("GET", "/api/sessions")).body.sessions.find((x) => x.id === id);
    assert.equal(s.title, path.basename(fs.realpathSync.native(parent)));
    ws.close();
  });

  await t.test("a tab colour can be set and cleared", async () => {
    let r = await stack.api("POST", `/api/sessions/${id}/update`, { color: "#38BDF8" });
    assert.equal(r.status, 200);
    assert.equal(r.body.session.color, "#38bdf8", "colour is normalised to lowercase");

    r = await stack.api("POST", `/api/sessions/${id}/update`, { color: "javascript:alert(1)" });
    assert.equal(r.body.session.color, "", "anything that is not #rrggbb is dropped");

    r = await stack.api("POST", `/api/sessions/${id}/update`, { color: "#f472b6" });
    assert.equal(r.body.session.color, "#f472b6");
  });

  await t.test("naming a tab by hand pins it", async () => {
    let r = await stack.api("POST", `/api/sessions/${id}/update`, { title: "Bao cao MISA" });
    assert.equal(r.body.session.title, "Bao cao MISA");
    assert.equal(r.body.session.autoTitle, false);

    const WebSocket = require("ws");
    const ws = new WebSocket(stack.wsUrl());
    await new Promise((res) => ws.once("open", res));
    ws.send(JSON.stringify({ type: "attach", sessionId: id }));
    await wait(1000);
    ws.send(JSON.stringify({ type: "input", sessionId: id, data: "cd Test\r" }));
    await wait(2500);
    const s = (await stack.api("GET", "/api/sessions")).body.sessions.find((x) => x.id === id);
    assert.equal(s.title, "Bao cao MISA", "a hand-picked name must survive a cd");
    ws.close();
  });

  await t.test("a name given with auto-naming still on is kept, not thrown away", async () => {
    // The dialog used to send the typed name together with autoTitle:true,
    // and the folder name silently won. An explicit name must always win.
    const r = await stack.api("POST", `/api/sessions/${id}/update`, {
      title: "Ten go tay",
      autoTitle: true,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.session.title, "Ten go tay");
    assert.equal(r.body.session.autoTitle, false, "an explicit name turns auto-naming off");
  });

  await t.test("updating a session that is gone reports it clearly", async () => {
    const r = await stack.api("POST", "/api/sessions/khong-ton-tai/update", { title: "x" });
    assert.equal(r.status, 404);
    assert.match(String(r.body.error), /not found/i);
  });

  await t.test("clearing the name hands it back to the folder", async () => {
    const r = await stack.api("POST", `/api/sessions/${id}/update`, { title: "", autoTitle: true });
    assert.equal(r.body.session.title, "Test");
    assert.equal(r.body.session.autoTitle, true);
  });

  await t.test("colour and naming mode survive a reopen from history", async () => {
    await stack.api("POST", `/api/sessions/${id}/update`, { color: "#4ade80" });
    await stack.api(`DELETE`, `/api/sessions/${id}`);
    await wait(600);
    const r = await stack.api("POST", `/api/history/${id}/reopen`, { hostId: "local" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.session.color, "#4ade80");
    assert.equal(r.body.session.autoTitle, true);
    assert.equal(r.body.session.title, "Test");
    await stack.api(`DELETE`, `/api/sessions/${r.body.session.id}`);
  });
});
