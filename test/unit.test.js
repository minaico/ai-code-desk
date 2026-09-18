"use strict";
/** Pure unit tests: path validation, tokens, Claude heuristics. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-unit-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-unitdata-"));
process.env.WEB_TERMINAL_ROOTS = workDir;
process.env.WEB_TERMINAL_DATA = dataDir;
process.env.WEB_TERMINAL_PASSWORD = "unit-test-password";
process.env.WEB_TERMINAL_LOG_CONSOLE = "0";

const files = require("../server/files");
const auth = require("../server/auth");

test.after(() => {
  for (const d of [workDir, dataDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

test("safePath keeps callers inside the allowed roots", () => {
  assert.equal(files.safePath(""), workDir);
  assert.equal(files.safePath(workDir), fs.realpathSync.native(workDir));

  const sub = path.join(workDir, "sub");
  fs.mkdirSync(sub, { recursive: true });
  assert.ok(files.safePath(sub).startsWith(fs.realpathSync.native(workDir)));

  const systemDir = process.platform === "win32" ? "C:\\Windows" : "/proc";
  assert.throws(() => files.safePath(systemDir), /outside allowed roots|not found/i);
  assert.throws(() => files.safePath(path.join(workDir, "..")), /outside allowed roots|not found/i);
  assert.throws(() => files.safePath(path.join(workDir, "..", "..", "..")), /outside|not found/i);
  assert.throws(() => files.safePath("\\\\server\\share"), /outside allowed roots|not found/i);
});

test("safeName strips directories and reserved names", () => {
  assert.equal(files.safeName("report.csv"), "report.csv");
  assert.equal(files.safeName("..\\..\\evil.txt"), "evil.txt");
  assert.equal(files.safeName("a/b/c.txt"), "c.txt");
  assert.equal(files.safeName('bad:name?.txt'), "bad_name_.txt");
  assert.throws(() => files.safeName("CON"), /Reserved/);
  assert.throws(() => files.safeName(""), /Invalid file name/);
});

test("upload targets cannot escape the chosen directory", () => {
  const target = files.uploadTarget(workDir, "..\\..\\escape.txt");
  assert.ok(target.startsWith(fs.realpathSync.native(workDir)));
  assert.equal(path.basename(target), "escape.txt");
});

test("password verification is exact", () => {
  assert.equal(auth.verifyPassword("unit-test-password"), true);
  assert.equal(auth.verifyPassword("wrong"), false);
  assert.equal(auth.verifyPassword(""), false);
});

test("scrypt hashes verify through the same path", () => {
  const hash = auth.hashPassword("another-secret");
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
});

test("tokens are signed, verifiable and revocable", () => {
  const { token } = auth.issueToken();
  assert.ok(auth.verifyToken(token));
  assert.equal(auth.verifyToken(token + "x"), null);
  assert.equal(auth.verifyToken("garbage"), null);
  assert.equal(auth.verifyToken(""), null);
  auth.revokeToken(token);
  assert.equal(auth.verifyToken(token), null);
});

test("Claude Assist recognises a marked TUI menu", async () => {
  const { analyse, planFor } = await import("../src/lib/claude.js");
  const lines = [
    "Claude needs your permission to run a command",
    "",
    "  Allow",
    "\u276f Deny",
    "  Cancel",
  ];
  const r = analyse(lines);
  assert.equal(r.kind, "menu");
  assert.equal(r.confidence, "high");
  assert.deepEqual(r.options.map((o) => o.text), ["Allow", "Deny", "Cancel"]);
  assert.equal(r.selected, 1);

  // Moving from "Deny" (1) up to "Allow" (0) is one Up then Enter.
  const plan = planFor(r, 0);
  assert.equal(plan.length, 2);
  assert.equal(plan[0], String.fromCharCode(27) + "[A");
  assert.equal(plan[1], "\r");

  // Moving down two rows.
  assert.equal(planFor(r, 2).length, 2);
});

test("Claude Assist only takes rows aligned with the highlighted one", async () => {
  const { analyse } = await import("../src/lib/claude.js");
  const r = analyse([
    'PS C:> Write-Host "Claude needs your permission"; Write-Host "  Cancel"',
    "Claude needs your permission to run a command",
    "  Allow",
    "❯ Deny",
    "  Cancel",
  ]);
  // The prose header and the echoed command start in column 0; the options all
  // start in column 2, so only those three become buttons.
  assert.deepEqual(r.options.map((o) => o.text), ["Allow", "Deny", "Cancel"]);
  assert.equal(r.confidence, "high");
  assert.equal(r.selected, 1);
});

test("Claude Assist refuses to guess when no row is highlighted", async () => {
  const { analyse, planFor } = await import("../src/lib/claude.js");
  const r = analyse(["Choose an option", "  Allow", "  Deny", "  Cancel"]);
  assert.equal(r.confidence, "low");
  assert.deepEqual(planFor(r, 0), [], "must not send keystrokes when unsure");
});

test("Claude Assist handles numbered menus and yes/no prompts", async () => {
  const { analyse, planFor } = await import("../src/lib/claude.js");
  const numbered = analyse(["Select an option", "1. Yes, proceed", "2. No, cancel"]);
  assert.equal(numbered.kind, "numbered");
  assert.equal(numbered.confidence, "high");
  assert.deepEqual(planFor(numbered, 1), ["2"]);

  const yesno = analyse(["Overwrite the file? (y/n)"]);
  assert.equal(yesno.kind, "yesno");
  assert.deepEqual(planFor(yesno, 0), ["y", "\r"]);
});

test("Claude Assist reads a numbered menu that marks its selected row", async () => {
  const { analyse, planFor } = await import("../src/lib/claude.js");
  const r = analyse(["Bash(npm test)", "❯ 1. Yes", "  2. No, and tell Claude what to do"]);
  assert.equal(r.kind, "numbered");
  assert.equal(r.confidence, "high");
  assert.equal(r.selected, 0, "the marked row is the one Claude has highlighted");
  assert.deepEqual(planFor(r, 1), ["2"]);
});

test("Claude Assist does not read a numbered list in prose as a menu", async () => {
  const { analyse } = await import("../src/lib/claude.js");
  // A status report Claude printed. Reading "1." and "2." here as a menu lit
  // the bar, the bar took rows away from the PTY, the TUI repainted, and the
  // repaint fed the next analysis: the bar flickered and the last block was
  // duplicated down the screen. Every numbered line below is prose.
  const r = analyse([
    ...Array(22).fill("5. Việc tiếp theo"),
    "",
    "1. Render video 121-240 (chạy theo cụm 5 video/lần bằng build-all.ts).",
    "2. Hẹn câu 89 (29/09) và 90 (30/09) — thử lại từ 01/09.",
    "3. Từ ~03/09 hẹn dần batch 4: schedule-fixed.ts --base 2026-10-01 --anchor 91 ...",
    "",
    "6. Next Exact Step",
    "",
    "Chạy render cụm đầu tiên: npx tsx scripts/build-all.ts cho câu 121-125.",
  ]);
  assert.equal(r.kind, "none");
});

test("Claude Assist ignores a numbered list that ends the screen but asks nothing", async () => {
  const { analyse } = await import("../src/lib/claude.js");
  // Same trap without the prose underneath: the list is the last thing drawn,
  // so only the missing question separates it from a real prompt.
  const r = analyse([
    "5. Việc tiếp theo",
    "",
    "1. Test nút 📄 trên Safari iPhone với một phiên Claude thật.",
    "2. Chạy thử máy 42 với PTY host riêng.",
  ]);
  assert.equal(r.kind, "none");
});

test("each machine keeps its own shape", async () => {
  const { machineShape, machineName, localHostId } = await import("../src/lib/machines.js");
  const { t } = await import("../src/lib/i18n.js");
  const hosts = [
    { id: "5d0c1a2b3c", name: "Máy 231", local: true },
    { id: "21f80dc71c", name: "Máy 42" },
    { id: "aa11bb22cc", name: "43" },
  ];

  assert.equal(machineShape("5d0c1a2b3c", hosts), "circle");
  assert.equal(machineShape("local", hosts), "circle", "the alias is the machine serving the page");
  assert.equal(machineShape("", hosts), "circle", "no host id means this machine");
  assert.equal(machineShape("21f80dc71c", hosts), "triangle");
  assert.equal(machineShape("aa11bb22cc", hosts), "square");
  assert.equal(localHostId(hosts), "5d0c1a2b3c");

  // The same list served by machine 42: 42 is now the main one, and nobody's
  // shape moves. The shape belongs to the machine, not to who is asking.
  const from42 = hosts.map((h) => ({ ...h, local: h.id === "21f80dc71c" }));
  assert.equal(machineShape("5d0c1a2b3c", from42), "circle");
  assert.equal(machineShape("21f80dc71c", from42), "triangle");
  assert.equal(machineShape("local", from42), "triangle", "and 'local' now means 42");
  assert.equal(machineName("local", from42), "Máy 42");

  // Registry order decides, so a shape does not move when the panel is reopened.
  const offline = [hosts[0], hosts[2]];
  assert.equal(machineShape("aa11bb22cc", offline), "triangle", "order, not identity, picks the shape");

  // A history row from a machine that has since been removed must not be able
  // to claim somebody else's shape.
  assert.equal(machineShape("gone-forever", hosts), "hexagon");

  // Before the list has loaded there is nothing to go on but the page itself.
  assert.equal(machineShape("local", []), "circle");
  assert.equal(machineName("local", []), t("Máy này"));

  assert.equal(machineName("21f80dc71c", hosts), "Máy 42");
  assert.equal(machineName("unknown", hosts, "Tên cũ"), "Tên cũ");
});

test("a machine finds itself in a list written on another machine", () => {
  const { findSelf, ensureSelf } = require("../server/hosts");
  const { machineId } = require("../server/machine");
  const { hostKey } = require("../server/config");
  const me = machineId();
  const other = { id: "21f80dc71c", name: "Máy 42", address: "192.168.192.42", port: 8777, key: "k".repeat(64) };

  // By machine id, wherever it is in the list.
  const listed = [other, { id: "aaaaaaaaaa", name: "Tôi", address: "10.0.0.5", port: 8777, key: "old", machineId: me }];
  assert.equal(findSelf(listed), 1);

  // An entry saved before machines reported their id: its key is this machine's
  // own, and no other machine holds that.
  const legacy = [other, { id: "bbbbbbbbbb", name: "Tôi", address: "10.0.0.5", port: 8777, key: hostKey() }];
  assert.equal(findSelf(legacy), 1);

  // What the list says about this machine is corrected from this machine: a
  // copied file may carry an old key or port. Other entries are not touched.
  const copied = JSON.parse(JSON.stringify(listed));
  const i = ensureSelf(copied);
  assert.equal(i, 1);
  assert.equal(copied[1].id, "aaaaaaaaaa", "the id is what saved tabs point at - it must not change");
  assert.equal(copied[1].name, "Tôi");
  assert.equal(copied[1].key, hostKey());
  assert.deepEqual(copied[0], other);

  // Not in the list at all: it joins, first, with a name of its own.
  const without = [JSON.parse(JSON.stringify(other))];
  assert.equal(ensureSelf(without), 0);
  assert.equal(without.length, 2);
  assert.equal(without[0].machineId, me);
  assert.ok(without[0].name);
  assert.match(without[0].id, /^[0-9a-f]{10}$/);
});

test("tabs saved as 'local' are given the id of the machine that saved them", () => {
  const { Workspaces } = require("../server/workspace");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-ws-"));
  fs.writeFileSync(
    path.join(dir, "workspaces.json"),
    JSON.stringify({ thanh: { tabs: [{ lineage: "a", hostId: "local" }, { lineage: "b", hostId: "21f80dc71c" }, { lineage: "c" }] } })
  );
  const ws = new Workspaces(dir, null, { localHostId: "5d0c1a2b3c" });
  assert.deepEqual(ws.get({ name: "thanh" }).tabs.map((t) => t.hostId), ["5d0c1a2b3c", "21f80dc71c", "5d0c1a2b3c"]);
  // On disk too: the file is what travels to the next main machine.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "workspaces.json"), "utf8"));
  assert.deepEqual(onDisk.thanh.tabs.map((t) => t.hostId), ["5d0c1a2b3c", "21f80dc71c", "5d0c1a2b3c"]);
  // And a save from a page that still says "local" does not bring it back.
  ws.set({ name: "thanh" }, { tabs: [{ lineage: "d", hostId: "local" }] });
  assert.equal(ws.get({ name: "thanh" }).tabs[0].hostId, "5d0c1a2b3c");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the session bar is gone from both layouts", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  for (const rel of ["src/ui/shell.js", "src/style.css", "src/main.js"]) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    for (const gone of ["sessionbar", "sessionName", "gitBadge"]) {
      assert.equal(text.includes(gone), false, `${rel} still refers to ${gone}`);
    }
  }
  // The tab strip and the + button must not drift apart again.
  const css = fs.readFileSync(path.join(root, "src/style.css"), "utf8");
  assert.match(css, /#btnNew,\s*\n\.tab \{[^}]*height:\s*var\(--tab-h\)/);
});

test("reopening a terminal takes over its row instead of adding one", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { History } = require("../server/history");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-hist-"));
  try {
    const h = new History(dir, console);
    const session = (id, extra = {}) => ({
      id,
      title: "1TN",
      shell: "powershell",
      cwd: "C:\\work",
      createdAt: new Date().toISOString(),
      ...extra,
    });

    h.record(session("aaa"));
    h.close(session("aaa"), 0);
    // Reopened three times, as anyone using the panel for what it is for does.
    h.record(session("bbb", { reopenedFrom: "aaa" }));
    h.close(session("bbb"), 0);
    h.record(session("ccc", { reopenedFrom: "bbb" }));
    h.close(session("ccc"), 0);
    h.record(session("ddd", { reopenedFrom: "ccc" }));

    assert.equal(h.list().length, 1, "one terminal, one row");
    assert.equal(h.list()[0].id, "ddd", "the row points at the terminal that is live now");
    assert.equal(h.get("ddd").status, "running");

    // A genuinely separate terminal is still a separate row, same name or not.
    h.record(session("zzz"));
    assert.equal(h.list().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a terminal cannot still be running in a host that just started", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { History } = require("../server/history");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-hist2-"));
  const file = path.join(dir, "session-history.json");
  try {
    // What a killed PTY host leaves behind: it never got to write "closed".
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "ccc", title: "1TN", status: "running", reopenedFrom: "bbb", lastSeenAt: "2026-08-31T01:56:00.000Z" },
        { id: "bbb", title: "1TN", status: "running", reopenedFrom: "aaa", lastSeenAt: "2026-08-31T01:10:00.000Z" },
        { id: "aaa", title: "MoiNgay1CauTienNhat", status: "running", lastSeenAt: "2026-08-31T00:08:00.000Z" },
        { id: "other", title: "Tn", status: "running", lastSeenAt: "2026-08-30T12:00:00.000Z" },
      ])
    );

    const h = new History(dir, console);
    const rows = h.list();
    assert.equal(rows.length, 2, "the three links of one chain collapse to one row");
    assert.deepEqual(rows.map((r) => r.id), ["ccc", "other"], "the newest link survives");
    assert.equal(
      rows.some((r) => r.status === "running"),
      false,
      "nothing was running when this process started"
    );
    for (const r of rows) assert.ok(r.closedAt, "a closed row says when");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every Vietnamese string on screen has an English translation", async () => {
  const { EN } = await import("../src/lib/i18n-en.js");
  const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const missing = [];
  const interpolated = [];

  // Code: every Vietnamese string literal is a key. One built with ${...}
  // cannot be looked up at all - it has to be t("... {name} ...", { name }).
  const files = ["src/main.js", "src/lib/machines.js", ...fs.readdirSync(path.join(__dirname, "../src/ui")).map((f) => `src/ui/${f}`)];
  for (const file of files) {
    let src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    if (file.endsWith("shell.js")) src = src.replace(/export const SHELL_HTML = `[\s\S]*?`;/, "");
    src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const check = (body) => {
      // t() looks keys up as written, leading space and all.
      if (VI.test(body) && !(body in EN) && !(norm(body) in EN)) missing.push(`${file}: ${body.slice(0, 70)}`);
    };
    for (const m of src.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
      const body = m[0].slice(1, -1);
      if (!VI.test(body)) continue;
      if (m[0][0] !== "`" || !body.includes("${")) {
        check(body);
        continue;
      }
      // A template: its own text must carry no Vietnamese, and the strings
      // inside its ${...} (t("...") calls) are keys like any other.
      const exprs = body.match(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g) || [];
      if (VI.test(body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ""))) interpolated.push(`${file}: ${body.slice(0, 70)}`);
      for (const e of exprs) for (const s of e.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) check(s[1] ?? s[2]);
    }
  }

  // Markup: every Vietnamese text fragment and readable attribute.
  const { SHELL_HTML } = await import("../src/ui/shell.js");
  const markup = SHELL_HTML.replace(/<!--[\s\S]*?-->/g, "");
  for (const frag of markup.split(/<[^>]+>/)) {
    const text = norm(frag);
    if (text && VI.test(text) && !(text in EN)) missing.push(`markup: ${text}`);
  }
  for (const m of markup.matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)) {
    if (VI.test(m[1]) && !(norm(m[1]) in EN)) missing.push(`attribute: ${m[1]}`);
  }

  assert.deepEqual(interpolated, [], "Vietnamese built with ${} - use t() with {placeholders}");
  assert.deepEqual(missing, [], "Vietnamese with no English entry in src/lib/i18n-en.js");
});

test("translations fill their placeholders and server messages are matched", async () => {
  const { EN, EN_PATTERNS } = await import("../src/lib/i18n-en.js");
  // Every placeholder a Vietnamese key names, its English says too.
  for (const [vi, en] of Object.entries(EN)) {
    const want = (vi.match(/\{\w+\}/g) || []).sort().join();
    assert.equal((en.match(/\{\w+\}/g) || []).sort().join(), want, `placeholders differ for "${vi}"`);
  }
  const match = (msg) => {
    for (const [re, en] of EN_PATTERNS) if (re.test(msg)) return msg.replace(re, en);
    return null;
  };
  assert.equal(match('Người dùng "alex" đã tồn tại'), 'User "alex" already exists');
  assert.equal(match("Mật khẩu phải có ít nhất 8 ký tự"), "A password needs at least 8 characters");
});

test("the output veil keeps what you typed and covers what came back", async () => {
  const { classifyRow } = await import("../src/lib/privacy.js");
  // A shell prompt: the path is covered, the command is not.
  assert.deepEqual(classifyRow(String.raw`PS C:\work\project> npm test`), [[0, 19]]);
  assert.deepEqual(classifyRow(String.raw`C:\work> dir`), [[0, 8]]);
  assert.deepEqual(classifyRow("me@box:~/src/app$ git status"), [[0, 17]]);
  // What you said to an agent stays readable.
  assert.deepEqual(classifyRow("> summarise the failing tests"), []);
  assert.deepEqual(classifyRow("❯ tt"), []);
  assert.deepEqual(classifyRow("│ > add a login page          │"), []);
  // The answer and everything else is covered, from its first character.
  assert.deepEqual(classifyRow("  ● The tests fail because"), [[2, 26]]);
  assert.deepEqual(classifyRow("   "), [], "an empty row needs no patch");
});

test("the UI markup has no Windows paths eaten by template-literal escapes", () => {
  // The dialogs are one template literal, so "scripts\resume.ps1" rendered as
  // "scripts" + carriage return + "esume.ps1" in the machines panel. Paths in
  // the markup are written with forward slashes.
  const src = fs.readFileSync(path.join(__dirname, "..", "src/ui/shell.js"), "utf8");
  const hits = src.split("\n").filter((line) => /\\[a-zA-Z]/.test(line));
  assert.deepEqual(hits, [], "a backslash before a letter is an escape, not a path separator");
});

/* ------------------------------------------------------------------ *
 * The encrypted machine-to-machine channel (server/tlspsk.js)
 * ------------------------------------------------------------------ */
