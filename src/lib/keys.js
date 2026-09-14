/**
 * Terminal key definitions for the mobile key bar and the command palette.
 *
 * Control sequences are built with String.fromCharCode so this file contains
 * no literal control characters and stays diff-friendly.
 */
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
/** Ctrl+<letter> is the letter minus 64 (Ctrl+C = 3). */
const ctrl = (letter) => String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);

export const KEYS = [
  { id: "up", label: "↑", seq: ESC + "[A", group: "nav" },
  { id: "down", label: "↓", seq: ESC + "[B", group: "nav" },
  { id: "left", label: "←", seq: ESC + "[D", group: "nav" },
  { id: "right", label: "→", seq: ESC + "[C", group: "nav" },
  { id: "enter", label: "Enter", seq: "\r", group: "nav" },
  // No seq: where the newline goes depends on where you are writing. In the
  // command box it is a line break in the box; straight to an agent it is
  // ESC+CR, the terminal encoding of Claude Code's insert-newline chord.
  { id: "shiftenter", label: "Shift+Enter", action: "newline", group: "nav" },
  { id: "esc", label: "Esc", seq: ESC, group: "nav" },
  { id: "tab", label: "Tab", seq: "\t", group: "nav" },
  { id: "backtab", label: "Shift+Tab", seq: ESC + "[Z", group: "nav" },
  { id: "space", label: "Space", seq: " ", group: "nav" },
  { id: "backspace", label: "⌫", seq: DEL, group: "nav" },

  { id: "ctrlc", label: "Ctrl+C", seq: ctrl("c"), group: "ctrl" },
  { id: "ctrld", label: "Ctrl+D", seq: ctrl("d"), group: "ctrl" },
  { id: "ctrll", label: "Ctrl+L", seq: ctrl("l"), group: "ctrl" },
  { id: "ctrlr", label: "Ctrl+R", seq: ctrl("r"), group: "ctrl" },
  { id: "ctrlz", label: "Ctrl+Z", seq: ctrl("z"), group: "ctrl" },
  { id: "ctrla", label: "Ctrl+A", seq: ctrl("a"), group: "ctrl" },
  { id: "ctrle", label: "Ctrl+E", seq: ctrl("e"), group: "ctrl" },
  { id: "ctrlu", label: "Ctrl+U", seq: ctrl("u"), group: "ctrl" },
  { id: "ctrlw", label: "Ctrl+W", seq: ctrl("w"), group: "ctrl" },

  { id: "home", label: "Home", seq: ESC + "[H", group: "move" },
  { id: "end", label: "End", seq: ESC + "[F", group: "move" },
  { id: "pgup", label: "PgUp", seq: ESC + "[5~", group: "move" },
  { id: "pgdn", label: "PgDn", seq: ESC + "[6~", group: "move" },

  // Handled by the app, never sent to the PTY.
  { id: "ctrl-tab", label: "Ctrl+Tab", action: "nextTab", group: "app" },
  { id: "ctrl-shift-tab", label: "Shift+Ctrl+Tab", action: "prevTab", group: "app" },
];

export const SEQ = { ESC, DEL, ctrl, UP: ESC + "[A", DOWN: ESC + "[B", ENTER: "\r" };

export const KEY_BY_ID = new Map(KEYS.map((k) => [k.id, k]));

export const DEFAULT_FAVOURITES = ["up", "down", "enter", "shiftenter", "esc", "tab", "ctrlc", "ctrl-tab"];
export const MAX_FAVOURITES = 8;

export function loadFavourites() {
  try {
    const raw = JSON.parse(localStorage.getItem("wt.favouriteKeys"));
    if (Array.isArray(raw)) {
      const valid = raw.filter((id) => KEY_BY_ID.has(id)).slice(0, MAX_FAVOURITES);
      if (valid.length) return valid;
    }
  } catch {}
  return [...DEFAULT_FAVOURITES];
}

export function saveFavourites(ids) {
  const valid = ids.filter((id) => KEY_BY_ID.has(id)).slice(0, MAX_FAVOURITES);
  localStorage.setItem("wt.favouriteKeys", JSON.stringify(valid));
  return valid;
}
