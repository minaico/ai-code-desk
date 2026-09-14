"use strict";
/**
 * Transcript logging for AI CLI sessions (Claude Code, Antigravity, Codex, Gemini CLI).
 *
 *   <cwd>/.claudehis.txt   for a Claude Code session
 *   <cwd>/.agyhis.txt      for an Antigravity session
 *   <cwd>/.codexhis.txt    for a Codex session
 *   <cwd>/.geminihis.txt   for a Gemini CLI session
 *
 * What you typed is captured from the input stream, so it is exact. What the
 * agent answered is captured by running the PTY output through a screen - see
 * screen.js - and keeping each line at the moment something replaces it. The
 * live stream sent to the browser is never touched; this module only reads a
 * copy.
 *
 * The screen is the whole point. These tools repaint constantly, and one that
 * redraws an answer taller than the terminal overwrites its own opening; the
 * escape codes are the only record of which line replaced which, so stripping
 * them and keeping the text loses exactly the part that scrolled out of reach.
 *
 * Honest limitation: this is still a rendering of what appeared on screen, not
 * a protocol-level message log, and it cannot be one without an API from the
 * tool. But nothing that was drawn is missing from it.
 */
const fs = require("fs");
const path = require("path");
const { Screen, isStatus } = require("./screen");

const IDLE_FLUSH_MS = 4000;
const MAX_LINES = 20000;

/**
 * Turn the finished lines into something worth reading.
 *
 * Three kinds of noise, all of them the TUI talking to itself rather than to
 * you. Spinners and their timers - measured on one session, 477 of 1159 lines
 * were "Roosting... (running stop hook 2m 8s)" and its neighbours, each one a
 * different second so nothing recognised them as the same line. Tool output
 * that repeats: one failing hook printed the same two lines 67 times. And a row
 * redrawn unchanged, which is the same row, not a new one.
 *
 * What a repeated tool line meant is worth keeping even when the repetition is
 * not, so it is kept once and counted.
 */
function format(lines) {
  const out = [];
  const toolAt = new Map();
  for (const raw of lines) {
    const text = String(raw).replace(/\s+$/, "");
    if (!text.trim()) continue;
    if (isStatus(text)) continue;
    if (isChrome(text)) continue;

    if (/^\s*[⎿└├╰]/.test(text) || text.trimStart().startsWith("⎿")) {
      // Tool output. The same line coming back is the same call failing again.
      const at = toolAt.get(text);
      if (at !== undefined) {
        out[at].count += 1;
        continue;
      }
      toolAt.set(text, out.length);
      out.push({ text, count: 1 });
      continue;
    }

    if (out.length && out[out.length - 1].text === text) continue;
    out.push({ text, count: 1 });
  }
  // A line that comes back later in the same answer is a half-drawn version of
  // itself: the tool reprinted the block as it grew, so the same sentence
  // appears mid-stream and again in the finished text. The last one is the
  // finished one, and it is the one standing in the right place.
  const lastAt = new Map();
  out.forEach((e, i) => lastAt.set(e.text, i));
  const kept = out.filter((e, i) => lastAt.get(e.text) === i);

  // And a line that a later one merely continues was that line half drawn.
  const whole = kept.filter((e, i) => {
    for (let k = i + 1; k < kept.length; k++) {
      const later = kept[k].text;
      if (later.length > e.text.length && later.startsWith(e.text)) return false;
    }
    return true;
  });

  // A heading with no air around it reads as a wall.
  const body = [];
  for (const e of whole) {
    const text = e.count > 1 ? `${e.text}  (x${e.count})` : e.text;
    if (isHeading(e.text) && body.length && body[body.length - 1] !== "") body.push("");
    body.push(text);
  }
  return body.join("\n");
}

/**
 * Furniture rather than conversation: the box around the prompt, the splash
 * logo, the mode line, the empty prompt itself. Drawn every frame, said by
 * nobody.
 */
function isChrome(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^[\u2500-\u257f\s]+$/.test(t)) return true; // rules and borders
  if (/^[\u2580-\u259f\s]+$/.test(t)) return true; // the block-drawn logo
  if (/^\u23f5/.test(t)) return true; // the auto-mode line
  if (/^[\u276f>\s]+$/.test(t)) return true; // an empty prompt
  return false;
}

/** A section heading in an answer: short, numbered or marked, not a sentence. */
function isHeading(text) {
  const t = text.trim();
  if (t.length > 60) return false;
  return /^\d+\.\s+\S/.test(t) ? !/[.,;:]\s*$/.test(t) && t.length < 45 : /^[\u25cf\u2022]/.test(t);
}