const tls = require("tls");
const net = require("net");
const tlspsk = require("../server/tlspsk");

/** A PSK server that echoes one line, so a test can prove it got through. */
function pskServer(key) {
  const server = tls.createServer(tlspsk.serverOptions(key), (sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (d) => sock.write(`echo:${d}`));
  });
  const errors = [];
  server.on("tlsClientError", (err) => errors.push(err.message));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, errors }));
  });
}

/** Resolves to the reply, or rejects with whatever stopped the handshake. */
function pskSay(port, key, line) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ port, host: "127.0.0.1", ...tlspsk.clientOptions(key) });
    sock.setEncoding("utf8");
    sock.setTimeout(4000, () => reject(new Error("timeout")));
    sock.on("secureConnect", () => sock.write(line));
    sock.on("data", (d) => {
      resolve(d);
      sock.destroy();
    });
    sock.on("error", reject);
  });
}

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

test("the machine key alone encrypts and authenticates the channel", async () => {
  const { server, port } = await pskServer(KEY_A);
  try {
    // No certificate exists anywhere; the shared key is the whole credential.
    assert.equal(await pskSay(port, KEY_A, "hello"), "echo:hello");
  } finally {
    server.close();
  }
});

test("a wrong key fails the handshake instead of reaching the protocol", async () => {
  const { server, port, errors } = await pskServer(KEY_A);
  try {
    await assert.rejects(() => pskSay(port, KEY_B, '{"type":"hello"}'));
    // The point of doing this in TLS rather than in the hello: the bad peer
    // never got to send a message at all.
    assert.ok(errors.length >= 1, "the host should have logged a failed handshake");
  } finally {
    server.close();
  }
});

