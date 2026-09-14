/**
 * Voice in and voice out.
 *
 * Dictation is Web Speech (webkitSpeechRecognition): supported in Chrome and in
 * Safari from iOS 14.5, needs HTTPS and a user gesture. Recognition is done by
 * the browser vendor's service, not locally and not by this app - Apple or
 * Google receive the audio.
 *
 * Reading out has two engines. `Speaker` is the browser's own speechSynthesis:
 * always there, but each voice is pinned to one language, so a Vietnamese voice
 * spells English identifiers as Vietnamese syllables and an English voice
 * mangles the Vietnamese around them. `RemoteSpeaker` talks to a local
 * VieNeu-TTS through this app's own server; it is bilingual in one voice and
 * code-switches mid-sentence, which is what a terminal answer actually sounds
 * like ("đã chạy npm test, 91 test pass").
 */
const SpeechRecognitionImpl =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const voiceSupport = {
  input: !!SpeechRecognitionImpl,
  output: typeof window !== "undefined" && !!window.speechSynthesis,
};

/** Spoken phrases that mean "read the answer back to me" instead of "type this". */
const READ_COMMANDS = [
  /^\s*đọc\s+(kết\s+quả|kq)\s*[.!]?\s*$/i,
  /^\s*doc\s+(ket\s+qua|kq)\s*[.!]?\s*$/i,
  /^\s*(read|say)\s+(the\s+)?(result|answer|output)\s*[.!]?\s*$/i,
];

export function isReadCommand(text) {
  return READ_COMMANDS.some((re) => re.test(String(text || "")));
}

export class Dictation {
  /**
   * @param {{lang?:string, onText:Function, onState:Function, onError:Function}} opts
   */
  constructor(opts = {}) {
    this.lang = opts.lang || "vi-VN";
    this.onText = opts.onText || (() => {});
    this.onState = opts.onState || (() => {});
    this.onError = opts.onError || (() => {});
    this.recognition = null;
    this.listening = false;
  }

  get supported() {
    return !!SpeechRecognitionImpl;
  }

  toggle() {
    if (this.listening) this.stop();
    else this.start();
  }

  start() {
    if (!this.supported || this.listening) return;
    const rec = new SpeechRecognitionImpl();
    rec.lang = this.lang;
    // Single-shot: iOS Safari does not honour continuous dictation reliably.
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.listening = true;
      this.onState(true);
    };
    rec.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (final) this.onText(final.trim(), true);
      else if (interim) this.onText(interim.trim(), false);
    };
    rec.onerror = (event) => {
      const map = {
        "not-allowed": "Trình duyệt chưa được cấp quyền micro",
        "service-not-allowed": "Trình duyệt chưa được cấp quyền micro",
        "no-speech": "Không nghe thấy gì",
        network: "Nhận dạng giọng nói cần mạng",
        aborted: "",
      };
      const message = map[event.error] !== undefined ? map[event.error] : `Lỗi micro: ${event.error}`;
      if (message) this.onError(message);
    };
    rec.onend = () => {
      this.listening = false;
      this.recognition = null;
      this.onState(false);
    };

    this.recognition = rec;
    try {
      rec.start();
    } catch (err) {
      this.listening = false;
      this.onError(err.message || "Không mở được micro");
    }
  }

  stop() {
    if (!this.recognition) return;
    try {
      this.recognition.stop();
    } catch {}
  }
}

export class Speaker {
  constructor(opts = {}) {
    this.lang = opts.lang || "vi-VN";
    this.onState = opts.onState || (() => {});
    this.speaking = false;
  }

  get supported() {
    return voiceSupport.output;
  }

  /** speechSynthesis needs no unlocking; kept so both engines share an API. */
  unlock() {}

  pickVoice() {
    if (!this.supported) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    const exact = voices.find((v) => v.lang && v.lang.toLowerCase() === this.lang.toLowerCase());
    if (exact) return exact;
    const prefix = this.lang.split("-")[0].toLowerCase();
    return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(prefix)) || null;
  }

  speak(text) {
    if (!this.supported) return false;
    const body = String(text || "").trim();
    if (!body) return false;
    this.stop();
    const utter = new SpeechSynthesisUtterance(body.slice(0, 4000));
    utter.lang = this.lang;
    const voice = this.pickVoice();
    if (voice) utter.voice = voice;
    utter.rate = 1;
    utter.onstart = () => {
      this.speaking = true;
      this.onState(true);
    };
    const done = () => {
      this.speaking = false;
      this.onState(false);
    };
    utter.onend = done;
    utter.onerror = done;
    window.speechSynthesis.speak(utter);
    return true;
  }

  stop() {
    if (!this.supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {}
    this.speaking = false;
    this.onState(false);
  }
}

/**
 * Cut an answer into pieces a TTS server can turn round quickly.
 *
 * One request for the whole answer means silence until the last word has been
 * synthesised. Sentence-sized pieces let the first one start playing while the
 * next is still being made, so the wait is roughly one sentence long whatever
 * the length of the answer.
 */
