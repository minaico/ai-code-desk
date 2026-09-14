"use strict";
/**
 * Rebuild everything a session ever put on screen.
 *
 * A terminal shows a window, not a record. Claude Code reprints its whole
 * answer every time the answer grows; while the block still fits on screen
 * each reprint lands on top of the last one and nothing is lost, but once the
 * block is taller than the screen the top has already scrolled away and every
 * further reprint pushes another partial copy into the scrollback. What the
 * user is left with is the tail repeated several times and the opening
 * sections gone - which is exactly what a real terminal shows too. Measured on
 * one "tt" run: 67 reprints, and at the correct 204x51 geometry the scrollback
 * still held five copies of "2. Đã hoàn thành" and no copy at all of "1".
 *
 * The bytes, though, are complete. So instead of reading the final screen we
 * replay the recording and keep every distinct line any frame ever showed, in
 * the order it first appeared. Nothing that was drawn can escape that.
 */
const { Terminal } = require("@xterm/headless");

const CHUNK = 256;
const MAX_FRAMES = 6000;

/**
 * Where a redraw begins: the cursor sent home, the screen cleared, the
 * alternate screen entered or left. Cutting the stream here and reading the
 * screen in between is what makes each frame visible; cutting by byte count
 * instead - the obvious thing - swallows every frame that lands inside a chunk.
 *
 * Deliberately not every cursor move. One measured "tt" run held 88 of these
 * against 2559 absolute placements: a placement is a frame being painted, one
 * of these is a frame beginning. Stopping at all 2559 took seventy seconds to
 * learn nothing the 88 had not already said.
 */
const REPAINT = /\[(?:\d*[HJ]|\?1049[hl])/g;

/** Rows on screen now, trailing blanks trimmed. */
function frameLines(term, all = false) {
  const buf = term.buffer.active;
  const out = [];
  const from = all ? 0 : buf.baseY;
  const to = all ? buf.length : Math.min(buf.length, buf.baseY + term.rows);
  for (let i = from; i < to; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    out.push(line.translateToString(true).replace(/\s+$/, ""));
  }
  return out;
}

/** The stream cut into frames, with long unbroken runs cut by size as well. */
function segments(data) {
  const cuts = [0];
  REPAINT.lastIndex = 0;
  let m;
  while ((m = REPAINT.exec(data)) && cuts.length < MAX_FRAMES) {
    if (m.index > cuts[cuts.length - 1]) cuts.push(m.index);
  }
  cuts.push(data.length);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    for (let a = cuts[i]; a < cuts[i + 1]; a += CHUNK) {
      out.push(data.slice(a, Math.min(a + CHUNK, cuts[i + 1])));
    }
  }
  return out;
}

/**
 * A streamed line is drawn over and over as it grows, so the frames hold
 * "Chạy render", "Chạy render cụm đầu" and the finished sentence alike. Keeping
 * all three would read as a stutter. Only the longest survives, and it keeps
 * the position its first fragment had - the answer stays in its own order.
 */
function collapseGrowth(entries) {
  const kept = [];
  for (const entry of entries) {
    const trimmed = entry.text.trim();
    if (!trimmed) continue;
    // Only the line immediately before is considered. A line being typed out is
    // redrawn as the last line of consecutive frames, so its fragments arrive
    // back to back with nothing in between. Searching any further back merges
    // lines that merely begin alike - it read "muc 1" as an early draft of
    // "muc 10" and dropped it, which is the opposite of the point.
    const last = kept.length - 1;
    const a = last >= 0 ? kept[last].text.trim() : "";
    const grew = a && a.length !== trimmed.length && (a.startsWith(trimmed) || trimmed.startsWith(a));
    const prior = grew ? last : -1;
    if (prior < 0) {
      kept.push(entry);
      continue;
    }
    // Same line, further along: keep the fuller text at the earlier place.
    if (trimmed.length > kept[prior].text.trim().length) kept[prior] = { ...kept[prior], text: entry.text };
  }
  return kept;
}

/**
 * @param {string} data raw bytes as recorded
 * @param {{cols?:number, rows?:number}} replay geometry the recording was made at
 * @returns {Promise<string[]>} every distinct line ever shown, in first-seen order
 */
async function reconstruct(data, replay = {}) {
  if (!data) return [];
  const cols = Number(replay.cols) > 0 ? Math.min(500, Number(replay.cols)) : 120;
  const rows = Number(replay.rows) > 0 ? Math.min(200, Number(replay.rows)) : 32;
  const term = new Terminal({ cols, rows, scrollback: 20000, allowProposedApi: true });

  const seen = new Set();
  const entries = [];
  const harvest = (all = false) => {
    for (const text of frameLines(term, all)) {
      if (!text.trim() || seen.has(text)) continue;
      seen.add(text);
      entries.push({ text });
    }
  };

  // Every write is queued at once and each carries its own callback, rather
  // than awaiting one before sending the next. xterm runs those callbacks in
  // order as the parser drains, so each still sees the screen exactly as that
  // piece left it - and the whole recording costs one wait instead of
  // thousands. Measured on a 341 KB session: seventy seconds became 350 ms,
  // which is what makes it affordable to look this closely in the first place.
  //
  // Closely matters. A TUI redraws a block taller than the screen by writing
  // the top of it and overwriting that top later in the very same frame, so
  // sampling only between frames never sees the opening at all. That is why
  // the pieces are small.
  for (const piece of segments(data)) term.write(piece, () => harvest());
  await new Promise((resolve) => term.write("", resolve));
  harvest(true); // and once over everything, for whatever only ever scrolled
  try {
    term.dispose();
  } catch {}

  return collapseGrowth(entries).map((e) => e.text);
}

module.exports = { reconstruct, collapseGrowth };