test("a plaintext client cannot talk to the encrypted channel", async () => {
  const { server, port } = await pskServer(KEY_A);
  try {
    const got = await new Promise((resolve) => {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.setTimeout(3000, () => resolve("timeout"));
      sock.on("connect", () => sock.write('{"type":"hello","key":"' + KEY_A + '"}\n'));
      // Even holding the right key, an old plaintext peer gets nowhere: its
      // JSON is not a ClientHello. This is why the registry carries a per-machine
      // flag instead of the host guessing.
      sock.on("data", (d) => resolve(`replied:${d}`));
      sock.on("error", () => resolve("error"));
      sock.on("close", () => resolve("closed"));
    });
    assert.ok(got !== "replied", `plaintext must not be answered, got ${got}`);
    assert.ok(!String(got).startsWith("replied:{"), `no protocol reply to plaintext, got ${got}`);
  } finally {
    server.close();
  }
});

test("keys are used as bytes when hex, and hashed when not", () => {
  // 64 hex characters are the 32 bytes they stand for...
  assert.deepEqual(tlspsk.keyBuf(KEY_A), Buffer.from(KEY_A, "hex"));
  assert.equal(tlspsk.keyBuf(KEY_A).length, 32);
  // ...but this field has always held whatever the owner pasted, and both ends
  // run this same function, so a non-hex key still yields one shared secret.
  const odd = "not-hex-but-long-enough-to-be-a-key!!";
  assert.equal(tlspsk.keyBuf(odd).length, 32);
  assert.deepEqual(tlspsk.keyBuf(odd), tlspsk.keyBuf(odd));
  assert.notDeepEqual(tlspsk.keyBuf(odd), tlspsk.keyBuf(odd + "x"));
  assert.throws(() => tlspsk.keyBuf("short"), /too short/);
});

test("the channel is pinned to TLS 1.2 PSK suites on both ends", () => {
  for (const opts of [tlspsk.serverOptions(KEY_A), tlspsk.clientOptions(KEY_A)]) {
    assert.equal(opts.minVersion, "TLSv1.2");
    assert.equal(opts.maxVersion, "TLSv1.2");
    assert.match(opts.ciphers, /^PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256$/);
    assert.ok(!opts.cert && !opts.key && !opts.ca, "no certificates are involved");
  }
});