export function splitForSpeech(text, maxChars = 220) {
  const body = String(text || "").trim();
  if (!body) return [];
  const sentences = body.match(/[^.!?…\n]+[.!?…]*\s*/g) || [body];
  const chunks = [];
  let current = "";
  for (const raw of sentences) {
    const piece = raw.trim();
    if (!piece) continue;
    if (piece.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      // A single sentence longer than the limit: break it on commas, then hard.
      let rest = piece;
      while (rest.length > maxChars) {
        const head = rest.slice(0, maxChars);
        const cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf(" "));
        const at = cut > maxChars * 0.5 ? cut + 1 : maxChars;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at);
      }
      if (rest.trim()) current = rest.trim();
      continue;
    }
    if (!current) current = piece;
    else if (current.length + 1 + piece.length <= maxChars) current += " " + piece;
    else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** 50 ms of silence — enough for Safari to mark an element user-approved. */
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

/**
 * Read out through VieNeu-TTS, proxied by our own server.
 *
 * iOS only lets audio start from inside a user gesture, and awaiting a fetch
 * loses that gesture. The way round it is to keep one Audio element for the
 * life of the page and unlock it during the first tap; every later play() on
 * that same element is allowed, however long the synthesis took.
 */
export class RemoteSpeaker {
  /**
   * @param {{fetchAudio:Function, voiceId?:string, onState?:Function, onError?:Function}} opts
   *   fetchAudio(text, voiceId) must resolve to a Blob of playable audio.
   */
  constructor(opts = {}) {
    this.fetchAudio = opts.fetchAudio;
    this.voiceId = opts.voiceId || "";
    this.onState = opts.onState || (() => {});
    this.onError = opts.onError || (() => {});
    this.speaking = false;
    this.audio = null;
    this.unlocked = false;
    /** Bumped by stop() and by each new speak(), so stale chunks give up. */
    this.token = 0;
    this.url = "";
  }

  get supported() {
    return typeof Audio !== "undefined" && typeof fetch === "function" && !!this.fetchAudio;
  }

  element() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
    }
    return this.audio;
  }

  /** Call from inside a click handler, before any await. */
  unlock() {
    if (this.unlocked || !this.supported) return;
    const el = this.element();
    try {
      el.src = SILENT_WAV;
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
      this.unlocked = true;
    } catch {}
  }

  async speak(text) {
    if (!this.supported) return false;
    const chunks = splitForSpeech(text);
    if (!chunks.length) return false;

    this.stop();
    const token = ++this.token;
    this.speaking = true;
    this.onState(true);

    try {
      // Fetch the next chunk while the current one plays, so the gap between
      // sentences is however long the server needs and not that plus a trip.
      let pending = this.fetchAudio(chunks[0], this.voiceId);
      for (let i = 0; i < chunks.length; i++) {
        const blob = await pending;
        if (token !== this.token) return false;
        pending = i + 1 < chunks.length ? this.fetchAudio(chunks[i + 1], this.voiceId) : null;
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
        await this.playBlob(blob, token);
        if (token !== this.token) return false;
      }
      return true;
    } catch (err) {
      if (token === this.token) this.onError((err && err.message) || "Không đọc được");
      return false;
    } finally {
      if (token === this.token) {
        this.speaking = false;
        this.onState(false);
      }
    }
  }

  playBlob(blob, token) {
    return new Promise((resolve, reject) => {
      if (token !== this.token) return resolve();
      const el = this.element();
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(blob);
      const clear = () => {
        el.onended = null;
        el.onerror = null;
      };
      el.onended = () => {
        clear();
        resolve();
      };
      el.onerror = () => {
        clear();
        reject(new Error("Không phát được âm thanh"));
      };
      el.src = this.url;
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          clear();
          const blocked = err && err.name === "NotAllowedError";
          reject(new Error(blocked ? "Bấm nút 🔊 để cho phép phát tiếng" : "Không phát được âm thanh"));
        });
      }
    });
  }

  stop() {
    this.token++;
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {}
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = "";
    }
    this.speaking = false;
    this.onState(false);
  }
}

/* ------------------------------------------------------------------ *
 * Turning a rendered terminal screen into something worth hearing
 * ------------------------------------------------------------------ */

const BOX_EDGE = /^[\s│┃┆┊┌┐└┘├┤┬┴┼─━┄┈╔╗╚╝║═╭╮╯╰]+$/;
const SHELL_PROMPT = /^(PS )?[A-Za-z]:\\[^\n]*>\s*$/;

/**
 * Claude Code paints three different things onto the same screen: what it is
 * telling you, what it is thinking, and what its tools are doing. Only the
 * first is worth hearing, so the reader has to know which one it is looking
 * at. These are the markers Claude Code draws them with.
 */
const CLAUDE_SIGNS = [/^\s*[●⎿]/, /\(esc to interrupt\)/i, /^\s*⏵⏵/];
const THINKING_HEADER = /^[✻✽✳✢*·]?\s*(thinking|đang suy nghĩ|suy nghĩ)\b/i;
const TOOL_NAMES =
  /^(Bash|BashOutput|Read|Write|Edit|MultiEdit|Update|Create|Search|Glob|Grep|Task|Agent|Artifact|Skill|Workflow|WebFetch|WebSearch|NotebookEdit|TodoWrite|Kill|KillShell|Fetch|List|Monitor|SendMessage)\b/;

