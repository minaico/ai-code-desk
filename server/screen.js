"use strict";
/**
 * A terminal screen, kept only so that lines can be saved before they are lost.
 *
 * Stripping the escape codes out of a PTY stream and keeping the text is the
 * obvious way to record a session, and it is wrong for the tools this exists
 * for. Claude Code draws with Ink, which redraws its whole answer every time
 * the answer grows; when the answer is taller than the screen it writes the
 * opening at the top and overwrites that same top later in the very same
 * frame. The escape codes are the only record of which line replaced which, so
 * throwing them away throws away the opening. Measured on one real "tt": the
 * screen, the host's ring buffer and the old stripped log all agreed - sections
 * 3 to 8 present, 1 and 2 nowhere.
 *
 * So the codes are obeyed rather than removed. A grid is kept, and a row is
 * handed to onLine at the moment something is about to replace it - which is
 * the last moment its content still exists anywhere. Nothing that was ever
 * drawn can be lost, however short the window or however often it repaints.
 *
 * A deliberately small subset of VT: cursor movement, erase, scroll region,
 * insert and delete lines. Colour and mode changes are parsed and dropped -
 * they do not move anything.
 */

const MAX_COLS = 500;
const MAX_ROWS = 200;
const MAX_LINE = 2000;

/** The glyphs Claude Code and friends spin through while they work. */
const SPINNER = /[\u2801-\u28ff\u2733\u273b\u273c\u273d\u2736\u2722\u00b7\u25cf\u25d0\u25d1\u25d2\u25d3*]/u;

/**
 * A status line: the tool saying it is still working.
 *
 *     [spinner] Wibbling... (2s . 7 tokens)
 *     Roosting... (running stop hook . 2m 7s .
 *
 * Two conditions, both required. It has to look like one - a spinner glyph in
 * front, or the ellipsis and bracket of a verb still happening - and it has to
 * carry something that counts: a clock, a token tally, a named phase.
 *
 * Both, because either alone is wrong. An earlier version had "-" among the
 * spinner glyphs and read every bullet in an answer as a spinner, while the
 * real glyph was missing from the set so no actual spinner matched at all.
 * And a sentence may mention tokens without being a status line.
 */
