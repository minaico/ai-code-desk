/**
 * Claude Assist — layer 3 of the control stack.
 *
 *   Level 1  raw terminal: xterm keyboard / native input straight into the PTY.
 *   Level 2  generic TUI controls: arrows, Enter, Esc, Tab.
 *   Level 3  heuristics in this file: recognise a prompt and offer real buttons.
 *
 * There is no Claude API here and none is assumed. We read the *rendered*
 * terminal buffer (xterm has already interpreted the ANSI, so nothing in the
 * raw stream is disturbed) and try to recognise a choice. When recognition is
 * not certain we return low confidence and the UI falls back to level 2 rather
 * than pressing the wrong button.
 */
import { SEQ } from "./keys.js";

// ">" is deliberately NOT a selection marker: a shell prompt that wraps at the
// right edge leaves a row containing just ">", which used to be read as a
// highlighted menu row and lit the assist bar on an idle prompt.
const SELECTED_MARKERS = ["❯", "›", "▶", "▸", "→", "◉", "●"];
const UNSELECTED_MARKERS = ["◯", "○", "◦", "•", "·", "-", "*"];

/** Words that make a short line look like an actionable choice. */
const ACTION_WORDS = [
  "yes", "no", "allow", "deny", "accept", "reject", "approve", "cancel",
  "continue", "confirm", "skip", "retry", "abort", "ok", "quit", "exit",
  "trust", "always", "never", "once", "auto", "manual", "edit", "run",
  "proceed", "stop", "keep", "discard", "overwrite", "merge", "replace",
];

const YES_NO_PROMPT = /\((?:y(?:es)?\s*\/\s*n(?:o)?|n(?:o)?\s*\/\s*y(?:es)?)\)|\[y\/n\]/i;
const WAITING_HINTS = [
  /waiting for (?:your )?(?:approval|confirmation|input)/i,
  /permission (?:required|needed)/i,
  /do you want to/i,
  /would you like to/i,
  /press enter to/i,
  /select an option/i,
  /choose (?:an? )?(?:option|mode)/i,
  /trust the files in this folder/i,
];

/**
 * Split "  ❯ Allow" into its marker and its text, and report the column the
 * text starts at. Rows of one menu always align on that column, which is what
 * lets us tell an option from the surrounding prose.
 */
const stripMarker = (line) => {
  const leading = line.length - line.trimStart().length;
  let text = line.trim();
  let selected = false;
  let consumed = 0;
  for (const m of SELECTED_MARKERS) {
    if (text.startsWith(m)) {
      selected = true;
      consumed = m.length;
      text = text.slice(m.length).trimStart();
      break;
    }
  }
  if (!selected) {
    for (const m of UNSELECTED_MARKERS) {
      if (text.startsWith(m + " ")) {
        consumed = m.length;
        text = text.slice(m.length).trimStart();
        break;
      }
    }
  }
  const trimmed = line.trim();
  const afterMarker = trimmed.slice(consumed);
  const gap = afterMarker.length - afterMarker.trimStart().length;
  return { text, selected, textCol: leading + consumed + gap };
};

const NUMBERED = /^(\d{1,2})\s*[.)\]]\s+(.{1,80})$/;