const AGENTS = [
  { kind: "claude", file: ".claudehis.txt", label: "CLAUDE", match: /(^|[\s"'&\\/])claude(\.exe|\.cmd)?($|[\s"'])/i },
  {
    kind: "antigravity",
    file: ".agyhis.txt",
    label: "ANTIGRAVITY",
    match: /(^|[\s"'&\\/])(antigravity|agy)(\.exe|\.cmd)?($|[\s"'])/i,
  },
  // Both are full-screen TUIs like Claude Code, so the same screen recorder
  // turns them into a readable transcript; nothing below is agent-specific.
  { kind: "codex", file: ".codexhis.txt", label: "CODEX", match: /(^|[\s"'&\\/])codex(\.exe|\.cmd|\.ps1)?($|[\s"'])/i },
  { kind: "gemini", file: ".geminihis.txt", label: "GEMINI", match: /(^|[\s"'&\\/])gemini(\.exe|\.cmd|\.ps1)?($|[\s"'])/i },
];

/** Which agent, if any, a submitted command line starts. */
function detectAgent(commandLine) {
  const line = String(commandLine || "");
  if (!line.trim()) return null;
  for (const agent of AGENTS) if (agent.match.test(line)) return agent;
  return null;
}

class AgentLogger {
  /**
   * @param {{id:string, cwd:string, shell:string}} session
   * @param {object} agent one of AGENTS
   * @param {string} fallbackDir used when the working directory is not writable
   * @param {object} log
   */
  constructor(session, agent, fallbackDir, log) {
    this.sessionId = session.id;
    this.agent = agent;
    this.log = log;
    this.fallbackDir = fallbackDir;
    this.file = this.resolveFile(session.cwd);
    this.pendingInput = "";
    this.lines = [];
    this.awaitingAnswer = false;
    // The escape codes are obeyed rather than stripped, so a line that is
    // overwritten is saved on its way out. Stripping them and keeping the text
    // reads a repainting TUI as one endless line - see screen.js.
    this.screen = new Screen(session.cols, session.rows, (line) => {
      if (this.awaitingAnswer) this.lines.push(line);
    });
    this.idleTimer = null;
    this.startedAt = new Date();
    this.header(session);
  }

  resolveFile(cwd) {
    const target = path.join(cwd || "", this.agent.file);
    try {
      fs.accessSync(cwd, fs.constants.W_OK);
      return target;
    } catch {
      try {
        fs.mkdirSync(this.fallbackDir, { recursive: true });
      } catch {}
      return path.join(this.fallbackDir, `${this.sessionId}${this.agent.file}`);
    }
  }

  append(text) {
    try {
      fs.appendFileSync(this.file, text, "utf8");
    } catch (err) {
      if (this.log) this.log.warn("agent_log_write_failed", { sessionId: this.sessionId, error: err });
    }
  }

  stamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  header(session) {
    this.append(
      `\n===== ${this.agent.label} session ${session.id} started ${this.stamp()} =====\n` +
        `cwd: ${session.cwd}\nshell: ${session.shell}\n\n`
    );
  }

  /** Raw keystrokes on their way to the PTY. */
  noteInput(data) {
    for (const ch of String(data)) {
      if (ch === "\r" || ch === "\n") {
        this.submit();
        continue;
      }
      if (ch === "\u007f" || ch === "\b") {
        this.pendingInput = this.pendingInput.slice(0, -1);
        continue;
      }
      if (ch === "\u0003") {
        // Ctrl+C: whatever was half-typed never became a message.
        this.pendingInput = "";
        continue;
      }
      if (ch < " " && ch !== "\t") continue; // arrows, escape, other control keys
      this.pendingInput += ch;
      if (this.pendingInput.length > 8000) this.pendingInput = this.pendingInput.slice(-8000);
    }
  }

  submit() {
    const line = this.pendingInput.trim();
    this.pendingInput = "";
    // The answer to the previous message ends where the next one begins.
    this.flushOutput();
    if (!line) return;
    this.append(`--- YOU  ${this.stamp()}\n${line}\n\n`);
    this.awaitingAnswer = true;
  }

  /** A copy of what the PTY produced. */
  noteOutput(data) {
    // Fed even between questions: the screen has to stay a true picture of the
    // terminal, or the next answer is read against a grid that never caught up.
    this.screen.write(data);
    if (!this.awaitingAnswer) return;
    if (this.lines.length > MAX_LINES) this.lines = this.lines.slice(-MAX_LINES);
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.flushOutput(), IDLE_FLUSH_MS);
    this.idleTimer.unref?.();
  }

  /** The terminal changed shape; the picture has to change with it. */
  resize(cols, rows) {
    try {
      this.screen.resize(cols, rows);
    } catch {}
  }

  flushOutput() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.awaitingAnswer) return;
    // Lines already replaced, then the ones still on screen - which are the end
    // of the answer, and have not been replaced by anything yet.
    const body = format([...this.lines, ...this.screen.snapshot()]);
    this.lines = [];
    this.awaitingAnswer = false;
    if (!body.trim()) return;
    this.append(`--- ${this.agent.label}  ${this.stamp()}\n${body}\n\n`);
  }

  close(reason) {
    this.flushOutput();
    this.append(`===== ${this.agent.label} session ${this.sessionId} ended ${this.stamp()} (${reason || "closed"}) =====\n\n`);
  }
}

module.exports = { AgentLogger, detectAgent, format, AGENTS };
