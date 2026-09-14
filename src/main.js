import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { api, Unauthorized, ttsAudio } from "./lib/api.js";
import { Connection } from "./lib/conn.js";
import { TerminalManager } from "./lib/terminals.js";
import { KEYS, KEY_BY_ID, loadFavourites, saveFavourites, MAX_FAVOURITES } from "./lib/keys.js";
import { analyse, planFor, readLines, readAllLines } from "./lib/claude.js";
import { trackViewport } from "./lib/viewport.js";
import { localHostId, machineMark, machineName } from "./lib/machines.js";
import { t, tr, lang, setLang } from "./lib/i18n.js";
import { mountShell, toast, formatBytes, formatUptime } from "./ui/shell.js";
import { FileExplorer } from "./ui/files.js";
import { DirPicker } from "./ui/dirs.js";
import { Palette } from "./ui/palette.js";
import { Reader } from "./ui/reader.js";
import { HistoryPanel } from "./ui/history.js";
import { HostsPanel } from "./ui/hosts.js";
import {
  Dictation,
  RemoteSpeaker,
  Speaker,
  isReadCommand,
  readableAnswer,
  voiceSupport,
} from "./lib/voice.js";

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const root = document.querySelector("#app");
const el = mountShell(root);
const reader = new Reader(el);

const state = {
  sessions: [],          // server-owned session records
  activeId: null,
  shells: [],
  launchers: [],
  favourites: loadFavourites(),
  assistEnabled: localStorage.getItem("wt.assist") !== "0",
  splitMode: "none",
  gitCache: new Map(),
  lastAnalysis: null,
  authRequired: false,
  /** Shells that exist on each machine, keyed by hostId. @type {Map<string,object>} */
  shellsByHost: new Map(),
  /** Whether this install uses named accounts rather than one shared password. */
  accounts: false,
  /** @type {{name:string, role:string, mustChange?:boolean}|null} */
  user: null,
  passwordForced: false,
  /** Set once boot has read the saved workspace; see saveWorkspace(). */
  workspaceLoaded: false,
  /** Whether this page has ever had a tab open; see saveWorkspace(). */
  everHadTabs: false,
  /** The workspace as last written: the tabs meant to be open; see saveWorkspace(). */
  savedTabs: [],
  /** Lineages the user closed on purpose, so a save may drop them. */
  closedLineages: new Set(),
  version: "",
  hosts: [],
  lastCommand: "",
  /** Whether the server can reach a VieNeu-TTS for reading out. */
  ttsRemote: false,
};

const isMobile = () => matchMedia("(max-width: 820px), (pointer: coarse)").matches;
/**
 * ?view - a window that watches without reshaping anything: a second monitor,
 * a projector, a demo. Opened at a different size it would otherwise claim its
 * own size for every terminal, and every agent on screen would redraw for it.
 * It attaches the way a phone does, without a size or a claim, and never
 * sends one.
 */
const viewOnly = new URLSearchParams(location.search).has("view");
/** Whether this window may tell the PTYs what size to be. */
const claimsSize = () => !isMobile() && !viewOnly;
const byId = (id) => state.sessions.find((s) => s.id === id) || null;

const conn = new Connection();

/**
 * On a phone, looking is not using. A phone that merely shows a session must
 * not reshape it: its fit-to-screen resize shrinks the PTY, Ink repaints the
 * live block for the new width, and the tail of the answer lands in the
 * scrollback a second time - which is exactly what a refresh on the phone did.
 * Typing is different: the person is working from the phone now, so the size
 * is claimed with the first keystroke.
 */
function claimSizeForInput(sessionId) {
  if (!isMobile()) return;
  const { cols, rows } = terminals.dims(sessionId);
  if (!(cols > 0 && rows > 0)) return;
  const last = conn.lastSize.get(sessionId);
  if (!last || last.cols !== cols || last.rows !== rows) conn.resize(sessionId, cols, rows);
}

const terminals = new TerminalManager(el("panes"), {
  onData: (sessionId, data) => {
    claimSizeForInput(sessionId);
    conn.input(sessionId, data);
  },
  // A phone's automatic refit stays local (xterm reflows for display); only
  // typing claims the PTY size. The desktop keeps claiming on every fit.
  onResize: (sessionId, cols, rows) => {
    if (!claimsSize()) return;
    conn.resize(sessionId, cols, rows);
  },
  onRender: (sessionId) => {
    if (sessionId === state.activeId) scheduleAssist();
  },
  isMobile,
});

// Read before any pane is built: a pane takes the size at the moment it is
// created, so choosing it afterwards would leave the first terminal behind.
terminals.setFontSize(Number(localStorage.getItem("wt.fontSize")) || 14);
// Virtual rows: the PTY gets a screen taller than the pane, so a Claude Code
// answer fits on it and is redrawn in place instead of reprinted into broken
// scrollback copies. On by default everywhere (100 rows - measured: 70
// suffice, 36 repeated one line 49 times); 0 turns it off. On a phone the
// slice is also what hides the wreckage below the cursor: a claimless phone
// shows a session drawn for a wider screen, and the live UI of that screen -
// borders, the auto-mode line - reflows into rubble that only clipping to the
// cursor's neighbourhood keeps out of sight.
{
  const saved = localStorage.getItem("wt.virtualRows");
  terminals.setVirtualRows(saved === null ? 100 : Number(saved));
}
// ?blur turns the output veil on for this window only, without touching the
// setting - a screen share or a demo, not a preference.
function applyPrivacy(on) {
  terminals.setPrivacy(on);
  document.body.classList.toggle("privacy", !!on);
}
applyPrivacy(localStorage.getItem("wt.privacy") === "1" || new URLSearchParams(location.search).has("blur"));

// The screen belongs to whoever is looking at it. A hidden tab sends no sizes
// (see conn.resize); when this tab comes back into view it says its size again
// - said outright, because xterm only raises onResize on a change, and this
// tab may have been right all along while a background one wrote 49x33 over it.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  terminals.fitVisible();
  if (!claimsSize()) return; // a phone (or ?view) coming into view is looking, not using
  for (const id of conn.attached) {
    if (!terminals.has(id)) continue;
    const { cols, rows } = terminals.dims(id);
    if (cols > 0 && rows > 0) conn.resize(id, cols, rows);
  }
});

/* ------------------------------------------------------------------ *
 * Session rendering
 * ------------------------------------------------------------------ */