test("the direct-HTTPS listener refuses TLS below 1.2, and HSTS stays opt-in", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server/server.js"), "utf8");
  const options = src.slice(src.indexOf("https.createServer"), src.indexOf("log.info(\"tls_enabled\""));
  assert.match(options, /minVersion:\s*"TLSv1\.2"/);
  // A shared-domain quick tunnel is the common way in, so HSTS must be asked
  // for and must never claim subdomains of a name we do not own.
  assert.match(src, /config\.hstsSeconds > 0 && isSecure\(req\)/);
  const header = src.match(/"Strict-Transport-Security",\s*`[^`]*`/)[0];
  assert.ok(!header.includes("includeSubDomains"), `HSTS must not claim subdomains: ${header}`);
  const { execFileSync } = require("child_process");
  const read = (days) => {
    const env = { ...process.env, WEB_TERMINAL_LOG_CONSOLE: "0" };
    if (days === undefined) delete env.WEB_TERMINAL_HSTS_DAYS;
    else env.WEB_TERMINAL_HSTS_DAYS = days;
    return Number(execFileSync(process.execPath,
      ["-e", 'process.stdout.write(String(require("./server/config").config.hstsSeconds))'],
      { cwd: path.join(__dirname, ".."), env, encoding: "utf8" }));
  };
  assert.equal(read(undefined), 0, "default: no HSTS");
  assert.equal(read("30"), 30 * 86400);
});

test("there is no session cap unless one is asked for", () => {
  const { execFileSync } = require("child_process");
  const read = (value) => {
    const env = { ...process.env, WEB_TERMINAL_LOG_CONSOLE: "0" };
    if (value === undefined) delete env.WEB_TERMINAL_MAX_SESSIONS;
    else env.WEB_TERMINAL_MAX_SESSIONS = value;
    return Number(execFileSync(process.execPath, ["-e", 'process.stdout.write(String(require("./server/config").config.maxSessions))'],
      { cwd: path.join(__dirname, ".."), env, encoding: "utf8" }));
  };
  // The 24 that used to be the default stopped one person opening their 25th
  // project, and nothing else, ever.
  assert.equal(read(undefined), 0, "default: unlimited");
  assert.equal(read("0"), 0);
  assert.equal(read("40"), 40, "a cap is still available to whoever wants one");
  assert.equal(read("-3"), 0);
  assert.equal(read("abc"), 0);
  // And the host only enforces a cap that is positive.
  const host = fs.readFileSync(path.join(__dirname, "..", "server/pty-host.js"), "utf8");
  assert.match(host, /if \(config\.maxSessions > 0\) \{[\s\S]*?Session limit reached/);
});

test("a ?view window watches without claiming any terminal's size", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src/main.js"), "utf8");
  // Opened at another size (a second monitor, a demo), a desktop window would
  // claim its size for every terminal and every agent on screen would redraw.
  assert.match(src, /const viewOnly = new URLSearchParams\(location\.search\)\.has\("view"\)/);
  assert.match(src, /const claimsSize = \(\) => !isMobile\(\) && !viewOnly/);
  // Every path that sends a size for an existing terminal goes through it: the
  // attach, the fit, and the restating when the window comes back into view.
  assert.match(src, /if \(document\.hidden \|\| !claimsSize\(\)\) \{\s*conn\.attach\(s\.id, 0, 0, false\)/);
  assert.match(src, /onResize: \(sessionId, cols, rows\) => \{\s*if \(!claimsSize\(\)\) return;/);
  assert.match(src, /if \(!claimsSize\(\)\) return; \/\/ a phone \(or \?view\)/);
});

test("a new pane claims the size it will keep, not its real height first", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src/lib/terminals.js"), "utf8");

  // 14/09: every page load claimed 331x77 (the pane's real height), then 331x100
  // (virtual rows) a second later. Claude Code redraws its ~97-line frame onto
  // the 77-row screen and the overflow scrolls away as copies - the stacked
  // banners and "tt" answers. So the size a pane is created at is the same
  // rule fitPane uses, and nothing sizes a pane with the bare fit addon while
  // virtual rows are on.
  const ensure = src.slice(src.indexOf("  ensure(sessionId"), src.indexOf("  /**", src.indexOf("  ensure(sessionId")));
  assert.doesNotMatch(ensure, /fit\.fit\(\)/, "ensure() must not size a pane without virtual rows");
  assert.match(ensure, /this\.targetSize\(fit\)/);
  const fitPane = src.slice(src.indexOf("  fitPane(pane)"), src.indexOf("  fitPane(pane)") + 1200);
  assert.match(fitPane, /this\.targetSize\(pane\.fit\)/, "one rule for both places");

  // And the rule itself, run for real.
  const body = src.match(/\n  targetSize\(fit\) \{([\s\S]*?)\n  \}\n/)[1];
  const targetSize = (virtualRows, dims) => new Function("fit", body).call({ virtualRows }, { proposeDimensions: () => dims });
  assert.deepEqual(targetSize(100, { cols: 331, rows: 77 }), { cols: 331, rows: 100 }, "virtual rows win over a shorter pane");
  assert.deepEqual(targetSize(100, { cols: 331, rows: 140 }), { cols: 331, rows: 140 }, "never less screen than fits");
  assert.deepEqual(targetSize(0, { cols: 331, rows: 77 }), { cols: 331, rows: 77 }, "off means the real height");
  assert.equal(targetSize(100, undefined), null, "an unmeasurable pane is not resized at all");
});

test("the wheel scrolls the scrollback, not the program", async () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src/lib/terminals.js"), "utf8");

  // The drag already took this rule; the wheel was left behind and bound for
  // touch only, so a desktop mouse had no way to scroll while Claude Code held
  // mouse reporting open.
  // Not attachCustomWheelEventHandler: xterm only consults that when it has NOT
  // installed its own mouse-reporting wheel listener, so the official hook is
  // silent in exactly the sessions this exists for. Capture phase on the pane,
  // the same way the drag handler gets in front of it.
  assert.equal(src.includes("term.attachCustomWheelEventHandler("), false, "the API is named in a comment, not called");
  assert.match(src, /addEventListener\(\s*"wheel"/);
  assert.match(src, /capture: true, passive: false/);
  assert.match(src, /bindWheelScroll\(term, el\)/, "every pane, not just the mobile ones");
  // Ctrl+wheel is the browser zooming, and taking it would be taking something
  // that was never ours.
  assert.match(src, /if \(ev\.ctrlKey\) return;/);
  // deltaMode 1 is lines and 2 is pages; treating either as pixels scrolls by
  // three pixels and looks broken.
  assert.match(src, /deltaMode === 1/);
  assert.match(src, /deltaMode === 2/);
  // At the ends of the buffer the wheel belongs to the page again. Since
  // virtual rows the handler walks two regions - the clipped live screen and
  // the scrollback - and only a walk that moved something claims the event.
  assert.match(src, /if \(this\.scrollContent\(pane, box, delta\)\)\s*\{\s*ev\.preventDefault\(\);/);
  // Up reads through the live screen first; down comes back through the
  // scrollback first. The order is the feature - and the touch drag goes
  // through the same walk, or a phone could never reach the clipped part.
  assert.match(src, /if \(delta < 0\) \{\s*slideView\(\);\s*slideScrollback\(\);/);
  assert.match(src, /return this\.scrollContent\(this\.panes\.get\(el\.dataset\.sessionId\), box, delta\);/);
});

test("an un-upgraded machine still offers the shells it used to", () => {
  const fs = require("fs");
  const path = require("path");
  const main = fs.readFileSync(path.join(__dirname, "..", "src/main.js"), "utf8");

  // A PTY host from before /api/profiles could ask it answers with an error.
  // Treating that as "no shells" would disable Create for a machine that worked
  // fine yesterday, so the dialog falls back to the local list and says so.
  assert.match(main, /const stale = !!\(entry && entry\.connected && entry\.error\)/);
  assert.match(main, /shells = stale \? state\.shells/);
  assert.match(main, /newShellNote/);
  assert.ok(
    fs.readFileSync(path.join(__dirname, "..", "src/ui/shell.js"), "utf8").includes('id="newShellNote"'),
    "the note needs somewhere to appear"
  );
});

test("the side panel is reachable on a phone, and says who is logged in", async () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const shell = fs.readFileSync(path.join(root, "src/ui/shell.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/style.css"), "utf8");
  const main = fs.readFileSync(path.join(root, "src/main.js"), "utf8");

  // main.js wires these by id at load time. A typo here is not a cosmetic bug:
  // el() would return nothing and the whole app would fail to start.
  const wired = [
    "menuBackdrop", "btnMenu", "btnProfile", "profileMenu", "profileWho",
    "profileAvatar", "profileName", "profileUsers", "profilePassword",
    "profileLogout", "btnKeyConfig",
  ];
  for (const id of wired) {
    assert.ok(shell.includes(`id="${id}"`), `#${id} must exist in the shell markup`);
    assert.ok(main.includes(`"${id}"`), `#${id} must be wired up in main.js`);
  }
  assert.ok(shell.includes('id="sideHead"'), "the panel header holds the name and the account chip");

  // The drawer button belongs to the mobile toolbar; .keys-tool is what the
  // desktop stylesheet hides.
  assert.match(shell, /id="btnMenu" class="keys-tool"/);

  // Key configuration moved into the panel, so nothing was lost by giving the
  // gear a new job.
  const panel = shell.slice(shell.indexOf("<aside id=\"sidebar\">"), shell.indexOf("</aside>"));
  assert.ok(panel.includes('id="btnKeyConfig"'), "key config moved into the panel");
  assert.ok(panel.includes('id="btnProfile"'), "the account chip lives beside the product name");

  // The panel must not simply be switched off on a phone any more.
  const mobile = css.slice(css.indexOf("/* ---------------------------------------------------------- responsive */"));
  assert.equal(
    /#sidebar\s*\{[^}]*display:\s*none/.test(mobile),
    false,
    "hiding #sidebar on a phone is what made the menu unreachable"
  );
  assert.match(css, /body\.menu-open #sidebar\s*\{[^}]*transform:\s*translateX\(0\)/);
});

test("the assist bar cannot resize the terminal it reports on", async () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const shell = fs.readFileSync(path.join(root, "src/ui/shell.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/style.css"), "utf8");

  // In the flow above <main id="panes"> the bar changed the PTY row count each
  // time it appeared. It has to overlay the terminal, not displace it.
  const panes = shell.indexOf('<main id="panes">');
  const assist = shell.indexOf('<div id="assist"');
  assert.ok(panes >= 0 && assist > panes, "#assist must live inside #panes");

  const rule = css.slice(css.indexOf("\n#assist {"));
  const body = rule.slice(0, rule.indexOf("}"));
  assert.match(body, /position:\s*absolute/, "#assist must be out of the layout flow");
});

