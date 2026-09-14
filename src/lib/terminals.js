/**
 * xterm.js pane management.
 *
 * The PTY stream is written to xterm verbatim — no ANSI is stripped, rewritten
 * or "parsed" on the way in, so alternate-screen TUIs (Claude Code, vim, less)
 * behave exactly as they would in Windows Terminal.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { createDragTracker, glide } from "./gesture.js";
import { classifyRow } from "./privacy.js";

const THEME = {
  background: "#0b1220",
  foreground: "#e6edf7",
  cursor: "#60a5fa",
  cursorAccent: "#0b1220",
  selectionBackground: "#2c4d80",
  black: "#0b1220",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e5e7eb",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
};

export class TerminalManager {
  /**
   * @param {HTMLElement} container
   * @param {{onData:Function, onResize:Function, onRender:Function, isMobile:Function}} hooks
   */
  constructor(container, hooks) {
    this.container = container;
    this.hooks = hooks;
    this.panes = new Map(); // sessionId -> { term, fit, el, ready }
    this.primary = null;
    this.secondary = null;
    this.splitMode = "none"; // none | horizontal | vertical
    /**
     * While the mobile keyboard covers the screen we must NOT re-fit: shrinking
     * the PTY to a handful of rows reflows whatever is running (a Claude Code
     * menu, vim, less) and it never recovers cleanly when the keyboard closes.
     * Instead the pane clips and alignCursor() slides the terminal so the
     * cursor line lands just above the command box.
     */
    this.keyboardOpen = false;

    /**
     * Rows the PTY is told it has, regardless of how many fit in the pane.
     * 0 = fit exactly (the classic behaviour).
     *
     * This exists because of how Claude Code draws: it repaints its whole
     * answer in place while the answer fits on screen, and reprints it -
     * pushing broken copies into the scrollback - the moment it does not.
     * Measured on one real "tt": a 36-row window repeated a line up to 49
     * times, 70 rows repeated nothing. A 10000-row screen is not the answer
     * (Ink anchors its input box to the bottom row, so it would sit 10000 rows
     * down), but 100-200 rows is: tall enough for any normal answer, near
     * enough for the prompt to stay one small scroll away. The pane clips to
     * the slice around the cursor, exactly as the mobile keyboard mode already
     * does, and the wheel walks up through the live screen into the scrollback.
     */
    this.virtualRows = 0;

    /** Blur what programs print, keep what the user typed; see privacy.js. */
    this.privacy = false;

    this.observer = new ResizeObserver(() => this.fitVisible());
    this.observer.observe(container);
    window.addEventListener("orientationchange", () => setTimeout(() => this.fitVisible(), 250));
  }

  has(id) {
    return this.panes.has(id);
  }

  setPrivacy(on) {
    this.privacy = !!on;
    for (const [, pane] of this.panes) this.renderVeil(pane);
  }

  /** At most once a frame per pane: xterm renders far more often than that. */
  renderVeilSoon(pane) {
    if (!pane || pane.veilFrame || (!this.privacy && !pane.veil)) return;
    pane.veilFrame = requestAnimationFrame(() => {
      pane.veilFrame = 0;
      this.renderVeil(pane);
    });
  }

  /**
   * Cover the output rows of the visible screen with blurred patches.
   *
   * The canvas renderer leaves no per-row DOM to blur, so the patches sit on top
   * of it inside .xterm-screen, and backdrop-filter blurs whatever is under
   * them. Being inside the screen element they also ride along with the
   * virtual-rows slice transform.
   */
  renderVeil(pane) {
    if (!pane) return;
    if (!this.privacy) {
      if (pane.veil) pane.veil.hidden = true;
      return;
    }
    const term = pane.term;
    const screen = term.element && term.element.querySelector(".xterm-screen");
    if (!screen || !term.cols || !term.rows) return;
    if (!pane.veil || pane.veil.parentNode !== screen) {
      pane.veil = document.createElement("div");
      pane.veil.className = "privacy-veil";
      screen.appendChild(pane.veil);
    }
    pane.veil.hidden = false;
    const cellW = screen.clientWidth / term.cols;
    const cellH = screen.clientHeight / term.rows;
    const buf = term.buffer.active;
    const patches = document.createDocumentFragment();
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) continue;
      // Text plus the column each character starts at, so a wide character
      // (emoji, CJK) does not shift every patch after it.
      let text = "";
      const colAt = [];
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const ch = cell.getChars() || " ";
        for (let k = 0; k < ch.length; k++) colAt.push(x);
        text += ch;
      }
      colAt.push(term.cols);
      for (const [a, b] of classifyRow(text)) {
        const from = colAt[a] ?? term.cols;
        const to = colAt[b] ?? term.cols;
        if (to <= from) continue;
        const patch = document.createElement("div");
        patch.style.cssText = `left:${from * cellW}px;top:${y * cellH}px;width:${(to - from) * cellW}px;height:${cellH}px`;
        patches.appendChild(patch);
      }
    }
    pane.veil.replaceChildren(patches);
  }

  /**
   * Set the terminal font size, in CSS pixels, for every pane.
   *
   * Smaller type is more rows, and rows are what keep a long answer from being
   * reprinted instead of redrawn. Kept separate from browser zoom so the rest
   * of the interface stays the size it was.
   */
  setFontSize(px) {
    const size = Math.max(8, Math.min(24, Math.round(Number(px) || 14)));
    this.fontSize = size;
    for (const [, pane] of this.panes) {
      try {
        pane.term.options.fontSize = size;
      } catch {}
    }
    this.fitVisible();
    return size;
  }

  /**
   * Set the virtual row count. 0 turns the mode off; anything else is held to
   * 20-200 - 200 being the PTY host's own ceiling, and about three times the
   * measured point where Claude Code stops reprinting.
   */
  setVirtualRows(n) {
    let rows = Math.round(Number(n) || 0);
    rows = rows > 0 ? Math.max(20, Math.min(200, rows)) : 0;
    this.virtualRows = rows;
    for (const [, pane] of this.panes) pane.pinned = true;
    this.fitVisible();
    return rows;
  }

  get(id) {
    return this.panes.get(id);
  }

  ensure(sessionId, meta = {}) {
    const existing = this.panes.get(sessionId);
    if (existing) return existing;

    // The new pane is mounted as the only visible one on purpose:
    //  - xterm measures the character cell during open(), and on a
    //    display:none element that measurement yields 0, which leaves the
    //    terminal stuck at its 80x24 default however big the window is;
    //  - #panes is a one-row grid, so a second visible pane would land in an
    //    implicit auto-sized row and be measured as its own content height.
    // layout() puts the real visibility back in the same tick, before any paint.
    const previouslyVisible = [];
    for (const [, other] of this.panes) {
      if (other.el.classList.contains("visible")) {
        previouslyVisible.push(other.el);
        other.el.classList.remove("visible");
      }
    }

    const el = document.createElement("div");
    el.className = "pane visible";
    el.dataset.sessionId = sessionId;
    this.container.appendChild(el);

    const mobile = this.hooks.isMobile();
    const term = new Terminal({
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: false,
      scrollback: 20000,
      // 12 was legible on a desk and not on a phone in a hand. Adjustable
      // because the height of the terminal decides whether a Claude Code answer
      // taller than the screen can be redrawn in place or has to be reprinted:
      // measured on one "tt", a 36-row window repeated a line up to 49 times
      // and a 70-row window not at all. Rows are bought with font size.
      fontSize: this.fontSize || 14,
      lineHeight: 1.1,
      fontFamily: '"Cascadia Mono","Consolas","Courier New",monospace',
      theme: THEME,
      macOptionIsMeta: true,
      windowsMode: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // Without a renderer addon xterm rebuilds the rows as DOM on every scroll
    // step, which is what a phone feels as stutter. Canvas draws the same rows
    // in one pass. It is loaded after open() because it needs the element, and
    // guarded because a browser can refuse a 2D context.
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      // The DOM renderer stays: slower, but it always works.
    }
    try {
      // Now that the cell size is known, take the size this pane will keep -
      // virtual rows included. This is the size the attach claims, so it must
      // be the final one: see targetSize.
      const size = this.targetSize(fit);
      if (size) term.resize(size.cols, size.rows);
    } catch {}
    for (const other of previouslyVisible) other.classList.add("visible");

    // Ctrl+C and Ctrl+V mean what they mean on the rest of the web. Ctrl+C
    // with a selection copies it (and clears it, as Windows Terminal does);
    // with nothing selected it stays the interrupt, because copying nothing
    // helps nobody and the shell still needs stopping. Ctrl+V pastes through
    // term.paste(), which honours bracketed paste - so a multi-line paste
    // into Claude Code arrives as one block instead of running line by line.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return true;
      const key = ev.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (key === "v") {
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    term.onData((data) => this.hooks.onData(sessionId, data));
    term.onBinary((data) => this.hooks.onData(sessionId, data));
    term.onResize(({ cols, rows }) => {
      const p = this.panes.get(sessionId);
      if (p && p.replaying) return; // replay geometry is ours, not the PTY's
      this.hooks.onResize(sessionId, cols, rows);
    });
    // Every repaint, scroll and resize ends in a render; the veil follows it.
    term.onRender(() => this.renderVeilSoon(this.panes.get(sessionId)));
    term.onWriteParsed(() => {
      const p = this.panes.get(sessionId);
      if (this.keyboardOpen) this.alignCursor(p);
      // In virtual-rows mode the pane shows a slice of a taller screen, and
      // the slice follows the cursor - but only while the user has not
      // scrolled away. Claude Code redraws every second; snapping back on
      // each of those redraws would make reading-while-it-works impossible.
      else if (this.virtualRows > 0 && p && p.pinned !== false) this.alignCursor(p);
      this.updateScrollIndicatorSoon(p);
      this.hooks.onRender(sessionId);
    });

    // On a phone the keyboard belongs to the command box - by default. Tapping
    // the terminal is how you read and select; a keyboard that springs up on
    // that tap covers the very text you tapped to see. xterm keeps a hidden
    // textarea to catch keystrokes, and that textarea is what iOS focuses on
    // a tap, so it is what has to stop being focusable.
    //
    // But not to the exclusion of typing there at all. Claude Code has its own
    // prompt with its own cursor, and answering it through the command box
    // means an extra hop for every keystroke. So a tap on the cursor's own
    // line - or a double tap anywhere - is read as "type HERE": the hidden
    // textarea becomes focusable, the keyboard opens, and the keys go straight
    // to the PTY. Tapping away or closing the keyboard hands it back.
    if (mobile) {
      const helper = el.querySelector("textarea.xterm-helper-textarea");
      const direct = { on: false };
      const setDirect = (on) => {
        if (!helper || direct.on === on) return;
        direct.on = on;
        helper.readOnly = !on; // iOS opens no keyboard for a read-only field
        helper.tabIndex = on ? 0 : -1;
        helper.setAttribute("inputmode", on ? "text" : "none");
        helper.setAttribute("aria-hidden", on ? "false" : "true");
        if (on) helper.focus({ preventScroll: true });
      };
      if (helper) {
        helper.readOnly = true;
        helper.tabIndex = -1;
        helper.setAttribute("inputmode", "none");
        helper.setAttribute("aria-hidden", "true");
        helper.addEventListener("blur", () => setDirect(false));
      }
      el.addEventListener(
        "touchstart",
        () => {
          // Safari can hand focus over before the attributes above are read.
          if (!direct.on && helper && document.activeElement === helper) helper.blur();
        },
        { passive: true }
      );
      let lastTap = 0;
      el.addEventListener("touchend", (ev) => {
        // A drag never gets here: bindTouchScroll stops its propagation.
        if (!helper || ev.changedTouches.length !== 1) return;
        const doubleTap = ev.timeStamp - lastTap < 350;
        lastTap = ev.timeStamp;
        let onCursorLine = false;
        const screen = el.querySelector(".xterm-screen");
        if (screen) {
          const rect = screen.getBoundingClientRect();
          const cell = rect.height / Math.max(1, term.rows);
          const row = Math.floor((ev.changedTouches[0].clientY - rect.top) / cell);
          onCursorLine = Math.abs(row - term.buffer.active.cursorY) <= 1;
        }
        if (doubleTap || onCursorLine) setDirect(true);
      });

      this.bindTouchScroll(el);
    }
    this.bindWheelScroll(term, el);

    const ind = document.createElement("div");
    ind.className = "scroll-ind";
    const thumb = document.createElement("div");
    thumb.className = "scroll-thumb";
    ind.appendChild(thumb);
    el.appendChild(ind);

    const pane = { term, fit, el, meta, sessionId, pinned: true, viewOffset: null, ind, thumb, indFrame: 0 };
    this.panes.set(sessionId, pane);
    this.layout();
    return pane;
  }

  /**
   * The wheel scrolls the scrollback, even while a program owns the mouse.
   *
   * The same rule the drag already follows, and for the same reason: xterm
   * hands the wheel to the program whenever mouse reporting is on, and Claude
   * Code turns it on. So on a desktop the wheel did nothing inside exactly the
   * sessions this app exists for - the drag fallback was only ever bound for
   * touch, so a mouse had no way out at all.
   *
   * Taken over unconditionally rather than only when a program is listening.
   * With no program listening the result is identical to xterm's own handling,
   * and one rule that always holds beats two that depend on what is running.
   * Ctrl+wheel is left alone: that is the browser's zoom.
   *
   * Bound in the capture phase on the pane, not through
   * attachCustomWheelEventHandler, because that API is not consulted in the
   * case that needs it. xterm only asks the custom handler when it has *not*
   * installed its own mouse-reporting wheel listener:
   *
   *     wheel: e => { if (!s.wheel) { if (this._customWheelEventHandler ...
   *
   * and s.wheel is exactly what a program enabling mouse reporting puts there.
   * So the official hook is silent in precisely the sessions this exists for -
   * the same trap the drag handler documented above.
   */
  bindWheelScroll(term, el) {
    const pixels = (ev, box) => {
      // A row's height is the viewport's height over the rows on screen.
      if (ev.deltaMode === 1) return ev.deltaY * (box.clientHeight / Math.max(1, term.rows));
      if (ev.deltaMode === 2) return ev.deltaY * box.clientHeight;
      return ev.deltaY; // already pixels
    };

    el.addEventListener(
      "wheel",
      (ev) => {
        if (ev.ctrlKey) return; // the browser zooming; never ours to take
        const box = el.querySelector(".xterm-viewport");
        if (!box) return;
        const delta = pixels(ev, box);
        if (!delta) return;

        // With virtual rows there are two things to scroll through, stacked:
        // the scrollback, and above-the-fold live screen that the pane clips.
        // One wheel walks both as if they were one page - up moves through the
        // live screen first and continues into the scrollback where it ends;
        // down comes back the same way. Without virtual rows the slice is
        // null, rest passes straight through, and this is the old handler.
        const pane = this.panes.get(el.dataset.sessionId);
        // Only claim the event once it has actually moved something. At the top
        // or the bottom of the buffer the page should still scroll, and a
        // terminal that swallows the wheel while showing nothing new is a
        // terminal that feels stuck.
        if (this.scrollContent(pane, box, delta)) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
      { capture: true, passive: false }
    );
  }

  /**
   * Walk one scroll gesture through both regions - the clipped live screen
   * and the scrollback above it - as if they were one page. Up reads through
   * the live screen first and continues into the scrollback where it ends;
   * down comes back the same way. Shared by the wheel and the touch drag,
   * which had each grown their own half of this.
   */
  scrollContent(pane, box, delta) {
    if (!box || !delta) return false;
    let rest = delta;
    let moved = false;

    const slideView = () => {
      const m = this.sliceMetrics(pane);
      if (!m) return;
      const current = pane.viewOffset === null || pane.viewOffset === undefined ? m.max : pane.viewOffset;
      const next = Math.max(0, Math.min(m.max, current + rest));
      if (next !== current) {
        this.applyOffset(pane, next);
        rest -= next - current;
        moved = true;
      }
    };
    const slideScrollback = () => {
      const before = box.scrollTop;
      box.scrollTop = before + rest;
      const used = box.scrollTop - before;
      if (used) {
        rest -= used;
        moved = true;
      }
    };

    if (delta < 0) {
      slideView();
      slideScrollback();
    } else {
      slideScrollback();
      slideView();
    }

    // Pinned means "follow the cursor as new output arrives". Scrolling up
    // is how you unpin; scrolling back down to the cursor pins you again.
    if (pane && this.virtualRows > 0) {
      const m = this.sliceMetrics(pane);
      pane.pinned = !m || (pane.viewOffset === null ? true : pane.viewOffset >= this.cursorOffset(pane) - 1);
    }
    this.updateScrollIndicatorSoon(pane);
    return moved;
  }

  /**
   * Drag to scroll the scrollback, even while a program owns the mouse.
   *
   * xterm scrolls on touch only when the program has not enabled mouse
   * reporting: "if (!coreMouseService.areMouseEventsActive)". Claude Code, vim
   * and less all enable it, so inside exactly the sessions this app exists for,
   * a drag went to the program as a mouse event and the screen never moved.
   *
   * So the gesture is split here, in the capture phase, before xterm sees it:
   * a tap is still the program's - that is how a menu item gets clicked - but a
   * vertical drag is scrolling and belongs to the scrollback. Once a drag is
   * recognised the release is withheld too, so a program watching the mouse
   * never sees a press-and-release it could mistake for a click.
   */
  bindTouchScroll(el) {
    const gesture = createDragTracker();
    const viewport = () => el.querySelector(".xterm-viewport");

    // Every touchmove writing scrollTop makes the browser lay out again inside
    // the gesture; collecting them and writing once per frame is what turns a
    // stuttering drag into a smooth one.
    let pending = 0;
    let frame = 0;
    let scheduled = false;
    let stopGlide = null;

    /** @returns {boolean} whether the view actually moved */
    const scrollBy = (delta) => {
      const box = viewport();
      if (!box) return false;
      // Through the same two-region walk as the wheel: without it a drag only
      // moved the scrollback, and the clipped part of the live screen - where
      // Claude's answer actually is - was unreachable by touch.
      return this.scrollContent(this.panes.get(el.dataset.sessionId), box, delta);
    };

    const flush = () => {
      frame = 0;
      scheduled = false;
      const delta = pending;
      pending = 0;
      if (delta) scrollBy(delta);
    };

    const queue = (delta) => {
      pending += delta;
      // Guarded by its own flag rather than by the handle: the handle is only
      // assigned after the callback may already have run.
      if (scheduled) return;
      scheduled = true;
      frame = requestAnimationFrame(flush);
    };

    const stopMotion = () => {
      if (stopGlide) stopGlide();
      stopGlide = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      scheduled = false;
      pending = 0;
    };

    el.addEventListener(
      "touchstart",
      (e) => {
        stopMotion(); // a finger on the glass stops a glide, as it should
        if (e.touches.length !== 1) {
          gesture.end();
          return;
        }
        gesture.start(e.touches[0].clientY, e.timeStamp);
      },
      { capture: true, passive: true }
    );

    el.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length !== 1) return;
        const { dragging, delta } = gesture.move(e.touches[0].clientY, e.timeStamp);
        if (!dragging) return;

        // Past this point the gesture is ours: keep it away from xterm, which
        // would otherwise forward it to the program as mouse movement.
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        queue(delta);
      },
      { capture: true, passive: false }
    );

    const finish = (e) => {
      const velocity = gesture.velocity;
      if (!gesture.end()) return;
      e.stopPropagation(); // no stray click at the end of a scroll
      flush();
      stopGlide = glide({ velocity, onScroll: scrollBy });
    };
    el.addEventListener("touchend", finish, { capture: true, passive: true });
    el.addEventListener("touchcancel", finish, { capture: true, passive: true });
  }

  write(sessionId, data) {
    const pane = this.panes.get(sessionId);
    if (pane) pane.term.write(data);
  }

  /**
   * Replace the whole screen with the server-side scrollback (reconnect).
   *
   * The scrollback is a byte stream, not text: a recording of a terminal that
   * was a particular number of columns wide. Replay it wider than it was
   * recorded and nothing wraps, so nothing is ever pushed off the top, and the
   * history this replay exists to restore arrives with no scrollback at all -
   * one screen, and no way to scroll back to the beginning. So replay at the
   * width it was written for, then fit to the pane, which reflows it and tells
   * the PTY the size this browser actually has.
   */
  replaceHistory(sessionId, data, replay) {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    // One replay at a time, and the next one only after the last has finished
    // parsing. reset() clears the screen the moment it is called, but write()
    // only queues; two replays arriving together therefore ran as clear, queue,
    // clear, queue - and the bytes landed back to back with no clear between
    // them, which put the whole session on screen twice. That is what the
    // duplicated scrollback was. Two attaches for one session is normal - the
    // page attaches, then the host reconnects and everything re-attaches - so
    // the replay has to survive it rather than the attaches being rationed.
    pane.replayQueue = (pane.replayQueue || Promise.resolve()).then(
      () => new Promise((resolve) => this.runReplay(pane, sessionId, data, replay, resolve))
    );
  }

  /** One replay, start to finish. Only ever called from the queue above. */
  runReplay(pane, sessionId, data, replay, resolve) {
    // A pane replayed while hidden cannot be fitted - a display:none element
    // measures zero - so it keeps the replay geometry until it is first shown.
    // This flag is that debt: the first fitVisible that actually sees the pane
    // reflows it to THIS device's width and drops it at the bottom, so every
    // tab a refresh brought back opens current, not as the previous device
    // left it.
    pane.needsBottom = true;
    pane.term.reset();
    const done = () => {
      // Back to the pane's real size. xterm reflows the buffer it just built,
      // and this is the resize the PTY should hear about. A hidden pane is
      // fitted through the sole-visible dodge right now rather than lazily at
      // first view: a refresh should hand back every tab already reshaped for
      // this device and resting at its bottom, not just the one on top.
      if (pane.el.classList.contains("visible")) this.fitVisible();
      else this.fitHidden(pane);
      // Stated, not inferred from a change. xterm only raises onResize when the
      // number it computes differs from the one it already holds, so a pane
      // that fitted correctly before it was attached stays silent - and the PTY
      // goes on drawing for whatever size it was last told, which may be a
      // different browser's window. Every disagreement about the size shows up
      // as repainted, duplicated scrollback, so the size is repeated here every
      // time rather than left to chance.
      this.hooks.onResize(sessionId, pane.term.cols, pane.term.rows);
      pane.term.scrollToBottom();
      pane.pinned = true;
      this.alignCursor(pane); // a fresh replay starts at the cursor, not mid-scroll
      resolve(); // last, so the next replay cannot reset a half-fitted screen
    };
    if (!data) return done();

    const cols = Number(replay && replay.cols);
    const rows = Number(replay && replay.rows);
    if (cols > 0 && rows > 0 && (cols !== pane.term.cols || rows !== pane.term.rows)) {
      // Resizing to replay is our own business; the PTY must not be told to
      // follow us back to a size the user has already grown out of.
      pane.replaying = true;
      try {
        pane.term.resize(cols, rows);
      } catch {}
      pane.replaying = false;
    }
    // write() parses asynchronously. Fitting before it finishes would reflow a
    // half-built buffer, which is how the scrollback got lost in the first place.
    pane.term.write(data, done);
  }


  reset(sessionId) {
    const pane = this.panes.get(sessionId);
    if (pane) pane.term.reset();
  }

  remove(sessionId) {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    try {
      pane.term.dispose();
    } catch {}
    pane.el.remove();
    this.panes.delete(sessionId);
    if (this.primary === sessionId) this.primary = null;
    if (this.secondary === sessionId) this.secondary = null;
    this.layout();
  }

  setPrimary(sessionId) {
    if (!this.panes.has(sessionId)) return;
    if (this.secondary === sessionId) this.secondary = this.primary;
    this.primary = sessionId;
    this.layout();
  }

  setSecondary(sessionId) {
    this.secondary = this.panes.has(sessionId) ? sessionId : null;
    this.layout();
  }

  setSplit(mode) {
    this.splitMode = mode;
    if (mode === "none") this.secondary = null;
    this.layout();
  }

  layout() {
    const split = this.splitMode !== "none" && this.secondary && this.panes.has(this.secondary);
    this.container.classList.toggle("split-h", split && this.splitMode === "horizontal");
    this.container.classList.toggle("split-v", split && this.splitMode === "vertical");
    for (const [id, pane] of this.panes) {
      const visible = id === this.primary || (split && id === this.secondary);
      pane.el.classList.toggle("visible", visible);
      pane.el.classList.toggle("focused", id === this.primary);
    }
    setTimeout(() => this.fitVisible(), 0);
  }

  /**
   * The size a pane should be: the columns that fit, and in virtual-rows mode
   * the configured rows - but never fewer than actually fit, or a huge window
   * would get *less* screen.
   *
   * One rule for every place a pane is sized. A new pane used to take its
   * real height (77 rows) and be corrected to the virtual 100 a moment later,
   * so every page load claimed two sizes within a second. Claude Code redraws
   * its whole ~97-line frame onto the smaller one, and the part that does not
   * fit scrolls away as a copy: the recorded stream of one session, replayed
   * at 100 rows, holds the conversation once; with that one second at 77
   * rows, four times - the stacked banners and "tt" answers seen on 14/09.
   */
  targetSize(fit) {
    const dims = fit.proposeDimensions();
    if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return null;
    const want = this.virtualRows;
    return { cols: dims.cols, rows: want > 0 ? Math.max(want, dims.rows) : dims.rows };
  }

  /** Fit one measurable pane to this device, and settle any replay debt. */
  fitPane(pane) {
    if (!pane.el.clientHeight || !pane.el.clientWidth) return;
    if (this.virtualRows > 0) {
      try {
        const size = this.targetSize(pane.fit);
        if (size && (pane.term.cols !== size.cols || pane.term.rows !== size.rows)) {
          pane.term.resize(size.cols, size.rows);
        }
      } catch {}
      // Keep the reader's place through a resize; only a pinned pane snaps
      // back to the cursor.
      if (pane.pinned !== false) this.alignCursor(pane);
      else this.applyOffset(pane, pane.viewOffset === null ? 0 : pane.viewOffset);
    } else {
      if (pane.term.element) pane.term.element.style.transform = "";
      pane.viewOffset = null;
      try {
        pane.fit.fit();
      } catch {}
    }
    if (pane.needsBottom) {
      pane.needsBottom = false;
      pane.pinned = true;
      try {
        pane.term.scrollToBottom();
      } catch {}
      this.alignCursor(pane);
    }
    this.syncViewport(pane);
    this.updateScrollIndicator(pane);
  }

  /**
   * Make the DOM viewport agree with xterm about where it is scrolled.
   *
   * The browser zeroes the scrollTop of anything that goes display:none, and
   * every hidden tab does. On re-show xterm still *renders* the rows it holds
   * internally - the bottom - so the tab looks right, but the first wheel tick
   * writes scrollTop from the zero the browser left behind and the view leaps
   * to the top. The internal position is the truth; the DOM is put back to it.
   */
  syncViewport(pane) {
    const vp = pane.el.querySelector(".xterm-viewport");
    if (!vp) return;
    const buf = pane.term.buffer.active;
    if (!buf || !buf.length) return;
    const cell = vp.scrollHeight / buf.length;
    const want = Math.round(buf.viewportY * cell);
    if (Math.abs(vp.scrollTop - want) > 1) vp.scrollTop = want;
  }

  /**
   * The scrollbar for a scroll that spans two regions - the scrollback and,
   * in virtual-rows mode, the clipped live screen below it - which no native
   * scrollbar can show. One thumb over their sum, so "where am I" has an
   * answer at a glance.
   */
  updateScrollIndicator(pane) {
    if (!pane || !pane.ind) return;
    const vp = pane.el.querySelector(".xterm-viewport");
    if (!vp || !pane.el.clientHeight) return;
    const visible = pane.el.clientHeight;
    const m = this.sliceMetrics(pane);
    const sliceMax = m ? m.max : 0;
    const sbMax = Math.max(0, vp.scrollHeight - vp.clientHeight);
    const span = sbMax + sliceMax;
    if (span < 4) {
      pane.ind.style.display = "none";
      return;
    }
    pane.ind.style.display = "";
    const offset = m ? (pane.viewOffset === null ? sliceMax : pane.viewOffset) : 0;
    const value = Math.max(0, Math.min(span, vp.scrollTop + offset));
    const track = pane.ind.clientHeight || 1;
    const thumb = Math.max(24, (visible / (span + visible)) * track);
    const top = (value / span) * (track - thumb);
    pane.thumb.style.height = `${Math.round(thumb)}px`;
    pane.thumb.style.transform = `translateY(${Math.round(top)}px)`;
  }

  /** Indicator refresh, at most once a frame per pane. */
  updateScrollIndicatorSoon(pane) {
    if (!pane || pane.indFrame) return;
    pane.indFrame = requestAnimationFrame(() => {
      pane.indFrame = 0;
      this.updateScrollIndicator(pane);
    });
  }

  fitVisible() {
    if (this.keyboardOpen) {
      // Keep the PTY geometry, just make sure the cursor line stays in view.
      this.scrollVisibleToBottom();
      return;
    }
    for (const [, pane] of this.panes) {
      if (!pane.el.classList.contains("visible")) continue;
      this.fitPane(pane);
    }
  }

  /**
   * Fit a pane that is currently hidden.
   *
   * A display:none element measures zero, so a hidden pane cannot be fitted
   * where it stands - which is why, before this, every tab except the focused
   * one came back from a refresh still shaped for the previous device until
   * something happened to show it. The same dodge ensure() documents applies:
   * make this pane the sole visible one, measure and fit it, and put the real
   * visibility back within the same tick, before anything is painted.
   */
  fitHidden(pane) {
    if (pane.el.classList.contains("visible")) return this.fitPane(pane);
    const shown = [];
    for (const [, other] of this.panes) {
      if (other.el.classList.contains("visible")) {
        shown.push(other.el);
        other.el.classList.remove("visible");
      }
    }
    pane.el.classList.add("visible");
    try {
      this.fitPane(pane);
    } finally {
      pane.el.classList.remove("visible");
      for (const el of shown) el.classList.add("visible");
    }
  }

  scrollVisibleToBottom() {
    for (const [, pane] of this.panes) {
      if (!pane.el.classList.contains("visible")) continue;
      try {
        pane.term.scrollToBottom();
      } catch {}
      this.alignCursor(pane);
    }
  }

  /**
   * Slide the terminal up so the cursor line sits at the bottom of whatever
   * space is left, i.e. right above the command box.
   *
   * Anchoring the element's bottom instead would be wrong: a terminal that is
   * 50 rows tall with a prompt on row 2 would show 48 blank rows and hide the
   * cursor off the top.
   */
  /**
   * The slice: how much taller the terminal is than the pane showing it.
   * Null when everything fits - which is also what makes every slice helper
   * a safe no-op in classic fit mode.
   */
  sliceMetrics(pane) {
    const node = pane && pane.term.element;
    if (!node) return null;
    const visible = pane.el.clientHeight;
    const full = node.offsetHeight;
    if (!visible || !full || full <= visible) return null;
    return { node, visible, full, max: full - visible };
  }

  /** Slide the pane's view to `offset` pixels from the top of the screen. */
  applyOffset(pane, offset) {
    const m = this.sliceMetrics(pane);
    if (!m) {
      if (pane && pane.term.element) pane.term.element.style.transform = "";
      if (pane) pane.viewOffset = null;
      return 0;
    }
    const clamped = Math.max(0, Math.min(Math.round(offset), m.max));
    pane.viewOffset = clamped;
    m.node.style.transform = clamped ? `translateY(${-clamped}px)` : "";
    return clamped;
  }

  /**
   * The offset that keeps the cursor's line in view near the bottom edge.
   *
   * Not *at* the edge: Claude Code draws below its cursor - the input box
   * border, the "auto mode" line, the hints - and putting the cursor flush
   * against the bottom clipped exactly those. Three rows of room covers what
   * these TUIs actually draw down there, and in a plain shell the clamp to
   * m.max makes the padding invisible.
   */
  cursorOffset(pane) {
    const m = this.sliceMetrics(pane);
    if (!m) return 0;
    const rows = pane.term.rows || 1;
    const cellHeight = m.full / rows;
    const cursorRow = Math.min(rows, pane.term.buffer.active.cursorY + 1 + 3);
    return Math.max(0, Math.min(cursorRow * cellHeight - m.visible, m.max));
  }

  alignCursor(pane) {
    if (!pane) return;
    this.applyOffset(pane, this.cursorOffset(pane));
  }

  /** Called when the mobile keyboard opens or closes. */
  setKeyboardOpen(open) {
    if (this.keyboardOpen === open) return;
    this.keyboardOpen = open;
    if (open) {
      setTimeout(() => this.scrollVisibleToBottom(), 0);
    } else {
      // Give the browser a moment to restore the viewport before measuring.
      setTimeout(() => {
        this.fitVisible();
        this.scrollVisibleToBottom();
      }, 60);
    }
  }

  focus(sessionId) {
    const pane = this.panes.get(sessionId);
    if (pane && !this.hooks.isMobile()) pane.term.focus();
  }

  dims(sessionId) {
    const pane = this.panes.get(sessionId);
    if (!pane) return { cols: 120, rows: 32 };
    return { cols: pane.term.cols, rows: pane.term.rows };
  }
}