function isStatus(text) {
  const t = text.trim();
  if (!t) return false;
  const looks = SPINNER.test(t[0]) || /\u2026\s*\(/.test(t);
  if (!looks) return false;
  // A spinner with nothing after it yet - the verb alone, mid-tick.
  if (SPINNER.test(t[0]) && /\u2026/.test(t) && t.length < 40) return true;
  return (
    /\d+\s*(?:h|m|s|ms)\b/.test(t) ||
    /tokens?\b/i.test(t) ||
    /running .*hook/i.test(t) ||
    /esc to interrupt/i.test(t)
  );
}

/** Text with its numbers flattened and any leading spinner glyph removed. */
function signature(text) {
  return text
    .replace(/^[\s⠁-⣿*✳✽✶✢·●◐◓◑◒|/\-]+/u, "")
    .replace(/\d+/g, "#")
    .trim();
}

/**
 * Is `next` the same line as `prev`, just further along?
 *
 * Two ways a line legitimately changes without being replaced: it grows as it
 * is typed out, and a status line ticks - a spinner or a token count redrawing
 * in place. Emitting each of those would turn one sentence into fifty, which is
 * what the old transcripts looked like.
 *
 * The tick rule is confined to status lines on purpose. Flattening the digits
 * of any line at all made "muc 2" and "muc 7" the same line, and a screen that
 * had held twelve of them handed back two.
 */
function sameLine(prev, next) {
  if (!prev) return true;
  if (next.startsWith(prev) || prev.startsWith(next)) return true;
  if (!isStatus(prev) || !isStatus(next)) return false;
  const a = signature(prev);
  const b = signature(next);
  return a.length > 0 && a === b;
}

class Screen {
  /**
   * @param {number} cols
   * @param {number} rows
   * @param {(line:string)=>void} onLine called with each finished line, in order
   */
  constructor(cols, rows, onLine) {
    this.onLine = typeof onLine === "function" ? onLine : () => {};
    this.setSize(cols, rows);
    this.grid = new Array(this.rows).fill("");
    this.row = 0;
    this.col = 0;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.saved = null;
    this.dirtyRow = -1;
    this.dirtyBefore = null;
    this.pending = ""; // an escape sequence split across two chunks
  }

  setSize(cols, rows) {
    this.cols = Math.max(20, Math.min(MAX_COLS, Math.round(Number(cols) || 120)));
    this.rows = Math.max(4, Math.min(MAX_ROWS, Math.round(Number(rows) || 32)));
  }

  /**
   * Grow or shrink. Rows that fall off the bottom are finished, so they are
   * handed over rather than dropped.
   */
  resize(cols, rows) {
    const before = this.rows;
    this.setSize(cols, rows);
    if (this.rows < before) {
      for (let i = this.rows; i < before; i++) this.emit(i);
      this.grid.length = this.rows;
    } else {
      while (this.grid.length < this.rows) this.grid.push("");
    }
    this.row = Math.min(this.row, this.rows - 1);
    this.top = 0;
    this.bottom = this.rows - 1;
  }

  /** Hand row `i` over if it holds anything, and blank it. */
  emit(i) {
    if (this.dirtyRow === i) this.settle();
    const text = (this.grid[i] || "").replace(/\s+$/, "");
    this.grid[i] = "";
    if (text.trim()) this.onLine(text.slice(0, MAX_LINE));
  }

  /**
   * About to put `next` on row `i`.
   *
   * Judged when the row is done, not while it is being written. A row is
   * overwritten one character at a time, so every character of a replacement
   * leaves the row half old and half new; deciding then produced a line per
   * character - one measured session turned into 13,262 of them. So the row
   * before the first change is remembered, and the comparison waits until the
   * cursor leaves the row or something structural happens to it.
   */
  replace(i, next) {
    if (i < 0 || i >= this.rows) return;
    if (this.dirtyRow !== i) {
      this.settle();
      this.dirtyRow = i;
      this.dirtyBefore = (this.grid[i] || "").replace(/\s+$/, "");
    }
    this.grid[i] = next;
  }

  /** Decide about the row that was being written, now that it is finished. */
  settle() {
    const i = this.dirtyRow;
    if (i < 0) return;
    this.dirtyRow = -1;
    const before = this.dirtyBefore;
    this.dirtyBefore = null;
    const after = (this.grid[i] || "").replace(/\s+$/, "");
    if (before && !sameLine(before, after)) this.onLine(before.slice(0, MAX_LINE));
  }

  /** Put `text` at the cursor, wrapping at the right edge. */
  put(text) {
    for (const ch of text) {
      if (this.col >= this.cols) {
        this.col = 0;
        this.lineFeed();
      }
      const line = this.grid[this.row] || "";
      const padded = line.length < this.col ? line + " ".repeat(this.col - line.length) : line;
      const next = padded.slice(0, this.col) + ch + padded.slice(this.col + 1);
      this.replace(this.row, next);
      this.col += 1;
    }
  }

  lineFeed() {
    this.settle();
    if (this.row < this.bottom) {
      this.row += 1;
      return;
    }
    // At the bottom of the scroll region the top row leaves the screen for
    // good - the one place a line is finished without anything replacing it.
    this.emit(this.top);
    for (let i = this.top; i < this.bottom; i++) this.grid[i] = this.grid[i + 1];
    this.grid[this.bottom] = "";
  }

  /** What is on screen now, without taking it. Rows top to bottom. */
  snapshot() {
    this.settle();
    const out = [];
    for (let i = 0; i < this.rows; i++) {
      const text = (this.grid[i] || "").replace(/\s+$/, "");
      if (text.trim()) out.push(text.slice(0, MAX_LINE));
    }
    return out;
  }

  /** Everything still on screen, top to bottom. Call when the session ends. */
  flush() {
    this.settle();
    for (let i = 0; i < this.rows; i++) this.emit(i);
    this.row = 0;
    this.col = 0;
  }

  write(chunk) {
    const data = this.pending + String(chunk == null ? "" : chunk);
    this.pending = "";
    let i = 0;
    let text = "";
    const flushText = () => {
      if (text) {
        this.put(text);
        text = "";
      }
    };

    while (i < data.length) {
      const ch = data[i];

      if (ch === "\u001b") {
        flushText();
        const taken = this.escape(data, i);
        if (taken < 0) {
          // Cut short by the chunk boundary; wait for the rest.
          this.pending = data.slice(i);
          return;
        }
        i += taken;
        continue;
      }

      if (ch === "\r") {
        flushText();
        // Going back to the start of the line ends whatever was being
        // written there. Without this a line typed out and then overwritten
        // in place - a spinner landing on top of it - was never judged at
        // all, because the cursor never left the row.
        this.settle();
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        flushText();
        this.lineFeed();
        i += 1;
        continue;
      }
      if (ch === "\b") {
        flushText();
        if (this.col > 0) this.col -= 1;
        i += 1;
        continue;
      }
      if (ch === "\t") {
        flushText();
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        i += 1;
        continue;
      }
      if (ch < " " || ch === "\u007f") {
        i += 1; // bell and friends: nothing to draw
        continue;
      }

      text += ch;
      i += 1;
    }
    flushText();
  }

  /**
   * Handle the escape sequence starting at `at`.
   * @returns {number} characters consumed, or -1 if the sequence is incomplete
   */
  escape(data, at) {
    const next = data[at + 1];
    if (next === undefined) return -1;

    if (next === "[") {
      let i = at + 2;
      while (i < data.length && data[i] >= " " && data[i] <= "?") i += 1;
      if (i >= data.length) return -1;
      const params = data.slice(at + 2, i);
      this.csi(params, data[i]);
      return i - at + 1;
    }

    if (next === "]") {
      // OSC: runs to BEL or ST. Titles and our own cwd reports; nothing to draw.
      const bel = data.indexOf("\u0007", at);
      const st = data.indexOf("\u001b\\", at + 1);
      if (bel < 0 && st < 0) return -1;
      const end = bel < 0 ? st + 1 : st < 0 ? bel : Math.min(bel, st + 1);
      return end - at + 1;
    }

    if (next === "(" || next === ")" || next === "#" || next === "%") {
      return data[at + 2] === undefined ? -1 : 3;
    }
    if (next === "7") {
      this.saved = { row: this.row, col: this.col };
      return 2;
    }
    if (next === "8") {
      if (this.saved) {
        this.row = this.saved.row;
        this.col = this.saved.col;
      }
      return 2;
    }
    if (next === "M") {
      // Reverse index: scrolling down pushes the bottom row off.
      if (this.row > this.top) this.row -= 1;
      else {
        this.emit(this.bottom);
        for (let i = this.bottom; i > this.top; i--) this.grid[i] = this.grid[i - 1];
        this.grid[this.top] = "";
      }
      return 2;
    }
    return 2; // any other two-byte escape: parsed and ignored
  }

  csi(params, final) {
    if (params.startsWith("?")) {
      // Private modes - cursor visibility, mouse reporting, alternate screen.
      // Entering or leaving the alternate screen replaces everything on it.
      if ((final === "h" || final === "l") && /1049/.test(params)) this.flush();
      return;
    }
    const nums = params
      .split(";")
      .map((p) => (p === "" ? 0 : parseInt(p, 10)))
      .map((n) => (Number.isFinite(n) ? n : 0));
    const one = (i, dflt) => (nums[i] === undefined || nums[i] === 0 ? dflt : nums[i]);

    // Any deliberate move of the cursor ends the line it was writing.
    if ("HfABCDEFGd".includes(final)) this.settle();

    switch (final) {
      case "H":
      case "f":
        this.row = Math.max(0, Math.min(this.rows - 1, one(0, 1) - 1));
        this.col = Math.max(0, Math.min(this.cols - 1, one(1, 1) - 1));
        return;
      case "A":
        this.row = Math.max(0, this.row - one(0, 1));
        return;
      case "B":
        this.row = Math.min(this.rows - 1, this.row + one(0, 1));
        return;
      case "C":
        this.col = Math.min(this.cols - 1, this.col + one(0, 1));
        return;
      case "D":
        this.col = Math.max(0, this.col - one(0, 1));
        return;
      case "E":
        this.row = Math.min(this.rows - 1, this.row + one(0, 1));
        this.col = 0;
        return;
      case "F":
        this.row = Math.max(0, this.row - one(0, 1));
        this.col = 0;
        return;
      case "G":
        this.col = Math.max(0, Math.min(this.cols - 1, one(0, 1) - 1));
        return;
      case "d":
        this.row = Math.max(0, Math.min(this.rows - 1, one(0, 1) - 1));
        return;
      case "J": {
        this.settle();
        const mode = nums[0] || 0;
        if (mode === 0) {
          this.replace(this.row, (this.grid[this.row] || "").slice(0, this.col));
          for (let i = this.row + 1; i < this.rows; i++) this.emit(i);
        } else if (mode === 1) {
          for (let i = 0; i < this.row; i++) this.emit(i);
          this.replace(this.row, "");
        } else if (mode === 2 || mode === 3) {
          for (let i = 0; i < this.rows; i++) this.emit(i);
        }
        return;
      }
      case "K": {
        const mode = nums[0] || 0;
        const line = this.grid[this.row] || "";
        if (mode === 0) this.replace(this.row, line.slice(0, this.col));
        else if (mode === 1) this.replace(this.row, " ".repeat(Math.min(this.col + 1, line.length)) + line.slice(this.col + 1));
        else this.replace(this.row, "");
        return;
      }
      case "L": {
        this.settle();
        // Insert blank lines: the bottom of the region falls off.
        const n = Math.min(one(0, 1), this.bottom - this.row + 1);
        for (let k = 0; k < n; k++) {
          this.emit(this.bottom);
          for (let i = this.bottom; i > this.row; i--) this.grid[i] = this.grid[i - 1];
          this.grid[this.row] = "";
        }
        return;
      }
      case "M": {
        this.settle();
        // Delete lines: the deleted ones are finished.
        const n = Math.min(one(0, 1), this.bottom - this.row + 1);
        for (let k = 0; k < n; k++) {
          this.emit(this.row);
          for (let i = this.row; i < this.bottom; i++) this.grid[i] = this.grid[i + 1];
          this.grid[this.bottom] = "";
        }
        return;
      }
      case "r":
        this.top = Math.max(0, one(0, 1) - 1);
        this.bottom = Math.min(this.rows - 1, one(1, this.rows) - 1);
        if (this.bottom <= this.top) {
          this.top = 0;
          this.bottom = this.rows - 1;
        }
        return;
      case "s":
        this.saved = { row: this.row, col: this.col };
        return;
      case "u":
        if (this.saved) {
          this.row = this.saved.row;
          this.col = this.saved.col;
        }
        return;
      default:
        return; // colours, modes, device queries: nothing moves
    }
  }
}

module.exports = { Screen, sameLine, signature, isStatus };