/** Spinners, hints and counters: chrome, never an answer. */
const STATUS_ROW = [
  /\(esc to interrupt\)/i,
  /^\?\s+for shortcuts/i,
  /^⏵⏵/,
  /[↑↓]\s*[\d.,]+\s*k?\s*tokens/i,
  /^[✻✽✳✢·*]\s*\S+…/,
  /^\S+…\s*\(\d+s\b/,
  /^\d+\s*(lines?|dòng)\s+(hidden|ẩn)/i,
];

const isBoxRow = (row) => /^\s*[│┃╭╰┌└╔╚║]/.test(row) || BOX_EDGE.test(row);
const isStatusRow = (text) => STATUS_ROW.some((re) => re.test(text));
const isThinkingHeader = (text) => THINKING_HEADER.test(text);
const looksLikeClaude = (rows) => rows.some((row) => CLAUDE_SIGNS.some((re) => re.test(row)));

/** A tool call reads as `Bash(npm test)` or `Update(server/tts.js)`. */
function isToolCall(text) {
  if (TOOL_NAMES.test(text)) return true;
  return /^[A-Z][\w.-]*\(/.test(text);
}

/** Strip the decoration a listener would only stumble over. */
function speakableRow(text) {
  return text
    .replace(/[│┃┆┊┌┐└┘├┤┬┴┼─━┄┈╔╗╚╝║═╭╮╯╰]/g, " ")
    .replace(/[✻✽✳✢·•●○◉❯›▶▸⎿]/g, " ")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function pushRow(keep, text) {
  if (!text) return;
  if (keep.length && keep[keep.length - 1] === text) return;
  keep.push(text);
}

/** Join lines into speech without doubling punctuation that is already there. */
function joinForSpeech(rows) {
  let out = "";
  for (const row of rows) {
    if (!out) {
      out = row;
      continue;
    }
    out += /[.!?…:,;]$/.test(out) ? " " : ". ";
    out += row;
  }
  return out;
}

/**
 * Keep only what Claude displayed as its answer: drop the thinking block, the
 * tool calls and their output, and the interface chrome.
 */
function collectClaude(rows) {
  const keep = [];
  let mode = "none";
  for (const raw of rows) {
    const text = raw.trim();
    if (!text) continue; // a blank line separates paragraphs; it ends no block
    if (isBoxRow(raw)) {
      mode = "none"; // the live input box at the foot of the screen
      continue;
    }
    if (isThinkingHeader(text)) {
      mode = "thinking";
      continue;
    }
    if (isStatusRow(text)) {
      mode = "none";
      continue;
    }
    if (/^⎿/.test(text)) {
      mode = "tool"; // tool output, folded under the call that made it
      continue;
    }
    if (/^>\s/.test(text)) {
      mode = "none"; // our own message, echoed back
      continue;
    }
    const bullet = text.match(/^●\s*(.*)$/);
    if (bullet) {
      const body = bullet[1].trim();
      if (!body || isToolCall(body)) {
        mode = "tool";
        continue;
      }
      mode = "prose";
      pushRow(keep, speakableRow(body));
      continue;
    }
    // An unmarked line continues whatever block it is sitting in.
    if (mode === "prose") pushRow(keep, speakableRow(text));
  }
  return joinForSpeech(keep);
}

/** A plain shell: everything that is not a prompt or box drawing is output. */
function collectShell(rows) {
  const keep = [];
  for (const raw of rows) {
    if (SHELL_PROMPT.test(raw.trim())) continue;
    const text = speakableRow(raw);
    if (!text) continue;
    if (SHELL_PROMPT.test(text)) continue;
    pushRow(keep, text);
  }
  return joinForSpeech(keep);
}

/**
 * Where the answer to `lastCommand` begins, most recent first.
 *
 * The command appears more than once on a busy screen — in the shell's echo,
 * in Claude's copy of the message, sometimes in a history hint — so this
 * returns every candidate and the caller takes the newest that yields speech.
 * The live input box is skipped: what is sitting in it has not been run.
 */
function answerStarts(rows, lastCommand) {
  const needle = String(lastCommand || "").trim();
  const starts = [];
  if (needle) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].includes(needle)) continue;
      if (isBoxRow(rows[i])) continue;
      starts.push(i + 1);
    }
  }
  // Nothing matched, or every match came up empty: read the last screenful.
  starts.push(Math.max(0, rows.length - 30));
  return starts;
}

/**
 * Pull the answer to the last command out of the rendered terminal lines.
 *
 * @param {string[]} lines rendered rows, oldest first
 * @param {string} lastCommand the last thing sent to this terminal
 */
export function readableAnswer(lines, lastCommand) {
  const rows = (lines || []).map((l) => String(l).replace(/\s+$/, ""));
  const claude = looksLikeClaude(rows);
  for (const start of answerStarts(rows, lastCommand)) {
    const slice = rows.slice(start);
    const text = claude ? collectClaude(slice) : collectShell(slice);
    if (text) return text.slice(0, 3000);
  }
  return "";
}