test("Claude Assist stays silent on ordinary terminal output", async () => {
  const { analyse } = await import("../src/lib/claude.js");
  const r = analyse([
    "PS C:\\Users\\me> npm install",
    "added 214 packages in 6s",
    "PS C:\\Users\\me>",
  ]);
  assert.equal(r.kind, "none");
});

test("favourite keys never exceed the configured maximum", async () => {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const keys = await import("../src/lib/keys.js");
  const saved = keys.saveFavourites([
    "up", "down", "left", "right", "enter", "esc", "tab", "ctrlc", "ctrld", "ctrll",
  ]);
  assert.equal(saved.length, keys.MAX_FAVOURITES);
  assert.deepEqual(keys.loadFavourites(), saved);
  assert.deepEqual(keys.saveFavourites(["not-a-key"]), []);
  delete global.localStorage;
});

test("Claude Assist ignores a shell prompt that wrapped onto its own line", async () => {
  const { analyse } = await import("../src/lib/claude.js");
  // A narrow phone terminal wraps a long PowerShell prompt so one row holds
  // only ">". That must never be read as a highlighted menu row.
  const r = analyse([
    "PS C:" + String.raw`\work\projects\ai-code-desk`,
    ">",
    "go tu o nhap lenh: Tieng Viet day du",
    "PS C:" + String.raw`\work\projects`,
    ">",
  ]);
  assert.equal(r.kind, "none", "a wrapped prompt must not look like a menu");
});

test("the transcript keeps a line that was overwritten in place", () => {
  const { Screen } = require("../server/screen");
  const ESC = String.fromCharCode(27);
  const CRLF = String.fromCharCode(13, 10);
  const out = [];
  // Six rows, and a program that puts twelve lines through them by going back
  // to the top and overwriting - which is how Claude Code redraws an answer
  // taller than the screen. Stripping the escape codes and keeping the text
  // loses the overwritten half outright; obeying them saves each line as it is
  // replaced, and all twelve come back.
  const screen = new Screen(40, 6, (line) => out.push(line));
  screen.write(ESC + "[2J" + ESC + "[H");
  for (let i = 1; i <= 6; i++) screen.write("muc " + i + CRLF);
  screen.write(ESC + "[H"); // back to the top, over the top
  for (let i = 7; i <= 12; i++) screen.write("muc " + i + CRLF);
  screen.flush();

  const text = out.map((l) => l.trim());
  for (let i = 1; i <= 12; i++) {
    assert.ok(text.includes("muc " + i), "muc " + i + " phai duoc giu lai");
  }
});

test("a line still being typed is not mistaken for a replacement", () => {
  const { Screen } = require("../server/screen");
  const ESC = String.fromCharCode(27);
  const out = [];
  const screen = new Screen(40, 6, (line) => out.push(line));
  // Streamed a word at a time, then a spinner ticking in place. Neither is a
  // new line; recording every step is what made the old transcripts unreadable.
  for (const part of ["Chay", " render", " cum dau"]) screen.write(part);
  for (const t of ["(1s)", "(2s)", "(3s)"]) screen.write(ESC + "[H" + ESC + "[2K" + "* Doing... " + t);
  screen.flush();

  const text = out.map((l) => l.trim());
  assert.deepEqual(text, ["Chay render cum dau", "* Doing... (3s)"]);
});

test("the transcript drops what the tool said to itself", () => {
  const { format } = require("../server/agent-log");
  // A spinner ticking, the same failing hook over and over, the box round the
  // prompt, and a sentence that was half drawn before it was finished. Measured
  // on one real session, 477 of 1159 lines were the first kind alone.
  const out = format([
    "Bạn muốn tôi",
    "✻ Roosting… (running stop hook · 2m 7s · ↓ 4.0k tokens)",
    "✻ Roosting… (running stop hook · 2m 8s · ↓ 4.1k tokens)",
    "⎿  PreToolUse:Bash hook error",
    "⎿  PreToolUse:Bash hook error",
    "⎿  PreToolUse:Bash hook error",
    "────────────────────────",
    "Bạn muốn tôi thực hiện bước nào tiếp theo?",
  ]);
  assert.deepEqual(out.split(String.fromCharCode(10)), [
    "⎿  PreToolUse:Bash hook error  (x3)",
    "Bạn muốn tôi thực hiện bước nào tiếp theo?",
  ]);
});

test("a bullet in an answer is not a spinner", () => {
  const { isStatus } = require("../server/screen");
  // The first version of this test failed for the right reason: "-" had been
  // put among the spinner glyphs, so every bullet point in every answer was
  // read as the tool talking to itself and thrown away.
  assert.equal(isStatus("- Quota ảnh Vertex: request thứ 6 dính 429"), false);
  assert.equal(isStatus("5. Việc tiếp theo"), false);
  assert.equal(isStatus("✻ Pouncing…"), true);
  assert.equal(isStatus("Roosting… (running stop hook · 2m 7s ·"), true);
});

test("agent detection matches the command the user submitted", () => {
  const { detectAgent } = require("../server/agent-log");
  assert.equal(detectAgent("claude").kind, "claude");
  assert.equal(detectAgent("  claude --resume ").kind, "claude");
  assert.equal(detectAgent(String.raw`& "C:\Users\me\.local\bin\claude.exe"`).kind, "claude");
  assert.equal(detectAgent("antigravity").kind, "antigravity");
  assert.equal(detectAgent("agy").kind, "antigravity");
  assert.equal(detectAgent("codex").kind, "codex");
  assert.equal(detectAgent("codex --full-auto").kind, "codex");
  assert.equal(detectAgent(String.raw`C:\Users\me\AppData\Roaming\npm\codex.cmd`).kind, "codex");
  assert.equal(detectAgent("gemini").kind, "gemini");
  assert.equal(detectAgent("gemini -m gemini-2.5-pro").kind, "gemini");
  assert.equal(detectAgent("codex").file, ".codexhis.txt");
  assert.equal(detectAgent("gemini").file, ".geminihis.txt");
  assert.equal(detectAgent("npm run claudette"), null);
  assert.equal(detectAgent("git log --grep codexfix"), null);
  assert.equal(detectAgent("echo hello"), null);
  assert.equal(detectAgent(""), null);
});