function renderTabs() {
  const tabs = el("tabs");
  tabs.replaceChildren();
  for (const s of state.sessions) {
    const tab = document.createElement("button");
    tab.className = `tab${s.id === state.activeId ? " active" : ""}`;
    tab.title = `${s.title}\n${s.cwd}\npid ${s.pid || "-"} · ${s.status}` +
      `\n${s.hostName && state.hosts.length > 1 ? s.hostName + "\n" : ""}${t("Giữ hoặc chuột phải để đổi tên và màu")}`;
    applyTabColor(tab, s.color);

    // Shape says which machine, colour says whether it is still alive.
    const mark = machineMark(s.hostId, state.hosts, s.status, s.hostName, s.agent);
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = s.title;
    tab.append(mark, label);

    tab.onclick = () => {
      if (tab.dataset.longPressed) {
        delete tab.dataset.longPressed;
        return;
      }
      selectSession(s.id);
    };
    tab.oncontextmenu = (e) => {
      e.preventDefault();
      openTabDialog(s.id);
    };
    bindLongPress(tab, () => openTabDialog(s.id));

    // Drag to reorder, desktop only: on a phone a press-and-move on a tab is
    // how the strip is scrolled, and long-press is already the rename menu.
    if (!isMobile()) {
      tab.draggable = true;
      tab.ondragstart = (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", s.id);
        tab.classList.add("dragging");
      };
      tab.ondragend = () => tab.classList.remove("dragging");
      tab.ondragover = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Which half of this tab the pointer is over decides which side of it
        // the dragged tab lands on - the difference between "before" and
        // "after" when the two are adjacent.
        const box = tab.getBoundingClientRect();
        tab.classList.toggle("drop-before", e.clientX < box.left + box.width / 2);
        tab.classList.toggle("drop-after", e.clientX >= box.left + box.width / 2);
      };
      tab.ondragleave = () => tab.classList.remove("drop-before", "drop-after");
      tab.ondrop = (e) => {
        e.preventDefault();
        const after = tab.classList.contains("drop-after");
        tab.classList.remove("drop-before", "drop-after");
        moveTab(e.dataTransfer.getData("text/plain"), s.id, after);
      };
    }

    tabs.appendChild(tab);
  }
  const active = tabs.querySelector(".tab.active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// A wheel over the tab strip scrolls it sideways. The strip only scrolls
// horizontally, and a mouse wheel only turns vertically, so without this the
// gesture everyone tries first does nothing at all. Bound once, on the strip
// itself, rather than per tab - the tabs are rebuilt on every render.
el("tabs").addEventListener(
  "wheel",
  (ev) => {
    if (ev.ctrlKey) return; // the browser zooming; never ours to take
    const strip = el("tabs");
    const delta = Math.abs(ev.deltaY) > Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
    if (!delta) return;
    const before = strip.scrollLeft;
    strip.scrollLeft = before + delta;
    // At either end the page keeps the wheel, so a trackpad can still scroll
    // past a strip that has nowhere left to go.
    if (strip.scrollLeft !== before) ev.preventDefault();
  },
  { passive: false }
);

/** Put the dragged tab beside the one it was dropped on. */
function moveTab(dragId, targetId, after) {
  if (!dragId || dragId === targetId) return;
  const list = [...state.sessions];
  const from = list.findIndex((s) => s.id === dragId);
  const to = list.findIndex((s) => s.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = list.splice(from, 1);
  // Removing the dragged tab shifts everything after it left by one, so the
  // target's index has to be read again rather than adjusted by hand.
  const at = list.findIndex((s) => s.id === targetId);
  list.splice(after ? at + 1 : at, 0, moved);
  state.sessions = list;
  rememberTabOrder();
  renderTabs();
  renderSessionList();
  saveWorkspace();
}

function renderSessionList() {
  const list = el("sessionList");
  list.replaceChildren();
  if (!state.sessions.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.style.padding = "0 4px";
    p.textContent = t("Chưa có session nào.");
    list.appendChild(p);
    return;
  }
  for (const s of state.sessions) {
    const card = document.createElement("button");
    card.className = `session-card${s.id === state.activeId ? " active" : ""}`;

    const name = document.createElement("div");
    name.className = "name";
    const left = document.createElement("span");
    left.className = "ellipsis";
    left.textContent = s.title;
    name.append(left, machineMark(s.hostId, state.hosts, s.status, s.hostName, s.agent));

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = s.cwd;

    const meta2 = document.createElement("div");
    meta2.className = "meta";
    const where = state.hosts.length > 1 ? machineName(s.hostId, state.hosts, s.hostName) + " · " : "";
    meta2.textContent =
      where + s.shell + " · pid " + (s.pid || "-") + " · " + formatUptime(Date.now() - Date.parse(s.createdAt));

    card.append(name, meta, meta2);
    if (s.color) card.style.borderLeft = `3px solid ${s.color}`;
    card.onclick = () => selectSession(s.id);
    card.oncontextmenu = (e) => {
      e.preventDefault();
      openTabDialog(s.id);
    };
    list.appendChild(card);
  }
}

function renderAll() {
  renderTabs();
  renderSessionList();
}

/* ------------------------------------------------------------------ *
 * Session lifecycle
 * ------------------------------------------------------------------ */
/**
 * The order the user dragged the tabs into.
 *
 * Kept by lineage, not by session id: a terminal reopened from the history is
 * a new session but the same terminal, and it should come back where it was
 * rather than at the end. Anything not in the list sorts after everything that
 * is, in the order the server sent it.
 */
function tabOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem("wt.tabOrder"));
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveTabOrder(order) {
  localStorage.setItem("wt.tabOrder", JSON.stringify(order.slice(0, 200)));
}

function sortByTabOrder(sessions) {
  const order = tabOrder();
  if (!order.length) return sessions;
  const rank = new Map(order.map((key, i) => [key, i]));
  const place = (s) => {
    const byLineage = rank.get(s.lineage || s.id);
    return byLineage === undefined ? rank.get(s.id) : byLineage;
  };
  return [...sessions]
    .map((s, i) => ({ s, i, at: place(s) }))
    .sort((a, b) => {
      if (a.at === undefined && b.at === undefined) return a.i - b.i;
      if (a.at === undefined) return 1;
      if (b.at === undefined) return -1;
      return a.at - b.at || a.i - b.i;
    })
    .map((x) => x.s);
}

/** Write the current strip back as the remembered order. */
function rememberTabOrder() {
  saveTabOrder(state.sessions.map((s) => s.lineage || s.id));
}

function syncSessions(sessions, hosts) {
  if (Array.isArray(hosts)) state.hosts = hosts;
  state.sessions = sortByTabOrder(Array.isArray(sessions) ? sessions : []);
  const ids = new Set(state.sessions.map((s) => s.id));

  for (const s of state.sessions) {
    if (!terminals.has(s.id)) {
      terminals.ensure(s.id, s);
      // A hidden tab attaches without a size and without a claim: it wants the
      // stream, not a say in the terminal's shape. So does a phone that is
      // only showing the session - see claimSizeForInput, which claims the
      // size the moment the phone is actually typed on.
      if (document.hidden || !claimsSize()) {
        conn.attach(s.id, 0, 0, false);
      } else {
        const { cols, rows } = terminals.dims(s.id);
        conn.attach(s.id, cols, rows);
      }
    }
  }
  for (const id of [...conn.attached]) {
    if (!ids.has(id)) {
      conn.detach(id);
      terminals.remove(id);
    }
  }
  if (!ids.has(state.activeId)) {
    // A refresh must land on the tab that was open, not on whichever session
    // happens to be listed first. The choice survives in localStorage because
    // the page it lived in did not.
    const remembered = localStorage.getItem("wt.activeTab");
    state.activeId = ids.has(remembered) ? remembered : state.sessions[0] ? state.sessions[0].id : null;
  }
  if (state.activeId) terminals.setPrimary(state.activeId);
  renderAll();
  // Creating, reopening, killing and closing all land here, so this is the one
  // place the saved layout has to follow.
  saveWorkspace();
}

function selectSession(id) {
  if (!byId(id)) return;
  state.activeId = id;
  localStorage.setItem("wt.activeTab", id);
  terminals.setPrimary(id);
  renderAll();
  saveWorkspace();
  refreshGit();
  scheduleAssist();
  if (isMobile()) refocusInput();
  else terminals.focus(id);
}

function switchTab(delta) {
  if (state.sessions.length < 2) return;
  const i = state.sessions.findIndex((s) => s.id === state.activeId);
  const next = state.sessions[(Math.max(0, i) + delta + state.sessions.length) % state.sessions.length];
  selectSession(next.id);
}

/** Put a session the server just created on screen and start streaming it. */
function adoptSession(session) {
  terminals.ensure(session.id, session);
  // Attach with the size the new pane actually fitted to, not the guess we
  // created the session with — and only after attaching may we send resizes.
  const fitted = terminals.dims(session.id);
  conn.attach(session.id, fitted.cols, fitted.rows);
  state.activeId = session.id;
  localStorage.setItem("wt.activeTab", session.id);
  if (!state.sessions.some((s) => s.id === session.id)) state.sessions = [...state.sessions, session];
  terminals.setPrimary(session.id);
  renderAll();
  return session;
}

async function createSession(opts = {}) {
  try {
    const dims = terminals.dims(state.activeId) || { cols: 120, rows: 32 };
    const { session } = await api.createSession({ cols: dims.cols, rows: dims.rows, ...opts });
    adoptSession(session);
    toast(t("Đã tạo {name}", { name: session.title }));
    return session;
  } catch (err) {
    handleError(err);
    return null;
  }
}

async function renameSession(id) {
  const s = byId(id);
  if (!s) return;
  const title = prompt(t("Tên tab:"), s.title);
  if (!title) return;
  try {
    await api.renameSession(id, title);
  } catch (err) {
    handleError(err);
  }
}

async function killSession(id) {
  const s = byId(id);
  if (!s) return;
  if (!confirm(`Kill "${s.title}" (pid ${s.pid})?`)) return;
  try {
    await api.killSession(id);
    toast("Đã kill session");
  } catch (err) {
    handleError(err);
  }
}

async function restartSession(id) {
  if (!byId(id)) return;
  try {
    await api.restartSession(id);
    terminals.reset(id);
    toast("Đang khởi động lại...");
  } catch (err) {
    handleError(err);
  }
}

async function closeSession(id) {
  const s = byId(id);
  if (!s) return;
  if (s.status === "running" && !confirm(t('Đóng "{name}" sẽ kill tiến trình. Tiếp tục?', { name: s.title }))) return;
  try {
    await api.removeSession(id);
    // The one thing that may shrink the saved workspace: somebody said to close
    // this tab. Without it the tab would be kept as "not running right now" and
    // come back at the next restore. See saveWorkspace().
    state.closedLineages.add(s.lineage || s.id);
  } catch (err) {
    handleError(err);
  }
}

/* ------------------------------------------------------------------ *
 * Input into the PTY
 * ------------------------------------------------------------------ */
function sendRaw(data) {
  if (!state.activeId) {
    toast("Chưa có session", true);
    return;
  }
  claimSizeForInput(state.activeId);
  conn.input(state.activeId, data);
}

function sendKey(id) {
  const key = KEY_BY_ID.get(id);
  if (!key) return;
  if (key.action === "nextTab") return switchTab(1);
  if (key.action === "prevTab") return switchTab(-1);
  if (key.action === "newline") return insertNewline();
  sendRaw(key.seq);
  scheduleAssist();
  // Desktop keeps its focus in the terminal, as it always did.
  if (isMobile()) refocusInput();
}

/**
 * The Shift+Enter button. Where the newline goes depends on where the writing
 * is happening: mid-composition it belongs in the command box, exactly where
 * the caret is; with the box empty and idle it goes to the program as ESC+CR,
 * the terminal encoding of Claude Code's own insert-newline chord. A bare
 * carriage return would be wrong in both places - in the box it submits, in
 * Claude it sends the half-written message.
 */
function insertNewline() {
  if (cmdInput.value || document.activeElement === cmdInput) {
    const start = cmdInput.selectionStart ?? cmdInput.value.length;
    const end = cmdInput.selectionEnd ?? start;
    const NL = String.fromCharCode(10);
    cmdInput.value = cmdInput.value.slice(0, start) + NL + cmdInput.value.slice(end);
    cmdInput.selectionStart = cmdInput.selectionEnd = start + 1;
    sizeInputToContent();
    refocusInput();
    return;
  }
  sendRaw(String.fromCharCode(27, 13)); // ESC CR - not a bare submit
}

/* IME-safe native input ------------------------------------------------ */
let composing = false;
const cmdInput = el("cmdInput");

cmdInput.addEventListener("compositionstart", () => {
  composing = true;
});
cmdInput.addEventListener("compositionend", () => {
  composing = false;
});

cmdInput.addEventListener("keydown", (e) => {
  // While the IME is composing (Telex/VNI, Gboard, iOS), Enter belongs to the
  // IME. Touching the value here is what breaks Vietnamese input.
  if (e.isComposing || composing || e.keyCode === 229) return;

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitInput();
  } else if (e.key === "Tab") {
    e.preventDefault();
    sendKey(e.shiftKey ? "backtab" : "tab");
  } else if (e.key === "Escape") {
    e.preventDefault();
    sendKey("esc");
  } else if (e.key === "ArrowUp" && !cmdInput.value) {
    e.preventDefault();
    sendKey("up");
  } else if (e.key === "ArrowDown" && !cmdInput.value) {
    e.preventDefault();
    sendKey("down");
  }
  // Ctrl+C and Ctrl+V are left to the browser on purpose: in a text box they
  // mean copy and paste, as they do on every other web page. Interrupting the
  // program is the key bar's Ctrl+C button (or Ctrl+C in the terminal itself,
  // with nothing selected).
});

// Shift+Enter adds a line; the box grows to show what it holds, up to the CSS
// max-height, and shrinks back when submitted.
function sizeInputToContent() {
  cmdInput.style.height = "42px";
  if (cmdInput.scrollHeight > cmdInput.clientHeight) {
    cmdInput.style.height = `${cmdInput.scrollHeight + 2}px`;
  }
}
cmdInput.addEventListener("input", sizeInputToContent);

/**
 * Put the caret back in the command box without ever summoning the keyboard.
 *
 * On a phone the keyboard is the user's to open: it belongs to a tap on the
 * command box, because it covers half of what they are reading. So focus is
 * only ever *restored* here - if the keyboard is already up it stays up, and
 * if it is down nothing we do puts it back.
 */
function refocusInput() {
  if (!isMobile()) return cmdInput.focus();
  if (document.body.classList.contains("keyboard-open")) cmdInput.focus();
}

