"use strict";
const test = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { Stack, wait, SHELL, CWD_SHELL, SYSTEM_DIR, MISSING_DIR } = require("./helpers");

/** Collect messages from one WebSocket, with a helper to await a condition. */
function client(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  return {
    ws,
    messages,
    open: () => new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    }),
    send: (m) => ws.send(JSON.stringify(m)),
    /** Resolve when a message matching `match` arrives (checks the backlog too). */
    until(match, timeoutMs = 15000, label = "message") {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);
        waiters.push(w);
      });
    },
    /** Concatenated output text for a session. */
    outputFor(sessionId) {
      return messages
        .filter((m) => (m.type === "output" || m.type === "history") && m.sessionId === sessionId)
        .map((m) => m.data)
        .join("");
    },
    close: () => ws.close(),
  };
}

test("PTY sessions", { timeout: 180000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  await stack.login();
  t.after(() => stack.stop());

  let sessionId;

  await t.test("create a real ConPTY session", async () => {
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, title: "Test CMD", cols: 100, rows: 30 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    sessionId = r.body.session.id;
    assert.ok(sessionId);
    assert.equal(r.body.session.shell, SHELL);
    assert.equal(r.body.session.title, "Test CMD");
    assert.ok(r.body.session.pid > 0, "session must have a real OS pid");
    assert.equal(r.body.session.status, "running");
  });

  await t.test("refuse an unknown shell", async () => {
    const r = await stack.api("POST", "/api/sessions", { shell: "notashell" });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /Unknown shell profile/);
  });

  await t.test("refuse a system folder as the working directory", async () => {
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, cwd: SYSTEM_DIR });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /system folder/i);
  });

  await t.test("refuse a working directory that does not exist", async () => {
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, cwd: MISSING_DIR });
    assert.equal(r.status, 400);
  });

  await t.test("allow a working directory outside WEB_TERMINAL_ROOTS", async () => {
    // A shell can cd anywhere once it runs, so the start directory is only
    // barred from system folders - not from everything outside roots.
    const outside = require("os").tmpdir();
    const r = await stack.api("POST", "/api/sessions", { shell: SHELL, cwd: outside, title: "Outside" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.session.cwd.toLowerCase(), require("fs").realpathSync.native(outside).toLowerCase());
    await stack.api("DELETE", `/api/sessions/${r.body.session.id}`);
  });

  await t.test("list reports the session", async () => {
    const r = await stack.api("GET", "/api/sessions");
    assert.equal(r.status, 200);
    assert.ok(r.body.sessions.some((s) => s.id === sessionId));
  });

  await t.test("attach, type a command, read the real output", async () => {
    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready", 10000, "ready");
    c.send({ type: "attach", sessionId });
    await c.until((m) => m.type === "history" && m.sessionId === sessionId, 10000, "history");

    c.send({ type: "input", sessionId, data: "echo wt-marker-4711\r" });
    await c.until(
      (m) => m.type === "output" && m.sessionId === sessionId && m.data.includes("wt-marker-4711"),
      15000,
      "command echo"
    );
    assert.match(c.outputFor(sessionId), /wt-marker-4711/);
    c.close();
  });

  await t.test("history says which width it was drawn at, not the new one", async () => {
    // The scrollback is a recording of a terminal of a given width. A browser
    // that replays it at its own width gets no wrapping, so nothing is pushed
    // off the top and the restored history has no scrollback to scroll back
    // through. The replay geometry is what lets the client avoid that.
    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready", 10000, "ready");

    c.send({ type: "attach", sessionId, cols: 100, rows: 30 });
    const first = await c.until((m) => m.type === "history" && m.sessionId === sessionId, 10000, "history");
    assert.equal(first.session.cols, 100, "the attach resizes the PTY");

    // Re-attach at a different size: the bytes on hand were drawn at 100x30.
    c.send({ type: "attach", sessionId, cols: 120, rows: 40 });
    const second = await c.until(
      (m) => m.type === "history" && m.sessionId === sessionId && m.session.cols === 120,
      10000,
      "second history"
    );
    assert.deepEqual(
      { cols: second.replay.cols, rows: second.replay.rows },
      { cols: 100, rows: 30 },
      "replay geometry is the width the buffer was written at"
    );
    c.close();
  });

  await t.test("input is refused when the client never attached", async () => {
    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready");
    c.send({ type: "input", sessionId, data: "echo nope\r" });
    const err = await c.until((m) => m.type === "error", 8000, "error");
    assert.match(err.message, /Not attached/);
    c.close();
  });

  await t.test("malformed messages do not kill the connection", async () => {
    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready");
    c.ws.send("this is not json");
    await c.until((m) => m.type === "error" && /Malformed/.test(m.message), 8000, "malformed error");
    c.send({ type: "ping" });
    await c.until((m) => m.type === "pong", 8000, "pong");
    assert.equal(c.ws.readyState, WebSocket.OPEN);
    c.close();
  });

  await t.test("attaching to an unknown session reports an error", async () => {
    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready");
    c.send({ type: "attach", sessionId: "does-not-exist" });
    const err = await c.until((m) => m.type === "error", 8000, "error");
    assert.match(err.message, /Session not found/);
    c.close();
  });

  await t.test("session survives a web server restart and replays scrollback", async () => {
    await stack.restartWeb();
    const r = await stack.api("GET", "/api/sessions");
    assert.ok(r.body.sessions.some((s) => s.id === sessionId), "session must outlive the web server");

    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready");
    c.send({ type: "attach", sessionId });
    const history = await c.until((m) => m.type === "history" && m.sessionId === sessionId, 10000, "history");
    assert.match(history.data, /wt-marker-4711/, "scrollback must be replayed after reconnect");

    // And the process is still live.
    c.send({ type: "input", sessionId, data: "echo still-alive-9931\r" });
    await c.until(
      (m) => m.type === "output" && m.data.includes("still-alive-9931"),
      15000,
      "post-restart output"
    );
    c.close();
  });

  await t.test("resize is accepted", async () => {
    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready");
    c.send({ type: "attach", sessionId });
    await c.until((m) => m.type === "history" && m.sessionId === sessionId);
    c.send({ type: "resize", sessionId, cols: 90, rows: 24 });
    await wait(500);
    const r = await stack.api("GET", "/api/sessions");
    const s = r.body.sessions.find((x) => x.id === sessionId);
    assert.equal(s.cols, 90);
    assert.equal(s.rows, 24);
    c.close();
  });

  await t.test("rename changes the tab title", async () => {
    const r = await stack.api("POST", `/api/sessions/${sessionId}/rename`, { title: "Đổi tên" });
    assert.equal(r.status, 200);
    assert.equal(r.body.session.title, "Đổi tên");
  });

  await t.test("restart keeps the id and gives a fresh process", async () => {
    const before = (await stack.api("GET", "/api/sessions")).body.sessions.find((s) => s.id === sessionId);
    const r = await stack.api("POST", `/api/sessions/${sessionId}/restart`, {});
    assert.equal(r.status, 200);
    await wait(2500);
    const after = (await stack.api("GET", "/api/sessions")).body.sessions.find((s) => s.id === sessionId);
    assert.ok(after, "session id must be preserved across restart");
    assert.equal(after.status, "running");
    assert.notEqual(after.pid, before.pid, "restart must spawn a new process");
  });

  await t.test("kill stops the process but keeps the record", async () => {
    const r = await stack.api("POST", `/api/sessions/${sessionId}/kill`, {});
    assert.equal(r.status, 200);
    await wait(1200);
    const s = (await stack.api("GET", "/api/sessions")).body.sessions.find((x) => x.id === sessionId);
    assert.ok(s);
    assert.equal(s.status, "exited");
  });

  await t.test("delete removes the record entirely", async () => {
    const r = await stack.api("DELETE", `/api/sessions/${sessionId}`);
    assert.equal(r.status, 200);
    const list = (await stack.api("GET", "/api/sessions")).body.sessions;
    assert.equal(list.some((s) => s.id === sessionId), false);
  });

  await t.test("the tab stops reporting an agent once the agent exits", async (tt) => {
    // The bug: /exit left the tab green. The flag that says "an agent is running
    // here" was set when the command was typed and then never cleared, so the
    // tab kept claiming Claude was there - and a pasted newline kept going out
    // as ESC CR to a plain shell.
    //
    // A command that merely *mentions* an agent by name is detected the same way
    // a real one is, which is what makes this testable without installing any
    // agent: it holds the terminal for a few seconds, then gives the prompt back.
    const win = process.platform === "win32";
    const line = win ? '& { Start-Sleep -Seconds 4 } # claude' : "sleep 4 # claude";
    const r = await stack.api("POST", "/api/sessions", { shell: CWD_SHELL, cwd: stack.workDir });
    if (r.status !== 201) {
      tt.skip(`${CWD_SHELL} unavailable: ${JSON.stringify(r.body)}`);
      return;
    }
    const id = r.body.session.id;
    const agentNow = async () => {
      const list = await stack.api("GET", "/api/sessions");
      const s = (list.body.sessions || []).find((x) => x.id === id);
      return s ? s.agent : undefined;
    };
    const until = async (want, ms, label) => {
      const deadline = Date.now() + ms;
      let last;
      while (Date.now() < deadline) {
        last = await agentNow();
        if (want(last)) return last;
        await wait(250);
      }
      throw new Error(`Timed out waiting for ${label}; agent was ${JSON.stringify(last)}`);
    };
    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready");
    c.send({ type: "attach", sessionId: id });
    await c.until((m) => m.type === "history" && m.sessionId === id, 10000, "history");
    await wait(2500); // the first prompt, which must not clear anything yet
    try {
      c.send({ type: "input", sessionId: id, data: `${line}\r` });
      await until((a) => a === "claude", 8000, "the tab to report the agent");
      // The prompt coming back is the only signal an exit gives us.
      await until((a) => !a, 20000, "the tab to stop reporting the agent");
    } finally {
      c.close();
      await stack.api("DELETE", `/api/sessions/${id}`);
    }
  });

  await t.test("the shell reports its working directory over OSC 9;9", async (tt) => {
    // The whole chain, on whichever platform this is: the injected startup hook
    // (an -EncodedCommand snippet on Windows, a generated rc file on POSIX), a
    // real shell, the PTY, trackCwd, and the cwd event the browser listens for.
    const r = await stack.api("POST", "/api/sessions", { shell: CWD_SHELL, cwd: stack.workDir });
    if (r.status !== 201) {
      tt.skip(`${CWD_SHELL} unavailable: ${JSON.stringify(r.body)}`);
      return;
    }
    const id = r.body.session.id;
    const c = client(stack.wsUrl());
    await c.open();
    await c.until((m) => m.type === "ready");
    c.send({ type: "attach", sessionId: id });
    await c.until((m) => m.type === "history" && m.sessionId === id, 10000, "history");
    // Wait for the first prompt, then move somewhere the server can observe.
    await wait(2500);
    c.send({ type: "input", sessionId: id, data: "cd ..\r" });
    try {
      await c.until((m) => m.type === "cwd" && m.sessionId === id, 15000, "cwd report");
    } finally {
      c.close();
      await stack.api("DELETE", `/api/sessions/${id}`);
    }
  });
});