test("an agent launcher is offered only where that agent is installed", () => {
  const profiles = require("../server/profiles");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "wt-bin-"));
  const saved = process.env.PATH;
  const exe = (name) => (process.platform === "win32" ? `${name}.cmd` : name);
  try {
    // A PATH with only codex on it: Codex is offered, the others are not - a
    // button that types a missing command only prints an error.
    fs.writeFileSync(path.join(bin, exe("codex")), "");
    process.env.PATH = bin;
    let ids = profiles.launchers().map((l) => l.id);
    assert.ok(ids.includes("codex"), ids.join(","));
    assert.ok(!ids.includes("gemini"));
    assert.ok(!ids.includes("antigravity"));
    assert.equal(profiles.launchers().find((l) => l.id === "codex").autoRun, "codex");

    // Antigravity answers to either of its names.
    fs.writeFileSync(path.join(bin, exe("agy")), "");
    fs.writeFileSync(path.join(bin, exe("gemini")), "");
    ids = profiles.launchers().map((l) => l.id);
    assert.ok(ids.includes("antigravity") && ids.includes("gemini"));
    assert.equal(profiles.launchers().find((l) => l.id === "antigravity").autoRun, "agy");

    // Agents come before Python and Node: the sidebar shows the first ten.
    assert.ok(ids.indexOf("gemini") < ids.indexOf("python"));
    // Claude Code is always there - it is found by its install path, not PATH.
    assert.ok(ids.includes("claude"));
  } finally {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
test("spoken commands are told apart from dictation", async () => {
  const { isReadCommand } = await import("../src/lib/voice.js");
  assert.equal(isReadCommand("đọc kết quả"), true);
  assert.equal(isReadCommand("Đọc kết quả."), true);
  assert.equal(isReadCommand("doc ket qua"), true);
  assert.equal(isReadCommand("read the result"), true);
  assert.equal(isReadCommand("thêm tính năng đọc kết quả cho app"), false);
  assert.equal(isReadCommand("làm tiếp"), false);
  assert.equal(isReadCommand(""), false);
});

test("reading the result skips the echoed command and the prompt", async () => {
  const { readableAnswer } = await import("../src/lib/voice.js");
  const lines = [
    "PS C:" + String.raw`\du an` + "> npm test",
    "npm test",
    "  ✔ tat ca deu pass",
    "  50 tests, 0 failures",
    "PS C:" + String.raw`\du an` + ">",
  ];
  const spoken = readableAnswer(lines, "npm test");
  assert.match(spoken, /tat ca deu pass/);
  assert.match(spoken, /50 tests/);
  assert.equal(spoken.includes("PS C:"), false, "the prompt must not be read out");
});

test("reading the result falls back to the last lines", async () => {
  const { readableAnswer } = await import("../src/lib/voice.js");
  const spoken = readableAnswer(["mot", "hai", "hai", "ba"], "");
  assert.equal(spoken, "mot. hai. ba", "repeated frames collapse");
});


/**
 * One turn of Claude Code as it is actually painted: our message echoed back,
 * a thinking block, tool calls with their output, a spinner, the answer, and
 * the live input box underneath it all.
 */
const CLAUDE_SCREEN = [
  "PS C:\\du an> claude",
  "",
  "> sua loi ban phim iOS",
  "",
  "\u273b Thinking\u2026",
  "",
  "  Nguoi dung muon ban phim chi hien khi bam o nhap.",
  "  Minh can bo handler touchstart trong terminals.js.",
  "",
  "\u25cf Toi se bo handler touchstart.",
  "",
  "\u25cf Read(src/lib/terminals.js)",
  "  \u23bf  Read 278 lines",
  "",
  "\u25cf Bash(npm test)",
  "  \u23bf  93 passing",
  "     0 failing",
  "",
  "\u273b Herding\u2026 (12s \u00b7 \u2191 1.2k tokens \u00b7 esc to interrupt)",
  "",
  "\u25cf Da sua xong. Ban phim gio chi hien khi bam vao o nhap,",
  "  va 93 test van pass.",
  "",
  "\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e",
  "\u2502 >                  \u2502",
  "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f",
  "  ? for shortcuts",
];

test("reading a Claude turn keeps the answer and drops the thinking", async () => {
  const { readableAnswer } = await import("../src/lib/voice.js");
  const spoken = readableAnswer(CLAUDE_SCREEN, "sua loi ban phim iOS");

  assert.match(spoken, /Toi se bo handler touchstart/);
  assert.match(spoken, /Da sua xong/, "the displayed answer is read");
  assert.match(spoken, /93 test van pass/, "a wrapped answer line stays with it");

  assert.equal(spoken.includes("Nguoi dung muon"), false, "thinking is not displayed");
  assert.equal(spoken.includes("Minh can bo handler"), false, "thinking is not displayed");
  assert.equal(spoken.includes("Read(src"), false, "tool calls are not the answer");
  assert.equal(spoken.includes("Bash(npm"), false, "tool calls are not the answer");
  assert.equal(spoken.includes("93 passing"), false, "tool output is not the answer");
  assert.equal(spoken.includes("esc to interrupt"), false, "the spinner is chrome");
  assert.equal(spoken.includes("for shortcuts"), false, "the hint line is chrome");
});

test("reading starts at the last command, not an earlier one", async () => {
  const { readableAnswer } = await import("../src/lib/voice.js");
  const lines = [
    "PS C:\\du an> npm test",
    "ket qua cu",
    "PS C:\\du an> git status",
    "nothing to commit",
    "PS C:\\du an>",
  ];
  const spoken = readableAnswer(lines, "git status");
  assert.match(spoken, /nothing to commit/);
  assert.equal(spoken.includes("ket qua cu"), false, "the previous command's output is old news");
});

test("what is still sitting in the input box is not treated as run", async () => {
  const { readableAnswer } = await import("../src/lib/voice.js");
  const lines = [
    "\u25cf Ket qua that su o day.",
    "",
    "\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e",
    "\u2502 > chua gui  \u2502",
    "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f",
  ];
  const spoken = readableAnswer(lines, "chua gui");
  assert.match(spoken, /Ket qua that su/);
});

test("long answers are cut into chunks a TTS server can keep up with", async () => {
  const { splitForSpeech } = await import("../src/lib/voice.js");
  assert.deepEqual(splitForSpeech(""), []);

  const chunks = splitForSpeech("Cau mot. Cau hai! Cau ba?", 12);
  assert.ok(chunks.length >= 3, "short sentences are not glued past the limit");
  assert.equal(chunks.join(" "), "Cau mot. Cau hai! Cau ba?", "no word is lost");

  const long = splitForSpeech("a".repeat(500), 100);
  assert.ok(
    long.every((c) => c.length <= 100),
    "a single over-long sentence is broken hard rather than sent whole"
  );
  assert.equal(long.join("").length, 500);
});

test("a streamed WAV is re-headered with its real length", async () => {
  const { repackWav, wavHeader } = require("../server/tts.js");
  const pcm = Buffer.alloc(2400, 7);
  // What VieNeu sends: a header claiming 100M frames, then however much audio
  // it actually produced.
  const lying = Buffer.concat([wavHeader({ bytes: 400_000_000 }), pcm]);

  const fixed = repackWav(lying);
  assert.equal(fixed.length, 44 + pcm.length);
  assert.equal(fixed.readUInt32LE(40), pcm.length, "the data chunk states the real size");
  assert.equal(fixed.readUInt32LE(4), 36 + pcm.length, "so does RIFF");
  assert.equal(fixed.readUInt32LE(24), 24000, "sample rate survives");
  assert.deepEqual(fixed.subarray(44), pcm, "the audio itself is untouched");

  assert.throws(() => repackWav(Buffer.from("not audio at all")), /WAV/);
});

test("a tap belongs to the program, a drag scrolls the scrollback", async () => {
  const { createDragTracker } = await import("../src/lib/gesture.js");
  const g = createDragTracker(8);

  // A tap: the finger barely moves, so nothing is claimed as a scroll and the
  // touch stays the running program's to handle.
  g.start(300);
  assert.deepEqual(g.move(302), { dragging: false, delta: 0 });
  assert.deepEqual(g.move(304), { dragging: false, delta: 0 });
  assert.equal(g.end(), false, "a tap is not a drag");

  // A drag: past the threshold the viewport moves by what the finger moved.
  g.start(300);
  assert.equal(g.move(305).dragging, false, "5px is still a tap");
  const first = g.move(340);
  assert.equal(first.dragging, true);
  assert.equal(first.delta, -40, "dragging down shows older lines");
  assert.deepEqual(g.move(300), { dragging: true, delta: 40 }, "and back again");
  assert.equal(g.end(), true);
});

test("a drag stays a drag even if the finger pauses", async () => {
  const { createDragTracker } = await import("../src/lib/gesture.js");
  const g = createDragTracker(8);
  g.start(100);
  assert.equal(g.move(150).dragging, true);
  assert.deepEqual(g.move(150), { dragging: true, delta: 0 }, "a pause is not a tap");
  assert.equal(g.move(151).dragging, true);
  g.end();
  assert.equal(g.dragging, false, "and it resets for the next gesture");
});

test("a flick keeps gliding, a slow drag does not", async () => {
  const { createDragTracker, glide } = await import("../src/lib/gesture.js");

  // A quick flick: 40px in 16ms.
  const fast = createDragTracker(8);
  fast.start(400, 0);
  fast.move(360, 16);
  fast.move(320, 32);
  assert.ok(fast.velocity > 0.5, `a flick has speed, got ${fast.velocity}`);

  // The same distance taken slowly is not a flick.
  const slow = createDragTracker(8);
  slow.start(400, 0);
  slow.move(360, 400);
  slow.move(320, 800);
  assert.ok(Math.abs(slow.velocity) < 0.2, `a slow drag must not fling, got ${slow.velocity}`);
});

test("the glide slows down and stops", async () => {
  const { glide } = await import("../src/lib/gesture.js");
  const steps = [];
  let clock = 0;
  const queued = [];
  glide({
    velocity: 2,
    onScroll: (d) => { steps.push(d); return true; },
    now: () => clock,
    schedule: (cb) => { queued.push(cb); return queued.length; },
    cancel: () => {},
  });
  // Run frames by hand so the test does not depend on a real clock.
  for (let i = 0; i < 400 && queued.length; i++) { const cb = queued.shift(); clock += 16; cb(); }
  assert.ok(steps.length > 5, `it should coast for a while, got ${steps.length} frames`);
  assert.ok(steps[0] > steps[steps.length - 1], "each frame moves less than the last");
  assert.equal(queued.length, 0, "and it stops instead of running for ever");
});

test("a glide stops at the end of the buffer", async () => {
  const { glide } = await import("../src/lib/gesture.js");
  let frames = 0;
  const queued = [];
  let clock = 0;
  glide({
    velocity: 2,
    onScroll: () => { frames += 1; return false; }, // already at the top
    now: () => clock,
    schedule: (cb) => { queued.push(cb); return 1; },
    cancel: () => {},
  });
  while (queued.length) { const cb = queued.shift(); clock += 16; cb(); }
  assert.equal(frames, 1, "it gives up as soon as the view cannot move");
});

test("a tap never starts a glide", async () => {
  const { glide } = await import("../src/lib/gesture.js");
  let called = false;
  const stop = glide({ velocity: 0.01, onScroll: () => { called = true; return true; },
    now: () => 0, schedule: () => 1, cancel: () => {} });
  assert.equal(called, false);
  assert.equal(typeof stop, "function");
});

test("a glide that starts in the same millisecond as the release still runs", async () => {
  const { glide } = await import("../src/lib/gesture.js");
  // The first frame can land with zero elapsed time. Asking for 0 pixels tells
  // us nothing about the ends of the buffer, so it must not stop the glide.
  let moves = 0;
  const queued = [];
  let clock = 0;
  glide({
    velocity: 2,
    onScroll: (d) => { if (d !== 0) moves += 1; return true; },
    now: () => clock,
    schedule: (cb) => { queued.push(cb); return queued.length; },
    cancel: () => {},
  });
  queued.shift()();                       // frame 1: no time has passed
  assert.equal(queued.length, 1, "the glide must still be scheduled");
  for (let i = 0; i < 200 && queued.length; i++) { const cb = queued.shift(); clock += 16; cb(); }
  assert.ok(moves > 5, `it should keep moving afterwards, got ${moves}`);
});

/* ------------------------------------------------------------------ *
 * Reading a Claude Code screen as a list of steps
 * ------------------------------------------------------------------ */

/** A screen the way Claude Code actually paints one. */
const TRANSCRIPT_SCREEN = [
  "> sửa lại hàm parse cho đúng",
  "",
  "✻ Thinking…",
  "  Cần xem file trước khi sửa.",
  "  Có hai chỗ dùng nó.",
  "",
  "● Read(src/lib/parse.ts)",
  "  ⎿  Read 120 lines",
  "",
  "● Update(src/lib/parse.ts)",
  "  ⎿  Updated src/lib/parse.ts with 33 additions and 0 removals",
  "",
  "● Bash(npm run build)",
  "  ⎿  built in 4.2s",
  "● Bash(npm test)",
  "  ⎿  105 passing",
  "● Bash(git status)",
  "  ⎿  clean",
  "",
  "● Đã sửa xong hàm parse.",
  "  Build và test đều xanh.",
  "",
  "✻ Đang nghĩ… (12s · ↑ 3.4k tokens · esc to interrupt)",
  "╭──────────────────────────────────────────╮",
  "│ > lệnh đang gõ dở                        │",
  "╰──────────────────────────────────────────╯",
  "  ⏵⏵ accept edits on",
];

test("a Claude screen collapses to the steps it represents", async () => {
  const { parseTranscript, summarise } = await import("../src/lib/transcript.js");
  const steps = parseTranscript(TRANSCRIPT_SCREEN);
  const kinds = steps.map((s) => s.kind);

  assert.deepEqual(kinds, ["user", "thinking", "tool", "tool", "runs", "prose"]);
  assert.equal(steps[0].text, "sửa lại hàm parse cho đúng");
  assert.equal(steps[2].label, "Đọc src/lib/parse.ts");
  assert.equal(steps[3].label, "Sửa src/lib/parse.ts");
  // The diff stat is the one detail worth keeping from folded tool output.
  assert.equal(steps[3].detail, "+33 -0");
  assert.equal(steps[4].count, 3, "three shell calls read better as one line");
  assert.match(summarise(steps), /Chạy 3 lệnh/);
  // Newline, not space: the answer keeps the shape it was written in.
  assert.equal(steps[5].text, "Đã sửa xong hàm parse.\nBuild và test đều xanh.");
});

test("the composer, the spinner and the shell prompt are not part of the transcript", async () => {
  const { parseTranscript } = await import("../src/lib/transcript.js");
  const steps = parseTranscript(TRANSCRIPT_SCREEN);
  const text = JSON.stringify(steps);
  // What is still being typed was never sent, and the status rows are chrome.
  assert.ok(!text.includes("đang gõ dở"), "the composer must not appear");
  assert.ok(!text.includes("accept edits"), "the mode hint must not appear");
  assert.ok(!text.includes("tokens"), "the token counter must not appear");
});

test("a repainted frame does not duplicate the answer", async () => {
  const { parseTranscript } = await import("../src/lib/transcript.js");
  // A TUI redraws the same row; the same sentence twice is one sentence.
  const steps = parseTranscript(["● Đã xong.", "  Đã xong.", "  Còn một việc nữa."]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, "Đã xong.\nCòn một việc nữa.");
});

test("a plain shell session is recognised as not being Claude", async () => {
  const { looksLikeClaude } = await import("../src/lib/transcript.js");
  assert.equal(looksLikeClaude(["PS C:\work> dir", "Volume in drive C"]), false);
  assert.equal(looksLikeClaude(TRANSCRIPT_SCREEN), true);
});

test("a real Claude Code v2.1 screen reads as an answer, not as nothing", async () => {
  const { parseTranscript, looksLikeClaude } = await import("../src/lib/transcript.js");
  // Captured from a live session: "tt" answered in full, then the screen sat
  // idle. Every assumption the parser was built on is checked against it,
  // because v2.1 draws neither the bullet nor the result marker it relied on.
  const lines = require("./fixtures-claude-v21.json");

  assert.equal(looksLikeClaude(lines), true, "the only marker left sits below the cursor");

  const steps = parseTranscript(lines);
  const prose = steps.find((s) => s.kind === "prose");
  assert.ok(prose, "recording nothing at all is the bug this fixes");

  const rows = prose.text.split("\n");
  assert.ok(rows.length > 20, `expected the whole briefing, got ${rows.length} rows`);
  assert.equal(rows.length - new Set(rows).size, 0, "a repainted line must not be read twice");

  for (const heading of ["2. Đã hoàn thành", "4. Blocker / Vấn đề", "8. Discrepancies"]) {
    assert.ok(rows.includes(heading), `missing heading: ${heading}`);
  }

  // The thinking is counted, never quoted.
  assert.equal(steps.filter((s) => s.kind === "thinking").length, 1);
  assert.equal(prose.text.includes("Baked for"), false, "how long it thought is not the answer");

  // Chrome below the cursor stays out of the summary.
  for (const junk of ["auto mode on", "Transcript saving is off", "shift+tab"]) {
    assert.equal(prose.text.includes(junk), false, `chrome leaked in: ${junk}`);
  }
});

test("the noisy screen from a hook failure reads as two lines, not a wall", async () => {
  const { parseTranscript } = await import("../src/lib/transcript.js");
  // What the phone actually showed: Claude's own collapsed run line, the hook
  // error folded under it, and the whole block painted again.
  const steps = parseTranscript([
    "● Ran 2 shell commands",
    "  ⎿  PreToolUse:Bash hook error",
    "     Failed with non-blocking status code: rtk: command not found",
    "● Ran 2 shell commands",
    "  ⎿  PreToolUse:Bash hook error",
    "● Bash(npm test)",
    "  ⎿  105 passing",
    "● Xong.",
  ]);
  assert.deepEqual(steps.map((s) => s.kind), ["runs", "prose"]);
  assert.equal(steps[0].count, 5, "2 + 2 collapsed runs plus the single call");
  assert.equal(steps[1].text, "Xong.");
});

test("an argument cut off by the screen edge is still a tool call", async () => {
  const { parseTranscript } = await import("../src/lib/transcript.js");
  const steps = parseTranscript(["● Read(src/very/long/path/that/ran/off/the/screen.ts"]);
  assert.equal(steps[0].kind, "tool");
  assert.match(steps[0].label, /^Đọc /);
});

test("a screen too small to hold the answer still gives up the whole answer", async () => {
  const { reconstruct } = require("../server/replay");
  const ESC = String.fromCharCode(27);
  const NL = String.fromCharCode(13, 10);
  // A TUI that reprints a growing answer, drawing only what fits. This is what
  // Claude Code does, and why the terminal cannot be scrolled back to the top
  // of a long reply: once the answer outgrows the screen every reprint clears
  // and redraws the tail, so the opening sections are not in the scrollback -
  // they are simply gone. Only the recording still has them.
  let stream = "";
  for (let i = 1; i <= 20; i++) {
    stream += ESC + "[H" + ESC + "[2J";
    for (let n = Math.max(1, i - 4); n <= i; n++) stream += "muc " + n + NL;
  }
  const lines = (await reconstruct(stream, { cols: 40, rows: 6 })).map((l) => l.trim());
  for (let n = 1; n <= 20; n++) {
    assert.ok(lines.includes("muc " + n), "muc " + n + " phai duoc dung lai");
  }
  assert.equal(new Set(lines).size, lines.length, "khong duoc lap");
});

test("a line drawn as it is typed is kept once, in full", async () => {
  const { collapseGrowth } = require("../server/replay");
  // Streamed output redraws the same line as it grows. All three fragments are
  // real frames; only the finished sentence is worth reading, and it belongs
  // where the sentence started, not where it finished.
  const kept = collapseGrowth(
    [" truoc", "Chay render", "Chay render cum", "Chay render cum dau tien", " sau"].map((text) => ({ text }))
  );
  assert.deepEqual(
    kept.map((k) => k.text.trim()),
    ["truoc", "Chay render cum dau tien", "sau"]
  );
});

test("two replays of one session do not stack on top of each other", async () => {
  const { Terminal } = require("@xterm/headless");
  // A page attaches, then the PTY host reconnects and everything re-attaches:
  // two attaches for one terminal, each answered with the whole scrollback.
  // reset() clears at once but write() only queues, so replaying naively ran
  // clear, queue, clear, queue and the bytes arrived back to back with nothing
  // clearing between them - the session appeared on screen twice, and with the
  // opening scrolled out of reach. Measured, not supposed: this is the shape of
  // the duplicated scrollback a real "tt" produced.
  const history = ["dong mot", "dong hai", "dong ba", ""].join(String.fromCharCode(13, 10));
  const count = (term) => {
    const buf = term.buffer.active;
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).trim() === "dong hai") n++;
    }
    return n;
  };

  const naive = new Terminal({ cols: 80, rows: 10, scrollback: 2000, allowProposedApi: true });
  naive.reset();
  naive.write(history);
  naive.reset();
  await new Promise((done) => naive.write(history, done));
  assert.equal(count(naive), 2, "clearing before the queue drains is what duplicated it");

  // Serialised the way replaceHistory now does it: the second replay resets
  // only once the first has finished parsing.
  const queued = new Terminal({ cols: 80, rows: 10, scrollback: 2000, allowProposedApi: true });
  queued.reset();
  await new Promise((done) => queued.write(history, done));
  queued.reset();
  await new Promise((done) => queued.write(history, done));
  assert.equal(count(queued), 1, "one session, replayed twice, is still one session");
});

