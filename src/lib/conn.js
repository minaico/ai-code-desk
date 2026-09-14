/**
 * One multiplexed WebSocket for every terminal in the page.
 *
 * Auto-reconnects with backoff. On reconnect (or when the PTY host itself comes
 * back) it re-attaches every session the UI still has open, and the server
 * replays that session's scrollback, so a dropped phone connection restores the
 * terminal exactly where it was.
 */
export class Connection extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.attached = new Set();
    this.pendingSize = new Map();
    // The size each attached session was last shown at. A reconnect that does
    // not carry it makes the server fall back to what the *other* viewers want,
    // so the terminal is resized twice - once on reattach and once when this
    // pane fits itself again - and a TUI repainted at two wrong widths is the
    // garbled screen a refresh used to leave behind on everybody else.
    this.lastSize = new Map();
    this.retryMs = 500;
    this.closedByUs = false;
    this.state = "connecting";
    this.queue = [];
  }

  url() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.host}/terminal`;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state, detail) {
    this.state = state;
    this.emit("state", { state, ...detail });
  }

  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.closedByUs = false;
    this.setState("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = 500;
      this.setState("online");
      for (const m of this.queue.splice(0)) this.rawSend(m);
      // Re-attach whatever the UI still shows.
      this.reattachAll();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "hostState" && msg.rehydrate) {
        this.reattachAll();
      }
      this.emit("message", msg);
    };

    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      if (ev.code === 1008) this.emit("unauthorized", {});
      this.setState("offline", { code: ev.code });
      if (!this.closedByUs) this.scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  scheduleReconnect() {
    setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(8000, Math.round(this.retryMs * 1.6));
  }

  close() {
    this.closedByUs = true;
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  /**
   * Re-announce every attached session after the socket came back.
   *
   * Never a claim: a reload is a disconnect and a reconnect a fraction of a
   * second apart, and a socket reappearing is not a person asking for the
   * terminal to be reshaped. The size goes along only so the server can tell
   * whether this window is already the right shape.
   */
  reattachAll() {
    for (const id of this.attached) {
      const size = this.lastSize.get(id);
      this.rawSend({
        type: "attach",
        sessionId: id,
        cols: size && size.cols,
        rows: size && size.rows,
        claim: false,
      });
    }
  }

  rawSend(msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  send(msg) {
    if (!this.rawSend(msg) && this.queue.length < 200) this.queue.push(msg);
  }

  attach(sessionId, cols, rows, claim = true) {
    this.attached.add(sessionId);
    // A pane fits itself the moment it is created, which is before it can be
    // attached; carry that size in with the attach instead of dropping it.
    const pending = this.pendingSize.get(sessionId);
    this.pendingSize.delete(sessionId);
    // A pending size is always the newer measurement: the caller measured the
    // pane the instant it was created, the pending one came from a resize the
    // pane reported once the layout had settled. Preferring the caller's left
    // the PTY believing 147x36 while the browser drew 204x47, and a program
    // that repaints by row number cannot survive that - it addresses rows the
    // screen does not have, the screen scrolls to make them, and every repaint
    // lands one step lower than the last. That is the duplicated, half-missing
    // scrollback; a real terminal never shows it because it never disagrees
    // with the program about its own size.
    if (pending && pending.cols > 0 && pending.rows > 0) {
      cols = pending.cols;
      rows = pending.rows;
    }
    if (cols > 0 && rows > 0) this.lastSize.set(sessionId, { cols, rows });
    this.send({ type: "attach", sessionId, cols, rows, claim });
  }

  detach(sessionId) {
    this.attached.delete(sessionId);
    this.pendingSize.delete(sessionId);
    this.lastSize.delete(sessionId);
    this.send({ type: "detach", sessionId });
  }

  input(sessionId, data) {
    if (!data) return;
    this.send({ type: "input", sessionId, data });
  }

  resize(sessionId, cols, rows) {
    // A tab nobody is looking at has no say in the terminal's shape. A phone
    // tab left open in the background kept refitting to 49x33 and squeezing
    // the PTY out from under the desktop that was actually being read; the
    // screen belongs to whoever is looking at it, and this tab is not that.
    // When it becomes visible again, the visibilitychange handler restates.
    if (typeof document !== "undefined" && document.hidden) return;
    // The server rejects input/resize for sessions this socket has not
    // attached, so hold the size until the attach goes out.
    if (cols > 0 && rows > 0) this.lastSize.set(sessionId, { cols, rows });
    if (!this.attached.has(sessionId)) {
      this.pendingSize.set(sessionId, { cols, rows });
      return;
    }
    this.send({ type: "resize", sessionId, cols, rows });
  }
}