function submitInput() {
  if (composing) return;
  const text = cmdInput.value;
  cmdInput.value = "";
  sizeInputToContent();
  if (text.trim()) state.lastCommand = text.trim();
  // What an embedded newline becomes depends on who is listening. A plain
  // carriage return SUBMITS: right for a shell, where each line is a command,
  // but in Claude Code it chops one multi-line message into several separate
  // ones. Claude Code's own "insert a newline" keystroke is Alt+Enter, which
  // the terminal encodes as ESC CR - so that is what a newline becomes when an
  // agent is running. (The host announces the agent as soon as the command
  // starts, so the flag is current by the time anyone types a second message.)
  const active = byId(state.activeId);
  const newline = active && active.agent ? "\u001b\r" : "\r";
  sendRaw(text.replace(/\r?\n/g, newline) + "\r");
  scheduleAssist();
  refocusInput();
}

el("cmdSend").onclick = () => submitInput();

/* ------------------------------------------------------------------ *
 * Key bar
 * ------------------------------------------------------------------ */
function renderKeys() {
  const fav = el("favKeys");
  fav.replaceChildren();
  const favSet = new Set(state.favourites);
  for (const id of state.favourites) {
    const key = KEY_BY_ID.get(id);
    if (!key) continue;
    const b = document.createElement("button");
    b.textContent = key.label;
    b.onclick = () => sendKey(id);
    fav.appendChild(b);
  }

  const more = el("moreKeys");
  more.replaceChildren();
  for (const key of KEYS) {
    if (favSet.has(key.id)) continue;
    const b = document.createElement("button");
    b.textContent = key.label;
    b.onclick = () => sendKey(key.id);
    more.appendChild(b);
  }
}

el("btnMoreKeys").onclick = () => el("moreKeys").classList.toggle("hidden");

/* ------------------------------------------------------------------ *
 * Workspace — the tabs survive the machine they ran on
 * ------------------------------------------------------------------ */
let workspaceTimer = null;

/**
 * Save which terminals are meant to be open, whenever that changes.
 *
 * The list is not "what is running right now". A tab leaves this set when the
 * user closes it, and at no other time. Writing the running sessions instead is
 * what turned a PTY host restart into data loss: the host comes back owning
 * nothing, this page sees six live tabs where there were twenty-five, and saves
 * six - erasing nineteen tabs that had not gone anywhere and were still sitting
 * in the history, one click from being reopened. Measured, twice, on a real
 * restart.
 *
 * So a save is the union of what is live and what was already saved, minus what
 * the user actually closed. Shrinking is an instruction, never an observation.
 *
 * Two further guards, both about the same moment - a machine that lost power:
 *
 *   workspaceLoaded  nothing is written until boot has read what was there.
 *   everHadTabs      an empty list is only written once this page has actually
 *                    had a tab. "I closed them all" is a real instruction;
 *                    "there were none to begin with" is not.
 */
function saveWorkspace() {
  if (!state.workspaceLoaded) return;
  if (state.sessions.length) state.everHadTabs = true;
  else if (!state.everHadTabs) return;
  clearTimeout(workspaceTimer);
  workspaceTimer = setTimeout(async () => {
    const live = state.sessions.map((s) => ({
      lineage: s.lineage || s.id,
      entryId: s.id,
      hostId: s.hostId || localHostId(state.hosts),
      title: s.title,
      color: s.color || "",
      shell: s.shell,
      cwd: s.cwd,
    }));
    const seen = new Set(live.map((t) => t.lineage));
    const kept = state.savedTabs.filter((t) => !seen.has(t.lineage) && !state.closedLineages.has(t.lineage));
    const tabs = [...live, ...kept];
    try {
      await api.saveWorkspace({
        tabs,
        activeIndex: state.sessions.findIndex((s) => s.id === state.activeId),
      });
      state.savedTabs = tabs;
    } catch {
      // Losing a layout save is not worth interrupting anyone over; the next
      // change tries again.
    }
  }, 600);
}

function describeTab(tab) {
  const where = machineName(tab.hostId, state.hosts, tab.hostName);
  const what = {
    live: t("đang chạy"),
    exited: t("đã thoát — sẽ chạy lại"),
    restorable: t("sẽ mở lại từ lịch sử"),
    offline: t("máy chưa kết nối"),
    gone: t("không còn trong lịch sử"),
  }[tab.state];
  return { where, what };
}