test("a tap on the cursor line hands the phone keyboard to the terminal", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src/lib/terminals.js"), "utf8");
  // The phone keyboard belongs to the command box by default - but Claude Code
  // has its own prompt, and answering it through the box is an extra hop per
  // keystroke. A tap on the cursor's line (or a double tap) flips the hidden
  // xterm textarea into a focusable one so the keys go straight to the PTY;
  // blurring flips it back. Both directions must exist, or the phone is stuck
  // one way or the other.
  assert.match(src, /helper\.readOnly = !on/);
  assert.match(src, /"inputmode", on \? "text" : "none"/);
  assert.match(src, /addEventListener\("blur", \(\) => setDirect\(false\)\)/);
  assert.match(src, /doubleTap \|\| onCursorLine/);
});

test("the marker says what is in the terminal, not just that it is alive", async () => {
  const { markState, markLabel } = await import("../src/lib/machines.js");
  // Shape is which machine; colour is what is inside. The question a row of
  // tabs actually answers is "which one is Claude in", so an agent that has
  // worked here outranks the plain fact of a running shell.
  assert.equal(markState("running", ""), "shell");
  assert.equal(markState("running", "claude"), "agent");
  assert.equal(markState("running", "antigravity"), "agent");
  // Closed wins over everything: a terminal Claude used is still a closed one.
  assert.equal(markState("exited", "claude"), "exited");

  assert.match(markLabel("running", "claude"), /Claude/);
  assert.match(markLabel("running", "antigravity"), /Antigravity/);
  assert.match(markLabel("running", "codex"), /Codex/);
  const { t } = await import("../src/lib/i18n.js");
  assert.equal(markLabel("exited", "claude"), t("đã đóng"));
});