const PROMPT_LINE = /(?:^|\s)[A-Za-z]:\\[^\s]*>\s*$|^\S*[$#>]\s*$/;

function looksLikeChoice(text) {
  if (!text || text.length > 70) return false;
  if (PROMPT_LINE.test(text)) return false;
  if (/^[-=_*#~]{3,}$/.test(text)) return false;
  if (/[\\/][^\s]*[\\/]/.test(text)) return false; // a path, not a choice
  if (/\bpackages?\b|\berrors?\b|\bwarnings?\b/i.test(text) && /\d/.test(text)) return false;
  return true;
}

function isActionWord(text) {
  const lower = text.toLowerCase();
  return ACTION_WORDS.some((w) => lower === w || lower.startsWith(w + " ") || lower.startsWith(w + ","));
}

/**
 * Collect the option rows around a highlighted row.
 * Returns null unless the block really looks like a vertical choice list.
 */
function collectMarkerMenu(tail) {
  let anchor = -1;
  let anchorCol = 0;
  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 25); i--) {
    if (!tail[i].trim()) continue;
    const info = stripMarker(tail[i]);
    if (info.selected && looksLikeChoice(info.text)) {
      anchor = i;
      anchorCol = info.textCol;
      break;
    }
  }
  if (anchor < 0) return null;

  const rows = [];
  const take = (i) => {
    const raw = tail[i];
    if (raw === undefined || !raw.trim()) return false;
    const info = stripMarker(raw);
    if (!looksLikeChoice(info.text)) return false;
    // Rows of the same menu line up. Prose above the menu, a wrapped command
    // echo, or the prompt all start in a different column and stop the sweep.
    if (Math.abs(info.textCol - anchorCol) > 1) return false;
    rows.push({ index: i, text: info.text, selected: info.selected });
    return true;
  };

  for (let i = anchor; i >= 0 && rows.length < 10; i--) if (!take(i)) break;
  rows.reverse();
  for (let i = anchor + 1; i < tail.length && rows.length < 12; i++) if (!take(i)) break;

  if (rows.length < 2) return null;
  return rows;
}

/**
 * Collect a numbered menu: "1. Yes / 2. No" waiting at the bottom of the screen.
 *
 * Numbered lines are the weakest signal on a terminal, because Claude writes
 * numbered lists in ordinary prose all the time — a plan, a summary, the six
 * headings of a status report. Reading one of those as a menu is not a cosmetic
 * mistake: the bar appears, the terminal loses the rows the bar occupies, the
 * running TUI repaints, and the repaint changes what the next analysis sees.
 * That is the flicker-and-duplicate loop this guard exists to stop, and the
 * buttons it offered would have typed a digit into whatever was running.
 *
 * So a block only counts as a menu when it behaves like a live prompt:
 * unbroken rows, numbered from 1, short choice-like text, nothing but blank
 * rows below it, and either a question just above it or a highlighted row
 * inside it. Prose fails at least one of those every time.
 */
function collectNumberedMenu(tail) {
  let end = tail.length - 1;
  while (end >= 0 && !tail[end].trim()) end--;
  if (end < 0) return null;

  const rows = [];
  let above = end;
  for (; above >= 0 && rows.length < 12; above--) {
    const info = stripMarker(tail[above]);
    const m = info.text.match(NUMBERED);
    // Contiguous by design: a blank line or a line of prose ends the block
    // instead of being skipped over to reach digits further up the screen.
    if (!m) break;
    rows.unshift({ key: m[1], text: m[2].trim(), selected: info.selected });
  }

  if (rows.length < 2) return null;
  if (!rows.every((r, i) => Number(r.key) === i + 1)) return null;
  if (!rows.every((r) => looksLikeChoice(r.text))) return null;

  // Corroboration. One of these must hold, or we are guessing at prose.
  const marked = rows.some((r) => r.selected);
  const asked = tail
    .slice(Math.max(0, above - 2), above + 1)
    .some((l) => WAITING_HINTS.some((re) => re.test(l)) || /\?\s*$/.test(l.trim()));
  const actionable = rows.every((r) => isActionWord(r.text));
  if (!marked && !asked && !actionable) return null;

  return { rows, above };
}

/**
 * @param {string[]} lines rendered terminal lines, oldest first
 * @returns {{kind:string, confidence:"high"|"low", options:Array, selected:number, hint:string}}
 */
export function analyse(lines) {
  const none = { kind: "none", confidence: "low", options: [], selected: -1, hint: "" };
  if (!Array.isArray(lines) || !lines.length) return none;

  const tail = lines.slice(-60).map((l) => String(l).replace(/\s+$/, ""));
  const lastText = [...tail].reverse().find((l) => l.trim()) || "";
  const hint = WAITING_HINTS.find((re) => tail.slice(-12).some((l) => re.test(l)));

  /* ---- numbered menu: pressing the digit is unambiguous ---- */
  const block = collectNumberedMenu(tail);
  if (block) {
    return {
      kind: "numbered",
      confidence: "high",
      options: block.rows.map((r, i) => ({ key: r.key, text: r.text, index: i })),
      selected: block.rows.findIndex((r) => r.selected),
      hint: hint ? "Chọn một mục" : "Menu đánh số",
    };
  }

  /* ---- marker menu: "❯ Allow / Deny / Cancel" ---- */
  const rows = collectMarkerMenu(tail);
  if (rows) {
    const unique = [];
    const seen = new Set();
    for (const row of rows) {
      const key = row.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(row);
    }
    if (unique.length >= 2) {
      const options = unique.map((o, i) => ({ text: o.text, selected: o.selected, index: i }));
      const selectedCount = options.filter((o) => o.selected).length;
      const selected = options.findIndex((o) => o.selected);
      // Exactly one highlighted row means "move N times, then Enter" is safe.
      // Anything else is a guess, and a wrong guess presses the wrong button.
      const confident = selectedCount === 1 && options.some((o) => isActionWord(o.text) || o.text.length <= 40);
      // A block we cannot read confidently is only worth surfacing when the
      // terminal also says it is waiting for an answer. Otherwise stay quiet.
      if (!confident && !hint) return none;
      return {
        kind: "menu",
        confidence: confident ? "high" : "low",
        options,
        selected,
        hint: confident ? (hint ? "Đang chờ bạn chọn" : "Chọn một mục") : "Không xác định được mục đang chọn",
      };
    }
  }

  /* ---- plain (y/n) question ---- */
  if (YES_NO_PROMPT.test(lastText)) {
    return {
      kind: "yesno",
      confidence: "high",
      options: [
        { text: "Yes", key: "y", index: 0 },
        { text: "No", key: "n", index: 1 },
      ],
      selected: -1,
      hint: lastText.slice(-70),
    };
  }

  if (hint) {
    return { ...none, kind: "waiting", hint: "Đang chờ bạn trả lời trong terminal" };
  }
  return none;
}

/**
 * Keystrokes for choosing option `index`.
 * Returns [] when the analysis is not confident — the caller must then show the
 * raw arrow controls instead of guessing.
 */
export function planFor(analysis, index) {
  if (!analysis || analysis.confidence !== "high") return [];
  const option = analysis.options[index];
  if (!option) return [];

  if (analysis.kind === "numbered") return [option.key];
  if (analysis.kind === "yesno") return [option.key, SEQ.ENTER];

  if (analysis.kind === "menu") {
    if (analysis.selected < 0) return [];
    const delta = index - analysis.selected;
    const step = delta > 0 ? SEQ.DOWN : SEQ.UP;
    const out = [];
    for (let i = 0; i < Math.abs(delta); i++) out.push(step);
    out.push(SEQ.ENTER);
    return out;
  }
  return [];
}

/**
 * Read the rendered lines out of an xterm instance without touching the stream.
 *
 * Stops at the cursor, which is what the assist bar wants: it reads a menu, and
 * a menu is above the cursor. Use readAllLines for anything that has to see the
 * whole screen.
 */
export function readLines(term, count = 60) {
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY + 1;
  const start = Math.max(0, end - count);
  const out = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
  }
  return out;
}

/**
 * Every line in the buffer, cursor or no cursor.
 *
 * Claude Code draws its composer, its mode line and its "auto mode on" hint
 * *below* the cursor. Reading only as far as the cursor therefore misses the
 * one marker a finished v2.1 answer still carries, and the reader concluded the
 * session was not Claude Code at all.
 */
export function readAllLines(term, count = 2000) {
  const buf = term.buffer.active;
  const end = buf.length;
  const start = Math.max(0, end - count);
  const out = [];
  for (let i = start; i < end; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
  }
  return out;
}
