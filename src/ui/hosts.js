/**
 * The machines this web server can open terminals on - itself included, as
 * one entry among the others. "Main" only says which one is serving the page.
 *
 * A remote machine runs its own PTY host with PTY_HOST_BIND=0.0.0.0 and is
 * identified by the key from `node scripts/host-key.js` on that machine. The
 * link is authenticated but not encrypted, so it belongs on a LAN or a VPN.
 */
import { api } from "../lib/api.js";
import { machineMark } from "../lib/machines.js";
import { toast, formatUptime } from "./shell.js";
import { t, tr } from "../lib/i18n.js";

export class HostsPanel {
  constructor(el, { onChange }) {
    this.el = el;
    this.dlg = el("hostsDlg");
    this.onChange = onChange;
    this.hosts = [];

    el("hostProbe").onclick = () => this.probe();
    el("hostAdd").onclick = () => this.add();
  }

  async open() {
    if (!this.dlg.open) this.dlg.showModal();
    await this.load();
  }

  async load() {
    const list = this.el("hostsList");
    list.textContent = t("Đang tải…");
    try {
      const { hosts } = await api.hosts();
      this.hosts = hosts || [];
      this.render();
      if (this.onChange) this.onChange(this.hosts);
    } catch (err) {
      list.textContent = err.message;
    }
  }

  render() {
    const list = this.el("hostsList");
    list.replaceChildren();
    for (const host of this.hosts) {
      const row = document.createElement("div");
      row.className = "file-row";

      // The same shape the tabs and the history use, so a machine looks the
      // same everywhere it appears.
      const mark = machineMark(host.id, this.hosts, host.connected ? "running" : "exited", host.name);

      const main = document.createElement("div");
      main.className = "grow";
      const name = document.createElement("div");
      name.textContent = `${host.name}${host.local ? " · " + t("máy chính") : ""}`;
      if (host.local) name.title = t("Máy đang chạy trang web này. Các máy khác thấy nó ở địa chỉ bên dưới.");
      name.className = "ellipsis";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = host.connected
        ? `${host.address}:${host.port} · ${host.sessionCount} session · up ${formatUptime(Date.now() - host.hostStartedAt)}`
        : `${host.address}:${host.port} · offline${host.lastError ? ` — ${host.lastError}` : ""}`;
      main.append(name, meta);

      row.append(mark, main);

      const rename = document.createElement("button");
      rename.textContent = "✎";
      rename.title = t("Đổi tên máy");
      rename.onclick = async () => {
        const next = prompt(t("Tên máy:"), host.name);
        if (next === null || next.trim() === host.name) return;
        try {
          await api.renameHost(host.id, next);
          await this.load();
          toast("Đã đổi tên máy");
        } catch (err) {
          toast(err.message, true);
        }
      };
      row.append(rename);

      if (!host.local) {
        const del = document.createElement("button");
        del.textContent = "🗑";
        del.title = t("Bỏ máy này");
        del.onclick = async () => {
          if (!confirm(t('Bỏ máy "{name}"? Session trên đó vẫn chạy nhưng sẽ không điều khiển được từ đây.', { name: host.name }))) return;
          try {
            await api.removeHost(host.id);
            await this.load();
            toast("Đã bỏ máy");
          } catch (err) {
            toast(err.message, true);
          }
        };
        row.append(del);
      }
      list.appendChild(row);
    }
  }

  values() {
    return {
      name: this.el("hostName").value.trim(),
      address: this.el("hostAddress").value.trim(),
      port: Number(this.el("hostPort").value.trim()) || undefined,
      key: this.el("hostKey").value.trim(),
    };
  }

  message(text, bad = false) {
    const node = this.el("hostMsg");
    node.textContent = text;
    node.style.color = bad ? "#fca5a5" : "";
  }

  async probe() {
    const { address, port } = this.values();
    if (!address) return this.message(t("Nhập địa chỉ trước"), true);
    this.message(t("Đang kiểm tra…"));
    try {
      const r = await api.probeHost(address, port);
      if (r.reachable) this.message(t("Kết nối được tới {addr}", { addr: `${r.address}:${r.port}` }));
      else this.message(t("Không kết nối được {addr} — {error}", { addr: `${r.address}:${r.port}`, error: r.error }), true);
    } catch (err) {
      this.message(tr(err.message), true);
    }
  }

  async add() {
    const values = this.values();
    if (!values.address) return this.message(t("Nhập địa chỉ trước"), true);
    if (!values.key) return this.message(t("Cần key của máy đó (node scripts/host-key.js)"), true);
    this.message(t("Đang thêm…"));
    try {
      await api.addHost(values);
      this.el("hostKey").value = "";
      this.message("");
      await this.load();
      toast(t("Đã thêm {name}", { name: values.name || values.address }));
    } catch (err) {
      this.message(tr(err.message), true);
    }
  }
}
