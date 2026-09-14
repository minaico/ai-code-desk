/**
 * Every terminal ever opened, per machine, with a one-tap reopen.
 *
 * Reopening asks the machine that owns the entry to start a fresh session with
 * the same shell and the directory the old one was in when it closed. If that
 * directory is gone, the server falls back to the default and says so.
 */
import { api } from "../lib/api.js";
import { machineMark, machineName } from "../lib/machines.js";
import { toast, formatUptime } from "./shell.js";
import { t } from "../lib/i18n.js";

export class HistoryPanel {
  constructor(el, { onReopen, hosts }) {
    this.el = el;
    this.dlg = el("historyDlg");
    this.onReopen = onReopen;
    // A function, not a list: the registry changes while this panel is closed.
    this.hosts = hosts || (() => []);
    this.entries = [];

    el("historyRefresh").onclick = () => this.load();
    el("historySearch").addEventListener("input", () => this.render());
  }

  async open() {
    if (!this.dlg.open) this.dlg.showModal();
    await this.load();
  }

  async load() {
    const list = this.el("historyList");
    list.textContent = t("Đang tải…");
    try {
      const { entries } = await api.history();
      this.entries = entries || [];
      this.render();
    } catch (err) {
      list.textContent = err.message;
    }
  }

  render() {
    const list = this.el("historyList");
    const q = this.el("historySearch").value.trim().toLowerCase();
    // Closed terminals only. A running one is already a tab and a card in the
    // session list; listing it here as well read as the same project twice
    // over. The row itself is not deleted when a terminal is reopened - it is
    // the folder's identity, the thing reopen takes over instead of adding a
    // second row beside it - it simply steps out of this list while it is
    // alive, and steps back in when it closes.
    const closed = this.entries.filter((e) => e.status !== "running");
    const shown = q
      ? closed.filter((e) => `${e.title} ${e.cwd} ${e.shell} ${e.hostName || ""}`.toLowerCase().includes(q))
      : closed;

    list.replaceChildren();
    if (!shown.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = closed.length ? t("Không có kết quả.") : t("Chưa có session nào đã đóng.");
      list.appendChild(p);
      return;
    }

    for (const entry of shown) {
      const row = document.createElement("div");
      row.className = "file-row history-row";

      const hosts = this.hosts();
      const where = machineName(entry.hostId, hosts, entry.hostName);
      const mark = machineMark(entry.hostId, hosts, entry.status, entry.hostName);

      const main = document.createElement("button");
      main.className = "fname history-main";
      const name = document.createElement("div");
      name.className = "ellipsis";
      name.textContent = entry.title;
      // Which machine, on the name line: two rows called "1TN" on two machines
      // are two different terminals, and the difference has to be visible
      // before you tap one.
      const on = document.createElement("small");
      on.className = "history-host";
      on.textContent = where;
      name.appendChild(on);
      const meta = document.createElement("div");
      meta.className = "meta";
      const when = entry.closedAt || entry.lastSeenAt || entry.createdAt;
      const ago = when ? formatUptime(Date.now() - Date.parse(when)) : "?";
      meta.textContent = t("{shell} · {ago} trước", { shell: entry.shell, ago });
      const cwd = document.createElement("div");
      cwd.className = "meta";
      cwd.textContent = entry.cwd;
      main.append(name, meta, cwd);
      main.title = t("Mở lại tại {cwd}", { cwd: entry.cwd });
      main.onclick = () => this.reopen(entry);

      const del = document.createElement("button");
      del.textContent = "🗑";
      del.title = t("Xoá khỏi lịch sử");
      del.onclick = async (e) => {
        e.stopPropagation();
        try {
          await api.deleteHistory(entry.id, entry.hostId);
          this.entries = this.entries.filter((x) => x.id !== entry.id);
          this.render();
        } catch (err) {
          toast(err.message, true);
        }
      };

      row.append(mark, main, del);
      list.appendChild(row);
    }
  }

  async reopen(entry) {
    try {
      const r = await api.reopenHistory(entry.id, entry.hostId);
      this.dlg.close();
      this.onReopen(r.session);
      if (r.restoredCwd === false) {
        toast(t("Thư mục cũ không còn: mở tại {cwd}", { cwd: r.session.cwd }), true);
      } else {
        toast(t("Mở lại {name} tại {cwd}", { name: r.session.title, cwd: r.session.cwd }));
      }
    } catch (err) {
      toast(err.message, true);
    }
  }
}