test("the history panel lists closed terminals only", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src/ui/history.js"), "utf8");
  // A running terminal is already a tab and a card in the session list; a third
  // appearance here read as the same project listed twice. The row is not
  // deleted when the terminal is reopened - it is the identity reopen takes
  // over - it just steps out of the list while it is alive.
  assert.match(src, /this\.entries\.filter\(\(e\) => e\.status !== "running"\)/);
});

test("tabs keep the order they were dragged into, across a reopen", () => {
  const fs = require("fs");
  const path = require("path");
  const main = fs.readFileSync(path.join(__dirname, "..", "src/main.js"), "utf8");
  // Ordered by lineage, not session id: a terminal reopened from the history
  // is a new session but the same terminal, and it belongs where it was.
  assert.match(main, /rank\.get\(s\.lineage \|\| s\.id\)/);
  assert.match(main, /localStorage\.setItem\("wt\.tabOrder"/);
  // The target index is read again after the splice, not adjusted by hand:
  // removing the dragged tab shifts everything after it left by one.
  assert.match(main, /const at = list\.findIndex\(\(s\) => s\.id === targetId\);/);
});

test("a bare claude is named after the tab; anything else is left alone", () => {
  const profiles = require("../server/profiles");
  // Claude Code names a Remote Control session after the hostname plus a
  // random word, so claude.ai shows a wall of near-identical long names. The
  // tab already carries the name the work is known by.
  for (const init of [profiles.PS_INIT, profiles.BASH_INIT, profiles.ZSH_INIT]) {
    assert.match(init, /--remote-control/, "every shell wraps claude");
    // --remote-control turns the feature on but does not name anything: on
    // v2.1.268 /status still said "Session name: /rename to add a name" after
    // it. --name is what the session ends up called.
    assert.match(init, /--name/, "the tab name is passed to the flag that sets it");
    assert.match(init, /WT_TITLE_FILE/, "the name is read at call time, not at spawn");
  }
  // Only a bare invocation. Guessing which of -p, --resume or a prompt would
  // tolerate an extra flag is how a convenience becomes a trap.
  assert.match(profiles.PS_INIT, /\$args\.Count -eq 0/);
  assert.match(profiles.BASH_INIT, /\[ \$# -eq 0 \]/);
  // command/Get-Command, or the wrapper calls itself forever.
  assert.match(profiles.BASH_INIT, /command claude "\$@"/);
  // Application, not the .exe: it skips this very function so the lookup
  // cannot find itself, and it resolves .cmd or a shim on a machine where
  // claude is installed in some other shape.
  assert.match(profiles.PS_INIT, /Get-Command claude -CommandType Application/);
});

test("the tab strip can be reached with a mouse", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "src/style.css"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "src/main.js"), "utf8");
  // Hiding the scrollbar suits a finger, which drags the strip directly. On a
  // desktop it left tabs past the edge unreachable - not hard to see, but with
  // no way to get to them - so a fine pointer gets a real scrollbar back.
  assert.match(css, /@media \(pointer: fine\)[^}]*#tabs \{[^}]*scrollbar-width: thin/s);
  // And the wheel scrolls it sideways: the strip only scrolls horizontally and
  // a wheel only turns vertically, so the first gesture anyone tries did
  // nothing at all.
  assert.match(main, /el\("tabs"\)\.addEventListener\(\s*"wheel"/);
  assert.match(main, /strip\.scrollLeft = before \+ delta/);
});

test("a host restart cannot shrink the saved workspace", () => {
  const fs = require("fs");
  const path = require("path");
  const main = fs.readFileSync(path.join(__dirname, "..", "src/main.js"), "utf8");
  // Saving the running sessions is what turned a PTY host restart into data
  // loss: the host comes back owning nothing, the page sees six live tabs where
  // there were twenty-five, and saves six. The nineteen were still in the
  // history, one click from being reopened.
  assert.match(main, /const kept = state\.savedTabs\.filter\(/);
  assert.match(main, /!seen\.has\(t\.lineage\) && !state\.closedLineages\.has\(t\.lineage\)/);
  assert.match(main, /const tabs = \[\.\.\.live, \.\.\.kept\];/);
  // Only a deliberate close may shrink it.
  assert.match(main, /state\.closedLineages\.add\(s\.lineage \|\| s\.id\)/);
  // And the carried list has to be seeded from what was on disk, or the first
  // save of a fresh page would still write only what is running.
  assert.match(main, /state\.savedTabs = tabs\s*\n?\s*\.filter\(\(t\) => t\.state !== "gone"\)/);
  // "Forget" must really forget, rather than being restored by the next save.
  assert.match(main, /state\.savedTabs = \[\];/);
});