async function offerRestore({ silent = false } = {}) {
  let workspace;
  try {
    workspace = await api.workspace();
  } catch (err) {
    if (!silent) toast(err.message, true);
    return;
  }
  const tabs = workspace.tabs || [];
  // What was saved is the starting point for what gets saved next; see
  // saveWorkspace(). Read it back in the shape a save writes, dropping the
  // per-tab state the server adds for this dialog. A tab the history no longer
  // knows about ("gone") cannot be reopened by anybody, so it is not carried.
  state.savedTabs = tabs
    .filter((t) => t.state !== "gone")
    .map((t) => ({
      lineage: t.lineage,
      entryId: t.entryId,
      hostId: t.hostId || localHostId(state.hosts),
      title: t.title,
      color: t.color || "",
      shell: t.shell,
      cwd: t.cwd,
    }));
  if (!tabs.length) {
    if (!silent) toast("Chưa có phiên làm việc nào được lưu");
    return;
  }
  // Nothing to offer when every tab is already running.
  if (silent && tabs.every((t) => t.state === "live")) return;

  const list = el("restoreList");
  list.replaceChildren();
  for (const tab of tabs) {
    const { where, what } = describeTab(tab);
    const row = document.createElement("div");
    row.className = "restore-row";
    row.appendChild(
      machineMark(tab.hostId, state.hosts, tab.state === "live" ? "running" : "exited", tab.hostName, tab.agent)
    );
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "ellipsis";
    name.textContent = tab.title || tab.shell;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${where} · ${what}${tab.cwd ? " · " + tab.cwd : ""}`;
    text.append(name, meta);
    row.appendChild(text);
    list.appendChild(row);
  }

  const count = (kind) => tabs.filter((t) => t.state === kind).length;
  const actionable = count("exited") + count("restorable");
  const when = workspace.savedAt ? new Date(workspace.savedAt).toLocaleString() : "";
  const bits = [t("{n} đang chạy", { n: count("live") })];
  if (count("exited")) bits.push(t("{n} chạy lại được", { n: count("exited") }));
  if (count("restorable")) bits.push(t("{n} mở lại từ lịch sử", { n: count("restorable") }));
  if (count("offline")) bits.push(t("{n} máy chưa lên", { n: count("offline") }));
  if (count("gone")) bits.push(t("{n} không còn", { n: count("gone") }));
  el("restoreHint").textContent =
    t("{n} tab đã lưu", { n: tabs.length }) + (when ? t(" lúc {when}", { when }) : "") + ". " + bits.join(", ") + ".";
  el("restoreRun").disabled = actionable === 0;
  el("restoreDlg").showModal();
}

el("restoreRun").onclick = async () => {
  const button = el("restoreRun");
  button.disabled = true;
  button.textContent = t("Đang khôi phục…");
  try {
    const { restored, failed } = await api.restoreWorkspace();
    el("restoreDlg").close();
    const opened = restored.filter((r) => !r.reused).length;
    toast(
      opened
        ? t("Đã khôi phục {n} tab", { n: opened }) + (failed.length ? t(", {n} tab không mở được", { n: failed.length }) : "")
        : "Mọi tab đã đang chạy"
    );
    if (failed.length) {
      for (const f of failed.slice(0, 3)) toast(`${f.title || f.shell}: ${tr(f.reason)}`, true);
    }
    const { sessions, hosts } = await api.listSessions();
    syncSessions(sessions, hosts);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.textContent = t("Khôi phục");
    button.disabled = false;
  }
};

el("restoreForget").onclick = async () => {
  try {
    // An empty save is what "forget" means; there is no separate delete.
    await api.saveWorkspace({ tabs: [], activeIndex: -1 });
    // Drop what was carried forward too, or the next save puts it all back.
    state.savedTabs = [];
    el("restoreDlg").close();
    toast("Đã quên phiên làm việc đã lưu");
  } catch (err) {
    toast(err.message, true);
  }
};

/* ------------------------------------------------------------------ *
 * Side panel as a drawer (phone)
 * ------------------------------------------------------------------ */
function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  el("menuBackdrop").classList.toggle("hidden", !open);
  if (!open) el("profileMenu").classList.add("hidden");
}
const menuOpen = () => document.body.classList.contains("menu-open");

el("btnMenu").onclick = () => setMenu(!menuOpen());
el("menuBackdrop").onclick = () => setMenu(false);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (el("profileMenu").classList.contains("hidden") === false) {
    el("profileMenu").classList.add("hidden");
    return;
  }
  if (menuOpen()) setMenu(false);
});

// A menu that only closes by its own button is a menu you have to think about.
document.addEventListener("click", (e) => {
  const menu = el("profileMenu");
  if (menu.classList.contains("hidden")) return;
  if (menu.contains(e.target) || el("btnProfile").contains(e.target)) return;
  menu.classList.add("hidden");
});

// Every entry in the panel opens something of its own, so the drawer has done
// its job by the time one is tapped and should get out of the way.
for (const id of ["btnFiles", "btnGit", "btnHistory", "btnHosts", "btnDiag", "btnSettings", "btnKeyConfig"]) {
  el(id).addEventListener("click", () => setMenu(false));
}
el("sessionList").addEventListener("click", () => setMenu(false));
el("sideLaunchers").addEventListener("click", () => setMenu(false));

/* ------------------------------------------------------------------ *
 * Who is logged in
 * ------------------------------------------------------------------ */
function renderProfile() {
  const chip = el("btnProfile");
  const user = state.user;
  if (!user) {
    chip.classList.add("hidden");
    el("profileMenu").classList.add("hidden");
    return;
  }
  chip.classList.remove("hidden");
  el("profileName").textContent = user.name;
  const avatar = el("profileAvatar");
  avatar.textContent = user.name.slice(0, 2);
  avatar.classList.toggle("admin", user.role === "admin");
  el("profileUsers").classList.toggle("hidden", user.role !== "admin");

  const who = el("profileWho");
  who.replaceChildren();
  const name = document.createElement("b");
  name.textContent = user.name;
  who.appendChild(name);
  who.appendChild(document.createTextNode(user.role === "admin" ? t("Quản trị viên") : t("Người dùng thường")));
}

el("btnProfile").onclick = () => el("profileMenu").classList.toggle("hidden");

el("profilePassword").onclick = () => {
  el("profileMenu").classList.add("hidden");
  setMenu(false);
  showPasswordChange(false);
};

el("profileUsers").onclick = () => {
  el("profileMenu").classList.add("hidden");
  setMenu(false);
  openUsers();
};

el("profileLogout").onclick = async () => {
  try {
    await api.logout();
  } catch {}
  location.reload();
};

el("btnKeyConfig").onclick = () => {
  const box = el("keyChoices");
  box.replaceChildren();
  const fav = new Set(state.favourites);
  for (const key of KEYS) {
    const label = document.createElement("label");
    label.className = "choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = key.id;
    input.checked = fav.has(key.id);
    input.onchange = () => {
      const checked = box.querySelectorAll("input:checked");
      if (checked.length > MAX_FAVOURITES) {
        input.checked = false;
        toast(t("Tối đa {n} phím", { n: MAX_FAVOURITES }), true);
      }
    };
    const span = document.createElement("span");
    span.textContent = key.label;
    label.append(input, span);
    box.appendChild(label);
  }
  el("keyCfgDlg").showModal();
};

el("keyCfgForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const ids = [...el("keyChoices").querySelectorAll("input:checked")].map((i) => i.value);
  state.favourites = saveFavourites(ids.length ? ids : state.favourites);
  renderKeys();
  el("keyCfgDlg").close();
});

/* ------------------------------------------------------------------ *
 * Claude Assist (level 3, with a level-2 fallback)
 * ------------------------------------------------------------------ */
let assistTimer = null;
function scheduleAssist() {
  clearTimeout(assistTimer);
  assistTimer = setTimeout(renderAssist, 140);
}

// The reconstructed session, fetched once per opening. The screen alone is not
// enough: a Claude Code answer taller than the terminal loses its opening
// sections to the scroll long before it finishes, so reading the visible buffer
// can only ever show the tail. The server replays the recording and hands back
// every line the session ever drew.
let readerFull = { sessionId: null, lines: [] };

function renderReader() {
  if (!reader.visible) return;
  const pane = state.activeId ? terminals.get(state.activeId) : null;
  // The whole buffer: what Claude Code draws below the cursor is part of
  // the screen, and one of those lines is the only thing that still says
  // this is Claude Code at all.
  const live = pane ? readAllLines(pane.term) : [];
  const history = readerFull.sessionId === state.activeId ? readerFull.lines : [];
  if (!history.length) return reader.render(live);
  // The history stops where the fetch did; whatever has been drawn since is on
  // screen and nowhere else, so the live rows top it up without repeating it.
  const seen = new Set(history.map((l) => l.trim()));
  reader.render([...history, ...live.filter((l) => l.trim() && !seen.has(l.trim()))]);
}

/** Pull the full session back from the server, then redraw the reader. */
async function loadReaderHistory() {
  const id = state.activeId;
  if (!id) return;
  try {
    const r = await api.transcript(id);
    if (state.activeId !== id) return; // the user moved on while we fetched
    readerFull = { sessionId: id, lines: Array.isArray(r.lines) ? r.lines : [] };
  } catch {
    // The visible buffer still reads; it just starts later than it should.
    readerFull = { sessionId: null, lines: [] };
  }
  renderReader();
}

let assistSignature = "";

function renderAssist() {
  renderReader();
  const bar = el("assist");
  const actions = el("assistActions");

  if (!state.assistEnabled || !state.activeId || !terminals.has(state.activeId)) {
    assistSignature = "off";
    actions.replaceChildren();
    bar.classList.add("hidden");
    return;
  }

  const pane = terminals.get(state.activeId);
  const result = analyse(readLines(pane.term, 60));
  state.lastAnalysis = result;

  // Every frame the terminal paints asks for this. Rebuilding an identical bar
  // on each one is what a finger reads as flicker, and it steals the button
  // out from under a tap that is already on its way down.
  const signature = JSON.stringify([result.kind, result.confidence, result.selected, result.hint, result.options]);
  if (signature === assistSignature) return;
  assistSignature = signature;
  actions.replaceChildren();

  if (result.kind === "none") {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  el("assistHint").textContent = result.hint ? t(result.hint) : "";

  if (result.confidence === "high" && result.options.length) {
    result.options.forEach((option, index) => {
      const b = document.createElement("button");
      b.textContent = option.text;
      if (index === result.selected) b.classList.add("selected");
      b.onclick = () => chooseAssist(result, index);
      actions.appendChild(b);
    });
    return;
  }

  // Not sure what is selected: never guess. Offer the raw TUI controls.
  const note = document.createElement("span");
  note.className = "fallback-note";
  note.textContent = result.kind === "waiting" ? t("Dùng phím thật:") : t("Không chắc chắn — dùng phím thật:");
  actions.appendChild(note);
  for (const id of ["up", "down", "enter", "esc"]) {
    const key = KEY_BY_ID.get(id);
    const b = document.createElement("button");
    b.textContent = key.label;
    b.onclick = () => sendKey(id);
    actions.appendChild(b);
  }
}

function chooseAssist(result, index) {
  const plan = planFor(result, index);
  if (!plan.length) {
    toast("Không xác định được lựa chọn — hãy dùng phím ↑ ↓ Enter", true);
    return;
  }
  // Space the keystrokes out so the TUI can repaint between them.
  plan.forEach((seq, i) => setTimeout(() => sendRaw(seq), i * 45));
  setTimeout(scheduleAssist, plan.length * 45 + 220);
}

el("assistOff").onclick = () => {
  state.assistEnabled = false;
  localStorage.setItem("wt.assist", "0");
  renderAssist();
  toast("Đã tắt Claude Assist (bật lại trong Settings)");
};

/* ------------------------------------------------------------------ *
 * Git
 * ------------------------------------------------------------------ */
async function refreshGit() {
  const s = byId(state.activeId);
  if (!s) return;
  const cwd = s.cwd;
  try {
    const info = await api.gitStatus(cwd);
    state.gitCache.set(cwd, info);
  } catch {
    state.gitCache.set(cwd, { error: true });
  }
}

async function openGitPanel() {
  const s = byId(state.activeId);
  if (!s) return toast("Chưa có session", true);
  const body = el("gitBody");
  body.textContent = t("Đang tải…");
  el("gitDlg").showModal();
  try {
    const [status, branches, log] = await Promise.all([
      api.gitStatus(s.cwd),
      api.gitBranches(s.cwd).catch(() => ({ branches: [] })),
      api.gitLog(s.cwd, 15).catch(() => ({ commits: [] })),
    ]);
    body.replaceChildren();

    const head = document.createElement("p");
    head.innerHTML = `<b>${status.branch || "detached"}</b> — ${status.modified} modified, ${status.untracked} untracked` +
      (status.ahead ? `, ahead ${status.ahead}` : "") + (status.behind ? `, behind ${status.behind}` : "");
    body.appendChild(head);

    const path = document.createElement("p");
    path.className = "muted";
    path.textContent = status.cwd;
    body.appendChild(path);

    const files = document.createElement("pre");
    files.className = "diag";
    files.textContent = status.files.length
      ? status.files.map((f) => `${f.code} ${f.path}`).join("\n")
      : "working tree clean";
    body.appendChild(files);

    if (branches.branches.length) {
      const h = document.createElement("p");
      h.innerHTML = "<b>Branches</b>";
      const pre = document.createElement("pre");
      pre.className = "diag";
      pre.textContent = branches.branches.map((b) => `${b.current ? "*" : " "} ${b.name}`).join("\n");
      body.append(h, pre);
    }
    if (log.commits.length) {
      const h = document.createElement("p");
      h.innerHTML = "<b>Recent commits</b>";
      const pre = document.createElement("pre");
      pre.className = "diag";
      pre.textContent = log.commits.map((c) => `${c.hash} ${c.when.padEnd(16)} ${c.subject}`).join("\n");
      body.append(h, pre);
    }

    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = t("Chỉ đọc. Dùng terminal cho pull/push/commit.");
    body.appendChild(hint);
  } catch (err) {
    body.textContent = err.message;
  }
}

el("btnGit").onclick = () => openGitPanel();

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */
const explorer = new FileExplorer(el, {
  onOpenInTerminal: (dir) => createSession({ cwd: dir, title: dir.split(/[\\/]/).pop() }),
});
el("btnFiles").onclick = () => {
  const s = byId(state.activeId);
  explorer.open(s ? s.cwd : "").catch(() => {});
};

/* ------------------------------------------------------------------ *
 * New-terminal dialog
 * ------------------------------------------------------------------ */
function openNewDialog(preset = {}) {
  const hostSel = el("newHost");
  hostSel.replaceChildren();
  const machines = state.hosts.length ? state.hosts : [{ id: "local", name: "This machine", connected: true }];
  for (const h of machines) {
    const o = document.createElement("option");
    o.value = h.id;
    o.textContent = h.name + (h.connected ? "" : " (offline)");
    o.disabled = !h.connected;
    hostSel.appendChild(o);
  }
  const active = byId(state.activeId);
  const here = localHostId(machines);
  hostSel.value = preset.hostId || (active && active.hostId) || here;

  const shellSel = el("newShell");
  /** Offer the shells that machine actually has, not the ones this one has. */
  const fillShells = () => {
    const entry = state.shellsByHost.get(hostSel.value);
    // A machine that is connected but could not answer is running a PTY host
    // from before this question existed. Offering nothing there would take away
    // something that used to work; the local list is the guess it was making
    // anyway, now marked as one.
    const stale = !!(entry && entry.connected && entry.error);
    const shells = stale ? state.shells : (entry && entry.shells) || (hostSel.value === here ? state.shells : []);
    const wanted = shellSel.value;
    shellSel.replaceChildren();
    for (const sh of shells) {
      const o = document.createElement("option");
      o.value = sh.id;
      o.textContent = sh.label;
      shellSel.appendChild(o);
    }
    if (!shells.length) {
      const o = document.createElement("option");
      o.textContent = entry && !entry.connected ? t("Máy chưa kết nối") : t("Không tìm thấy shell nào");
      o.value = "";
      shellSel.appendChild(o);
    }
    // Keep the choice when it exists on the new machine too - bash is bash.
    if (shells.some((sh) => sh.id === wanted)) shellSel.value = wanted;
    el("newSubmit").disabled = !shells.length;
    el("newShellNote").textContent = stale
      ? t("Máy này chạy bản cũ nên chưa khai báo được shell của nó — danh sách dưới đây là của máy chủ.")
      : "";
    el("newShellNote").classList.toggle("hidden", !stale);
    // Browsing folders only works on the machine running this web server.
    el("newBrowse").disabled = hostSel.value !== here;
  };
  hostSel.onchange = fillShells;
  fillShells();
  if (preset.shell && [...shellSel.options].some((o) => o.value === preset.shell)) {
    shellSel.value = preset.shell;
  }
  const s = byId(state.activeId);
  el("newCwd").value = preset.cwd || (s ? s.cwd : "");
  el("newTitle").value = preset.title || "";
  el("newAutoRun").value = preset.autoRun || "";
  el("newDlg").showModal();
}

el("newForm").addEventListener("submit", (e) => {
  e.preventDefault();
  el("newDlg").close();
  createSession({
    hostId: el("newHost").value,
    shell: el("newShell").value,
    cwd: el("newCwd").value.trim(),
    title: el("newTitle").value.trim(),
    autoRun: el("newAutoRun").value.trim(),
  });
});

el("btnNew").onclick = () => openNewDialog();

const dirPicker = new DirPicker(el, {
  onPick: (dir) => {
    el("newCwd").value = dir;
  },
});
el("newBrowse").onclick = () => dirPicker.open(el("newCwd").value.trim());

function renderLaunchers() {
  const box = el("sideLaunchers");
  box.replaceChildren();
  // Room for the shells plus every coding agent a machine has installed; the
  // palette (Ctrl+K) lists them all regardless.
  for (const l of state.launchers.slice(0, 10)) {
    const b = document.createElement("button");
    b.textContent = l.label.replace(/^New /, "");
    b.title = l.label;
    b.onclick = () => createSession({ shell: l.shell, autoRun: l.autoRun, title: l.title });
    box.appendChild(b);
  }
}

/* ------------------------------------------------------------------ *
 * Split
 * ------------------------------------------------------------------ */
function cycleSplit() {
  if (isMobile() && window.innerHeight < 520) {
    toast("Màn hình quá nhỏ để chia đôi", true);
    return;
  }
  const order = ["none", "horizontal", "vertical"];
  state.splitMode = order[(order.indexOf(state.splitMode) + 1) % order.length];
  terminals.setSplit(state.splitMode);
  if (state.splitMode !== "none") {
    const other = state.sessions.find((s) => s.id !== state.activeId);
    terminals.setSecondary(other ? other.id : null);
    if (!other) toast("Cần ít nhất 2 session để chia đôi", true);
  }
  el("btnSplit").textContent = state.splitMode === "none" ? "▤" : state.splitMode === "horizontal" ? "▥" : "▦";
  toast(`Split: ${state.splitMode}`);
}
el("btnSplit").onclick = cycleSplit;

function toggleReader(on) {
  const active = reader.toggle(on);
  el("btnReader").classList.toggle("on", active);
  if (active) {
    renderReader(); // the screen at once, the full session a moment later
    loadReaderHistory();
  } else setTimeout(() => terminals.fitVisible(), 0);
}
el("btnReader").onclick = () => toggleReader();
el("readerOff").onclick = () => toggleReader(false);

/* ------------------------------------------------------------------ *
 * Diagnostics & settings
 * ------------------------------------------------------------------ */
async function openDiagnostics() {
  const body = el("diagBody");
  body.textContent = t("Đang tải…");
  if (!el("diagDlg").open) el("diagDlg").showModal();
  try {
    const info = await api.system();
    body.replaceChildren();
    const rows = [
      ["Node", info.web.node],
      ["Windows", `${info.system.hostname} · ${info.system.release} · ${info.system.arch}`],
      ["Web server", `pid ${info.web.pid} · port ${info.web.port} · up ${formatUptime(info.web.uptimeMs)}`],
      ["PTY host", info.ptyHost.connected ? `connected · pid ${info.ptyHost.hostPid} · up ${formatUptime(Date.now() - info.ptyHost.hostStartedAt)}` : "DISCONNECTED"],
      ["Sessions", `${info.ptyHost.stats && info.ptyHost.stats.sessionCount != null ? info.ptyHost.stats.sessionCount : "?"} (${info.ptyHost.stats && info.ptyHost.stats.runningCount != null ? info.ptyHost.stats.runningCount : "?"} running)`],
      ["WebSocket clients", String(info.web.wsClients)],
      ["Auth", info.web.authRequired ? "password required" : "OPEN - no password set"],
      ["Roots", info.web.roots.join(" ; ")],
      ["Memory (web)", formatBytes(info.web.memory.rss)],
      ["System memory", `${formatBytes(info.system.freeMem)} free / ${formatBytes(info.system.totalMem)}`],
      ["System uptime", formatUptime(info.system.uptimeSec * 1000)],
    ];
    const table = document.createElement("div");
    for (const [k, v] of rows) {
      const line = document.createElement("div");
      line.className = "row";
      line.style.padding = "5px 0";
      line.style.borderBottom = "1px solid var(--line-soft)";
      const a = document.createElement("span");
      a.className = "muted";
      a.style.flex = "0 0 150px";
      a.textContent = k;
      const b = document.createElement("span");
      b.className = "grow";
      b.style.wordBreak = "break-word";
      b.textContent = v;
      line.append(a, b);
      table.appendChild(line);
    }
    body.appendChild(table);

    if (info.logs && info.logs.length) {
      const h = document.createElement("p");
      h.innerHTML = `<b>${t("Log gần đây")}</b>`;
      const pre = document.createElement("pre");
      pre.className = "diag";
      pre.textContent = info.logs.slice(-60).map((l) => {
        try {
          const o = JSON.parse(l);
          return `${o.ts.slice(11, 19)} ${o.level.padEnd(5)} ${o.event}`;
        } catch {
          return l;
        }
      }).join("\n");
      body.append(h, pre);
    }
  } catch (err) {
    body.textContent = err.message;
  }
}
el("btnDiag").onclick = openDiagnostics;
el("diagRefresh").onclick = openDiagnostics;

function openSettings() {
  const body = el("settingsBody");
  body.replaceChildren();

  // First, and labelled in both languages in Vietnamese mode: someone who
  // cannot read the rest of this dialog has to be able to find this one row.
  const uiRow = document.createElement("label");
  uiRow.className = "field";
  const uiLabel = document.createElement("span");
  uiLabel.textContent = lang === "en" ? t("Ngôn ngữ giao diện") : "Ngôn ngữ giao diện / Interface language";
  const uiSel = document.createElement("select");
  for (const [value, text] of [
    ["vi", "Tiếng Việt"],
    ["en", "English"],
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    o.selected = lang === value;
    uiSel.appendChild(o);
  }
  uiSel.onchange = () => setLang(uiSel.value);
  uiRow.append(uiLabel, uiSel);
  body.appendChild(uiRow);

  const blurRow = document.createElement("label");
  blurRow.className = "choice";
  const blurInput = document.createElement("input");
  blurInput.type = "checkbox";
  blurInput.checked = terminals.privacy;
  blurInput.onchange = () => {
    applyPrivacy(blurInput.checked);
    localStorage.setItem("wt.privacy", blurInput.checked ? "1" : "0");
  };
  const blurLabel = document.createElement("span");
  blurLabel.textContent = t("Làm mờ output và đường dẫn (khi chia sẻ màn hình; chữ bạn gõ vẫn rõ)");
  blurRow.append(blurInput, blurLabel);
  body.appendChild(blurRow);

  const assistRow = document.createElement("label");
  assistRow.className = "choice";
  const assistInput = document.createElement("input");
  assistInput.type = "checkbox";
  assistInput.checked = state.assistEnabled;
  assistInput.onchange = () => {
    state.assistEnabled = assistInput.checked;
    localStorage.setItem("wt.assist", assistInput.checked ? "1" : "0");
    renderAssist();
  };
  const assistLabel = document.createElement("span");
  assistLabel.textContent = t("Bật Claude Assist (nhận diện menu TUI)");
  assistRow.append(assistInput, assistLabel);
  body.appendChild(assistRow);

  const inputRow = document.createElement("label");
  inputRow.className = "choice";
  const inputInput = document.createElement("input");
  inputInput.type = "checkbox";
  inputInput.checked = document.body.classList.contains("force-input");
  inputInput.onchange = () => {
    document.body.classList.toggle("force-input", inputInput.checked);
    localStorage.setItem("wt.forceInput", inputInput.checked ? "1" : "0");
    terminals.fitVisible();
  };
  const inputLabel = document.createElement("span");
  inputLabel.textContent = t("Hiện ô nhập lệnh + phím tắt trên desktop");
  inputRow.append(inputInput, inputLabel);
  body.appendChild(inputRow);

  const sideRow = document.createElement("label");
  sideRow.className = "choice";
  const sideInput = document.createElement("input");
  sideInput.type = "checkbox";
  sideInput.checked = (localStorage.getItem("wt.panelSide") || "right") === "left";
  sideInput.onchange = () => {
    localStorage.setItem("wt.panelSide", sideInput.checked ? "left" : "right");
    applyPanel();
  };
  const sideLabel = document.createElement("span");
  sideLabel.textContent = t("Đặt panel bên trái (mặc định bên phải)");
  sideRow.append(sideInput, sideLabel);
  body.appendChild(sideRow);

  // Font size, shown with the number of rows it buys. The row count is the
  // point: Claude Code redraws an answer in place only while it fits on screen,
  // and reprints it when it does not, so a short terminal fills its scrollback
  // with half-copies. Measured on one real "tt": 36 rows repeated a line up to
  // 49 times, 49 rows twice, 70 rows not at all.
  const fontRow = document.createElement("label");
  fontRow.className = "field";
  fontRow.style.marginTop = "12px";
  const fontLabel = document.createElement("span");
  const rowsNow = () => {
    const d = state.activeId ? terminals.dims(state.activeId) : null;
    return d ? t(" — hiện {cols}x{rows} ({rows} dòng)", { cols: d.cols, rows: d.rows }) : "";
  };
  fontLabel.textContent = t("Cỡ chữ terminal") + rowsNow();
  const fontInput = document.createElement("input");
  fontInput.type = "number";
  fontInput.min = "8";
  fontInput.max = "24";
  fontInput.step = "1";
  fontInput.value = String(Number(localStorage.getItem("wt.fontSize")) || 14);
  fontInput.onchange = () => {
    const size = terminals.setFontSize(fontInput.value);
    fontInput.value = String(size);
    localStorage.setItem("wt.fontSize", String(size));
    // The pane refits on the next frame; read the rows after it has.
    setTimeout(() => {
      fontLabel.textContent = t("Cỡ chữ terminal") + rowsNow();
    }, 60);
  };
  fontRow.append(fontLabel, fontInput);
  body.appendChild(fontRow);

  // Virtual rows. The PTY is told this many rows however small the window, so
  // a Claude Code answer fits on its screen and is redrawn in place instead of
  // reprinted into broken scrollback copies; the pane shows the slice around
  // the cursor and the wheel scrolls up through the rest. vim and less will
  // use the full height too - anyone living in those can set 0 for the classic
  // exact fit.
  const vrowsRow = document.createElement("label");
  vrowsRow.className = "field";
  vrowsRow.style.marginTop = "12px";
  const vrowsLabel = document.createElement("span");
  vrowsLabel.textContent = t("Số dòng terminal ảo (0 = vừa màn hình; nên để 100 cho Claude Code)");
  const vrowsInput = document.createElement("input");
  vrowsInput.type = "number";
  vrowsInput.min = "0";
  vrowsInput.max = "200";
  vrowsInput.step = "10";
  {
    const saved = localStorage.getItem("wt.virtualRows");
    vrowsInput.value = String(saved === null ? 100 : Number(saved));
  }
  vrowsInput.onchange = () => {
    const rows = terminals.setVirtualRows(vrowsInput.value);
    vrowsInput.value = String(rows);
    localStorage.setItem("wt.virtualRows", String(rows));
  };
  vrowsRow.append(vrowsLabel, vrowsInput);
  body.appendChild(vrowsRow);

  const langRow = document.createElement("label");
  langRow.className = "field";
  langRow.style.marginTop = "12px";
  const langLabel = document.createElement("span");
  langLabel.textContent = t("Ngôn ngữ giọng nói");
  const langSel = document.createElement("select");
  for (const [value, text] of [
    ["vi-VN", t("Tiếng Việt (vi-VN)")],
    ["en-US", "English (en-US)"],
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    o.selected = voiceLang() === value;
    langSel.appendChild(o);
  }
  langSel.onchange = () => {
    localStorage.setItem("wt.voiceLang", langSel.value);
    dictation.lang = langSel.value;
    speaker.lang = langSel.value;
  };
  langRow.append(langLabel, langSel);
  body.appendChild(langRow);

  const engineRow = document.createElement("label");
  engineRow.className = "field";
  const engineLabel = document.createElement("span");
  engineLabel.textContent = t("Giọng đọc kết quả");
  const engineSel = document.createElement("select");
  for (const [value, text] of [
    ["vieneu", t("VieNeu — đọc được cả Việt lẫn Anh")],
    ["browser", t("Giọng của trình duyệt")],
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    o.selected = voiceEngine() === value;
    engineSel.appendChild(o);
  }
  engineRow.append(engineLabel, engineSel);
  body.appendChild(engineRow);

  const vieneuRow = document.createElement("label");
  vieneuRow.className = "field";
  const vieneuLabel = document.createElement("span");
  vieneuLabel.textContent = t("Giọng VieNeu");
  const vieneuSel = document.createElement("select");
  vieneuSel.disabled = true;
  const placeholder = document.createElement("option");
  placeholder.textContent = state.ttsRemote ? t("Đang tải...") : t("Server tắt VieNeu");
  vieneuSel.appendChild(placeholder);
  vieneuSel.onchange = () => {
    localStorage.setItem("wt.voiceId", vieneuSel.value);
    remoteSpeaker.voiceId = vieneuSel.value;
  };
  vieneuRow.append(vieneuLabel, vieneuSel);
  body.appendChild(vieneuRow);

  const syncEngineRows = () => {
    vieneuRow.style.display = engineSel.value === "vieneu" ? "" : "none";
  };
  engineSel.onchange = () => {
    localStorage.setItem("wt.voiceEngine", engineSel.value);
    syncEngineRows();
  };
  syncEngineRows();

  if (state.ttsRemote) {
    // Asking VieNeu for its voices is also how we find out it is running.
    api
      .ttsVoices()
      .then(({ voices, unavailable }) => {
        vieneuSel.textContent = "";
        if (!voices || !voices.length) {
          const o = document.createElement("option");
          o.textContent = unavailable ? t("Chưa chạy VieNeu-TTS") : t("Không có giọng nào");
          vieneuSel.appendChild(o);
          return;
        }
        for (const v of voices) {
          const o = document.createElement("option");
          o.value = v.id;
          o.textContent = v.name;
          o.selected = voiceId() === v.id;
          vieneuSel.appendChild(o);
        }
        vieneuSel.disabled = false;
      })
      .catch(() => {
        placeholder.textContent = t("Không hỏi được danh sách giọng");
      });
  }

  const keysBtn = document.createElement("button");
  keysBtn.textContent = t("Cấu hình phím ưa thích");
  keysBtn.style.marginTop = "10px";
  keysBtn.onclick = () => {
    el("settingsDlg").close();
    el("btnKeyConfig").click();
  };
  body.appendChild(keysBtn);

  const help = document.createElement("p");
  help.className = "muted";
  help.style.marginTop = "14px";
  const ver = document.createElement("p");
  ver.className = "muted";
  ver.style.marginTop = "14px";
  ver.textContent = `AI Code Desk v${state.version || "?"}`;
  body.appendChild(ver);

  help.innerHTML = t(
    "Phím tắt: <b>Ctrl+K</b> command palette · <b>Alt+1..9</b> chọn tab · <b>Ctrl+PageUp/PageDown</b> đổi tab. Trình duyệt giữ Ctrl+Tab cho chính nó, nên hãy dùng nút Ctrl+Tab trên thanh phím hoặc Alt+số."
  );
  body.appendChild(help);

  if (state.accounts && state.user) {
    const account = document.createElement("div");
    account.className = "settings-account";
    const who = document.createElement("p");
    who.className = "muted";
    who.textContent =
      t("Đang đăng nhập: {name}", { name: state.user.name }) + (state.user.role === "admin" ? t(" (quản trị viên)") : "");
    account.appendChild(who);

    const change = document.createElement("button");
    change.textContent = t("Đổi mật khẩu");
    change.onclick = () => {
      el("settingsDlg").close();
      showPasswordChange(false);
    };
    account.appendChild(change);

    if (state.user.role === "admin") {
      const manage = document.createElement("button");
      manage.textContent = t("Quản lý người dùng");
      manage.onclick = () => {
        el("settingsDlg").close();
        openUsers();
      };
      account.appendChild(manage);
    }
    body.appendChild(account);
  }

  el("settingsDlg").showModal();
}
el("btnSettings").onclick = openSettings;

/* ------------------------------------------------------------------ *
 * Users (admin)
 * ------------------------------------------------------------------ */
async function openUsers() {
  const dlg = el("usersDlg");
  if (!dlg.open) dlg.showModal();
  await renderUsers();
}

function usersFail(message) {
  const box = el("usersError");
  box.textContent = message || "";
  box.classList.toggle("hidden", !message);
}

async function renderUsers() {
  const list = el("usersList");
  usersFail("");
  try {
    const { users } = await api.users();
    list.replaceChildren();
    for (const u of users) {
      const row = document.createElement("div");
      row.className = "user-row";

      const name = document.createElement("div");
      name.className = "user-name";
      name.textContent = u.name;
      const tags = document.createElement("small");
      const bits = [u.role === "admin" ? t("quản trị viên") : t("người dùng")];
      if (u.mustChange) bits.push(t("chưa đổi mật khẩu"));
      bits.push(u.lastLoginAt ? t("đăng nhập {when}", { when: new Date(u.lastLoginAt).toLocaleString() }) : t("chưa đăng nhập"));
      tags.textContent = bits.join(" · ");
      name.appendChild(tags);
      row.appendChild(name);

      const reset = document.createElement("button");
      reset.textContent = t("Đặt lại mật khẩu");
      reset.onclick = async () => {
        const pw = randomPassword();
        try {
          await api.resetUserPassword(u.name, pw);
          // Shown once, here, because the server never stores it in the clear
          // and there is nowhere else it could come from later.
          toast(t("Mật khẩu tạm của {name}: {pw}", { name: u.name, pw }));
          await renderUsers();
        } catch (err) {
          usersFail(err.message);
        }
      };
      row.appendChild(reset);

      const isMe = state.user && state.user.name.toLowerCase() === u.name.toLowerCase();
      if (!isMe) {
        const del = document.createElement("button");
        del.className = "danger";
        del.textContent = t("Xoá");
        del.onclick = async () => {
          try {
            await api.removeUser(u.name);
            await renderUsers();
          } catch (err) {
            usersFail(err.message);
          }
        };
        row.appendChild(del);
      }
      list.appendChild(row);
    }
  } catch (err) {
    usersFail(err.message);
  }
}

/** A password nobody has to invent, and long enough not to be guessed. */
function randomPassword() {
  const letters = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  const word = () => Array.from({ length: 4 }, () => pick(letters)).join("");
  return `${word()}-${word()}-${pick(digits)}${pick(digits)}${pick(digits)}`;
}

el("userAddForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = el("newUserName").value.trim();
  const password = el("newUserPassword").value || randomPassword();
  try {
    await api.addUser({ name, password, role: el("newUserAdmin").checked ? "admin" : "user" });
    el("newUserName").value = "";
    el("newUserPassword").value = "";
    el("newUserAdmin").checked = false;
    toast(t("Đã tạo {name}. Mật khẩu tạm: {pw}", { name, pw: password }));
    await renderUsers();
  } catch (err) {
    usersFail(err.message);
  }
});

el("btnLogout").onclick = async () => {
  try {
    await api.logout();
  } catch {}
  location.reload();
};

/* ------------------------------------------------------------------ *
 * Command palette
 * ------------------------------------------------------------------ */
const palette = new Palette(el, () => {
  const items = [];
  for (const l of state.launchers) {
    items.push({
      label: l.label,
      hint: l.shell,
      run: () => createSession({ shell: l.shell, autoRun: l.autoRun, title: l.title }),
    });
  }
  items.push({ label: t("New Terminal (tuỳ chọn)…"), hint: "dialog", run: () => openNewDialog() });
  items.push({ label: "File Explorer", hint: "files", run: () => el("btnFiles").click() });
  items.push({ label: t("Lịch sử session"), hint: "history", run: () => historyPanel.open() });
  items.push({ label: t("Phiên làm việc đã lưu"), hint: "workspace", run: () => offerRestore() });
  items.push({ label: t("Máy (multi-machine)"), hint: "hosts", run: () => hostsPanel.open() });
  items.push({ label: t("Đọc kết quả"), hint: "voice", run: () => speakResult() });
  items.push({ label: t("Nhập bằng giọng nói"), hint: "voice", run: () => voiceButtons("mic")[0].click() });
  items.push({ label: t("Ẩn/hiện panel"), hint: "layout", run: () => el("btnPanel").click() });
  items.push({ label: "Git Status", hint: "git", run: () => openGitPanel() });
  items.push({ label: "Diagnostics", hint: "system", run: () => openDiagnostics() });
  items.push({ label: "Settings", hint: t("cấu hình"), run: () => openSettings() });
  items.push({ label: "Split terminal", hint: "layout", run: () => cycleSplit() });
  items.push({ label: "Reconnect", hint: "websocket", run: () => conn.connect() });

  if (state.activeId) {
    items.push({ label: `Restart: ${byId(state.activeId).title}`, hint: "session", run: () => restartSession(state.activeId) });
    items.push({ label: `Kill: ${byId(state.activeId).title}`, hint: "session", run: () => killSession(state.activeId) });
    items.push({ label: t("Tên và màu tab: {name}", { name: byId(state.activeId).title }), hint: "session", run: () => openTabDialog(state.activeId) });
    items.push({ label: `Close tab: ${byId(state.activeId).title}`, hint: "session", run: () => closeSession(state.activeId) });
  }
  for (const s of state.sessions) {
    items.push({
      label: `→ ${s.title}`,
      hint: `${s.status} · pid ${s.pid || "-"} · ${s.cwd}`,
      run: () => selectSession(s.id),
    });
  }
  return items;
});


/* ------------------------------------------------------------------ *
 * Tab name and colour
 * ------------------------------------------------------------------ */
const TAB_COLORS = [
  { name: "Mặc định", value: "" },
  { name: "Đỏ", value: "#f87171" },
  { name: "Cam", value: "#fb923c" },
  { name: "Vàng", value: "#fbbf24" },
  { name: "Lục", value: "#4ade80" },
  { name: "Lam", value: "#38bdf8" },
  { name: "Chàm", value: "#818cf8" },
  { name: "Tím", value: "#c084fc" },
  { name: "Hồng", value: "#f472b6" },
  { name: "Xám", value: "#94a3b8" },
];

/** Black or white text, whichever stays readable on the chosen colour. */
function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#08111f" : "#ffffff";
}

function applyTabColor(node, color) {
  if (!color) {
    node.classList.remove("colored");
    node.style.removeProperty("--tab-color");
    node.style.removeProperty("--tab-fg");
    return;
  }
  node.classList.add("colored");
  node.style.setProperty("--tab-color", color);
  node.style.setProperty("--tab-fg", readableOn(color));
}

/**
 * Press and hold opens the same panel as right-click.
 *
 * Two things make this fragile on a phone and both are handled here: iOS pops
 * its own callout on a long press unless the element opts out (see the CSS),
 * and a finger that is merely resting still emits touchmove, so movement is
 * only treated as a scroll once it passes a threshold.
 */
function bindLongPress(node, run) {
  const MOVE_TOLERANCE_PX = 12;
  let timer = null;
  let origin = null;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    origin = null;
  };

  node.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      origin = touch ? { x: touch.clientX, y: touch.clientY } : null;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // The tap that ends the hold must not also select the tab.
        node.dataset.longPressed = "1";
        run();
      }, 500);
    },
    { passive: true }
  );

  node.addEventListener(
    "touchmove",
    (e) => {
      if (!timer || !origin) return;
      const touch = e.touches[0];
      if (!touch) return;
      const moved = Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y);
      if (moved > MOVE_TOLERANCE_PX) cancel();
    },
    { passive: true }
  );

  for (const ev of ["touchend", "touchcancel"]) {
    node.addEventListener(ev, cancel, { passive: true });
  }
}

/** Mirrors titleFromCwd() on the server, for the hint in the dialog. */
function titleOfFolder(cwd) {
  const trimmed = String(cwd || "").replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + "\\";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

let tabDialogId = null;
let tabPreviousName = "";

function openTabDialog(id) {
  const s = byId(id);
  if (!s) return;
  tabDialogId = id;
  const name = el("tabName");
  const auto = el("tabAuto");
  // The switch always starts off: the field shows the name the tab has now,
  // ready to edit. Ticking the switch is the deliberate act that throws that
  // name away in favour of the folder.
  name.value = s.title;
  auto.checked = false;
  tabPreviousName = s.title;
  el("tabAutoHint").textContent = t("Theo thư mục hiện tại sẽ là: {name}", { name: titleOfFolder(s.cwd) });

  const msg = el("tabMsg");
  if (s.autoTitle === undefined) {
    // The PTY host predates tab names and colours, so it will refuse to save.
    msg.textContent =
      t("PTY host đang chạy bản cũ nên không lưu được tên/màu. Khởi động lại PTY host (sẽ đóng mọi session đang chạy).");
    msg.classList.remove("hidden");
  } else {
    msg.textContent = "";
    msg.classList.add("hidden");
  }

  // The name field and the switch must never disagree: typing a name turns
  // auto off, emptying it turns auto back on, and ticking the switch clears
  // the field. Before this, a name typed with the switch still ticked was
  // thrown away on save.
  name.oninput = () => {
    // Typing a name is the same statement as untickinging the switch.
    if (name.value.trim()) auto.checked = false;
  };
  auto.onchange = () => {
    if (auto.checked) {
      tabPreviousName = name.value;
      name.value = "";
    } else {
      name.value = tabPreviousName || s.title;
      name.focus();
    }
  };

  const box = el("tabColors");
  box.replaceChildren();
  for (const c of TAB_COLORS) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = `swatch${(s.color || "") === c.value ? " selected" : ""}`;
    swatch.dataset.color = c.value;
    swatch.title = t(c.name);
    if (c.value) swatch.style.background = c.value;
    else swatch.textContent = "∅";
    swatch.onclick = () => {
      for (const other of box.querySelectorAll(".swatch")) other.classList.remove("selected");
      swatch.classList.add("selected");
    };
    box.appendChild(swatch);
  }
  el("tabDlg").showModal();
}

el("tabSave").onclick = async () => {
  if (!tabDialogId) return;
  const selected = el("tabColors").querySelector(".swatch.selected");
  const wanted = el("tabName").value.trim();
  const patch = {
    title: el("tabAuto").checked ? "" : wanted,
    autoTitle: el("tabAuto").checked,
    color: selected ? selected.dataset.color : "",
  };
  try {
    const { session } = await api.updateSession(tabDialogId, patch);
    // Keep what came back rather than what we asked for, so the tab always
    // shows what the server actually stored.
    state.sessions = state.sessions.map((s) => (s.id === session.id ? { ...s, ...session } : s));
    renderAll();
    el("tabDlg").close();
    toast(`Tab: ${session.title}`);
  } catch (err) {
    // The dialog stays open on failure so nothing typed is lost, and the
    // reason is shown inside it - a toast under a modal dialog is invisible.
    const raw = err.message || "";
    const message = /not found/i.test(raw)
      ? t("Tab này không còn nữa")
      : /unknown message type/i.test(raw)
        ? t("PTY host đang chạy bản cũ. Khởi động lại PTY host rồi thử lại (sẽ đóng mọi session).")
        : tr(raw) || t("Không lưu được");
    const msg = el("tabMsg");
    msg.textContent = message;
    msg.classList.remove("hidden");
    toast(message, true);
  }
};

el("tabRestart").onclick = () => {
  el("tabDlg").close();
  if (tabDialogId) restartSession(tabDialogId);
};
el("tabKill").onclick = () => {
  el("tabDlg").close();
  if (tabDialogId) killSession(tabDialogId);
};
el("tabCloseTab").onclick = () => {
  el("tabDlg").close();
  if (tabDialogId) closeSession(tabDialogId);
};
el("btnPalette").onclick = () => palette.open();

/* ------------------------------------------------------------------ *
 * History and machines
 * ------------------------------------------------------------------ */
const historyPanel = new HistoryPanel(el, {
  onReopen: (session) => adoptSession(session),
  hosts: () => state.hosts,
});
const hostsPanel = new HostsPanel(el, {
  onChange: (hosts) => {
    state.hosts = hosts;
    renderAll();
  },
});

el("btnHistory").onclick = () => historyPanel.open();
el("btnWorkspace").onclick = () => offerRestore();
el("btnHosts").onclick = () => hostsPanel.open();

/* ------------------------------------------------------------------ *
 * Voice in and voice out
 * ------------------------------------------------------------------ */
const voiceLang = () => localStorage.getItem("wt.voiceLang") || "vi-VN";
/**
 * Which engine reads answers out. VieNeu is the default because a terminal
 * answer is Vietnamese prose with English identifiers all through it, and only
 * a bilingual voice gets both halves right; the browser's own voices are the
 * fallback for when VieNeu is not running.
 */
const voiceEngine = () => localStorage.getItem("wt.voiceEngine") || "vieneu";
const voiceId = () => localStorage.getItem("wt.voiceId") || "";
let voiceBase = "";
let remoteVoiceError = "";

/** Both copies of a voice button: one in the top bar, one by the input box. */
const voiceButtons = (action) => [...root.querySelectorAll(`[data-action="${action}"]`)];

const showSpeaking = (speaking) => {
  for (const b of voiceButtons("speak")) {
    b.classList.toggle("active", speaking);
    b.textContent = speaking ? "⏹" : "🔊";
  }
};

const speaker = new Speaker({ lang: voiceLang(), onState: showSpeaking });

const remoteSpeaker = new RemoteSpeaker({
  fetchAudio: ttsAudio,
  voiceId: voiceId(),
  onState: showSpeaking,
  // Reported by speakResult once it knows whether the fallback also failed,
  // so a VieNeu that is simply not running costs one message, not two.
  onError: (message) => {
    remoteVoiceError = message;
  },
});

/** The engine to use right now: VieNeu when it is both wanted and available. */
const pickSpeaker = () =>
  state.ttsRemote && voiceEngine() === "vieneu" && remoteSpeaker.supported ? remoteSpeaker : speaker;

const dictation = new Dictation({
  lang: voiceLang(),
  onState: (listening) => {
    for (const b of voiceButtons("mic")) b.classList.toggle("recording", listening);
    if (listening) {
      // On desktop the command box is hidden by default; dictation needs
      // somewhere visible to land, so reveal it while listening.
      document.body.classList.add("force-input");
      terminals.fitVisible();
      voiceBase = cmdInput.value;
      refocusInput();
    }
  },
  onText: (text, isFinal) => {
    if (isFinal && isReadCommand(text)) {
      // Spoken command, not dictation: read the last answer back instead.
      cmdInput.value = voiceBase;
      speakResult();
      return;
    }
    const joiner = voiceBase && !/\s$/.test(voiceBase) ? " " : "";
    cmdInput.value = voiceBase + joiner + text;
    if (isFinal) {
      voiceBase = cmdInput.value;
      refocusInput();
    }
  },
  onError: (message) => toast(message, true),
});

/**
 * Read the answer to the last thing that was sent, out loud.
 *
 * Must be called straight from a click: iOS only lets audio start inside a
 * user gesture, and unlock() has to happen before the first await.
 */
async function speakResult() {
  const engine = pickSpeaker();
  engine.unlock();
  if (engine.speaking || speaker.speaking || remoteSpeaker.speaking) {
    engine.stop();
    speaker.stop();
    remoteSpeaker.stop();
    return;
  }
  if (!state.activeId || !terminals.has(state.activeId)) {
    toast("Chưa có session", true);
    return;
  }
  const pane = terminals.get(state.activeId);
  const text = readableAnswer(readLines(pane.term, 200), state.lastCommand);
  if (!text) {
    toast("Không có kết quả để đọc", true);
    return;
  }

  if (engine === speaker) {
    if (!speaker.supported) toast("Trình duyệt này không đọc được văn bản", true);
    else {
      speaker.lang = voiceLang();
      speaker.speak(text);
    }
    return;
  }

  remoteVoiceError = "";
  remoteSpeaker.voiceId = voiceId();
  const spoken = await remoteSpeaker.speak(text);
  if (spoken) return;
  // VieNeu is down or the model is not loaded. A browser voice mangles half
  // the words, but it beats silence, so say why and read it anyway.
  if (!speaker.supported) {
    toast(remoteVoiceError || "Không đọc được", true);
    return;
  }
  toast(t("VieNeu không đọc được ({why}) — dùng giọng trình duyệt", { why: tr(remoteVoiceError) || t("không kết nối") }), true);
  speaker.lang = voiceLang();
  speaker.speak(text);
}

for (const b of voiceButtons("mic")) {
  b.onclick = () => {
    // Saying "đọc kết quả" reaches speakResult() from a speech event, which is
    // not a user gesture; this tap is, so spend it unlocking playback now.
    remoteSpeaker.unlock();
    if (!dictation.supported) {
      toast("Trình duyệt này không hỗ trợ nhập bằng giọng nói", true);
      return;
    }
    dictation.lang = voiceLang();
    dictation.toggle();
  };
  if (!voiceSupport.input) b.classList.add("unsupported");
}
for (const b of voiceButtons("speak")) {
  b.onclick = () => speakResult();
  if (!voiceSupport.output) b.classList.add("unsupported");
}

/* ------------------------------------------------------------------ *
 * Side panel
 * ------------------------------------------------------------------ */
function applyPanel() {
  const collapsed = localStorage.getItem("wt.panelCollapsed") === "1";
  const side = localStorage.getItem("wt.panelSide") || "right";
  document.body.classList.toggle("panel-collapsed", collapsed);
  document.body.classList.toggle("panel-left", side === "left");
  el("btnPanel").textContent = collapsed ? "▤" : "▥";
  el("btnPanel").title = collapsed ? t("Hiện panel") : t("Ẩn panel");
  terminals.fitVisible();
}

el("btnPanel").onclick = () => {
  const collapsed = localStorage.getItem("wt.panelCollapsed") === "1";
  localStorage.setItem("wt.panelCollapsed", collapsed ? "0" : "1");
  applyPanel();
};
applyPanel();


/* ------------------------------------------------------------------ *
 * Global shortcuts
 * ------------------------------------------------------------------ */
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    palette.open();
    return;
  }
  if (e.ctrlKey && e.key === "Tab") {
    // Chrome/Edge keep Ctrl+Tab for themselves; where it can be captured we do.
    e.preventDefault();
    switchTab(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) {
    e.preventDefault();
    switchTab(e.key === "PageDown" ? 1 : -1);
    return;
  }
  if (e.altKey && /^[1-9]$/.test(e.key)) {
    const s = state.sessions[Number(e.key) - 1];
    if (s) {
      e.preventDefault();
      selectSession(s.id);
    }
  }
});

/* ------------------------------------------------------------------ *
 * Connection wiring
 * ------------------------------------------------------------------ */
// There is no permanent status bar any more, so the connection only speaks up
// when something actually changed: dropped, or recovered after a drop.
let wasOffline = false;
conn.addEventListener("state", (e) => {
  const { state: s } = e.detail;
  if (s === "offline") {
    if (!wasOffline) toast("Mất kết nối — đang thử lại…", true);
    wasOffline = true;
  } else if (s === "online" && wasOffline) {
    wasOffline = false;
    toast("Đã kết nối lại");
  }
});

conn.addEventListener("unauthorized", () => showLogin());

conn.addEventListener("message", (e) => {
  const msg = e.detail;
  switch (msg.type) {
    case "ready":
      syncSessions(msg.sessions || [], msg.hosts);
      if (!msg.hostConnected) toast("PTY host chưa sẵn sàng…", true);
      break;
    case "sessions":
      syncSessions(msg.sessions || [], msg.hosts);
      break;
    case "history":
      terminals.replaceHistory(msg.sessionId, msg.data || "", msg.replay);
      if (msg.sessionId === state.activeId) scheduleAssist();
      break;
    case "output":
      terminals.write(msg.sessionId, msg.data);
      break;
    case "reset":
      terminals.reset(msg.sessionId);
      break;
    case "cwd": {
      const s = byId(msg.sessionId);
      if (s) {
        s.cwd = msg.cwd;
        // The working directory shows on the session card and in the tab
        // tooltip now, so a cwd change redraws those.
        renderAll();
        if (msg.sessionId === state.activeId) refreshGit();
      }
      break;
    }
    case "exit":
      if (msg.sessionId === state.activeId) toast(t("Tiến trình đã thoát ({code})", { code: msg.exitCode }), true);
      break;
    case "hostState":
      if (Array.isArray(msg.hosts)) state.hosts = msg.hosts;
      if (!msg.connected) toast(t("Máy {name} offline", { name: msg.hostName || "local" }), true);
      if (msg.connected && msg.sessions) syncSessions(msg.sessions, msg.hosts);
      break;
    case "error":
      toast(msg.message || "Lỗi", true);
      break;
    default:
      break;
  }
});

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
function showLogin(message) {
  const dlg = el("loginDlg");
  const err = el("loginError");
  if (message) {
    err.textContent = message;
    err.classList.remove("hidden");
  } else {
    err.classList.add("hidden");
  }
  // An install that predates accounts has one shared password and nobody to
  // name; asking for a username there would be asking for a wrong answer.
  const named = state.accounts !== false;
  el("loginUserField").classList.toggle("hidden", !named);
  el("loginHint").textContent = named ? t("Đăng nhập để tiếp tục.") : t("Nhập mật khẩu quản trị để tiếp tục.");
  if (!dlg.open) dlg.showModal();
  setTimeout(() => el(named ? "loginUsername" : "loginPassword").focus(), 50);
}

el("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = el("loginUsername").value.trim();
  const password = el("loginPassword").value;
  try {
    const r = await api.login(username, password);
    el("loginPassword").value = "";
    el("loginDlg").close();
    state.user = r.user || null;
    if (r.user && r.user.mustChange) return showPasswordChange(true);
    await boot(true);
  } catch (err) {
    showLogin(err.message);
  }
});

/* ------------------------------------------------------------------ *
 * Password
 * ------------------------------------------------------------------ */
/** @param {boolean} forced first login: the dialog cannot be dismissed. */
function showPasswordChange(forced) {
  const dlg = el("passwordDlg");
  state.passwordForced = !!forced;
  el("passwordHint").textContent = forced
    ? t("Đây là lần đăng nhập đầu tiên. Hãy đặt mật khẩu của riêng bạn trước khi dùng tiếp.")
    : t("Đổi mật khẩu của bạn.");
  el("passwordClose").classList.toggle("hidden", !!forced);
  el("pwError").classList.add("hidden");
  for (const id of ["pwCurrent", "pwNext", "pwConfirm"]) el(id).value = "";
  if (!dlg.open) dlg.showModal();
  setTimeout(() => el("pwCurrent").focus(), 50);
}

el("passwordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = el("pwError");
  const next = el("pwNext").value;
  const fail = (m) => {
    err.textContent = m;
    err.classList.remove("hidden");
  };
  if (next.length < 8) return fail(t("Mật khẩu mới phải có ít nhất 8 ký tự"));
  if (next !== el("pwConfirm").value) return fail(t("Hai lần nhập không khớp"));
  try {
    const r = await api.changePassword(el("pwCurrent").value, next);
    state.user = r.user || state.user;
    el("passwordDlg").close();
    renderProfile();
    toast("Đã đổi mật khẩu");
    if (state.passwordForced) await boot(true);
    state.passwordForced = false;
  } catch (e2) {
    fail(e2.message);
  }
});

// A forced change must not be escaped with Esc; the server refuses everything
// else anyway, so letting the dialog close would only produce a dead screen.
el("passwordDlg").addEventListener("cancel", (e) => {
  if (state.passwordForced) e.preventDefault();
});

function handleError(err) {
  if (err instanceof Unauthorized) {
    showLogin(t("Phiên đăng nhập đã hết hạn."));
    return;
  }
  if (err && err.data && err.data.mustChange) {
    showPasswordChange(true);
    return;
  }
  toast(err.message || String(err), true);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
async function boot(afterLogin = false) {
  try {
    const cfg = await api.config();
    state.authRequired = cfg.authRequired;
    state.accounts = !!cfg.accounts;
    state.user = cfg.user || null;
    state.version = cfg.version;
    state.ttsRemote = !!cfg.ttsRemote;
    if (cfg.authRequired && !cfg.authenticated) {
      showLogin();
      return;
    }
    if (state.user && state.user.mustChange) {
      showPasswordChange(true);
      return;
    }
    renderProfile();
    if (!cfg.authRequired) toast("Cảnh báo: server đang chạy không mật khẩu", true);
    else if (cfg.usingDefaultPassword) toast("Đang dùng mật khẩu mặc định 123123 — hãy đổi trước khi mở ra Internet", true);

    const profiles = await api.profiles();
    state.shells = profiles.shells || [];
    state.launchers = profiles.launchers || [];
    state.shellsByHost = new Map((profiles.byHost || []).map((h) => [h.hostId, h]));
    renderLaunchers();

    const { sessions, hosts } = await api.listSessions();
    syncSessions(sessions, hosts);

    conn.connect();
    if (afterLogin) toast("Đã đăng nhập");

    // Read what was open last time before allowing any save, then offer to put
    // it back if anything is missing.
    await offerRestore({ silent: true });
    state.workspaceLoaded = true;
  } catch (err) {
    if (err instanceof Unauthorized) showLogin();
    else toast(err.message, true);
  }
}

if (localStorage.getItem("wt.forceInput") === "1") document.body.classList.add("force-input");
renderKeys();
renderAll();
boot();

// The layout follows visualViewport, so when the mobile keyboard opens the app
// shrinks into the space above it instead of being scrolled off screen.
trackViewport({
  onKeyboard: (open) => terminals.setKeyboardOpen(open),
  onResize: () => terminals.fitVisible(),
});

// Focusing the command box must always leave the cursor line visible.
cmdInput.addEventListener("focus", () => {
  setTimeout(() => terminals.scrollVisibleToBottom(), 350);
});
setInterval(() => {
  if (state.activeId) refreshGit();
}, 20000);
