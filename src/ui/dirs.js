/**
 * Folder picker used when starting a new terminal.
 *
 * Browses folder names anywhere on the machine except Windows system
 * directories. It cannot open, download or change any file — that is the file
 * manager's job and it stays inside WEB_TERMINAL_ROOTS.
 */
import { api } from "../lib/api.js";
import { toast } from "./shell.js";
import { t } from "../lib/i18n.js";

export class DirPicker {
  constructor(el, { onPick }) {
    this.el = el;
    this.dlg = el("dirDlg");
    this.onPick = onPick;
    this.current = "";

    el("dirUp").onclick = () => this.open(this.parent === "" ? "" : this.parent);
    el("dirDrives").onclick = () => this.open("");
    el("dirGo").onclick = () => this.open(el("dirManual").value.trim());
    el("dirManual").onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.open(el("dirManual").value.trim());
      }
    };
    el("dirPick").onclick = () => this.pick();
  }

  async open(path) {
    try {
      const data = await api.listDirs(path);
      this.current = data.path;
      this.parent = data.parent;
      this.render(data);
      if (!this.dlg.open) this.dlg.showModal();
    } catch (err) {
      toast(err.message, true);
    }
  }

  pick() {
    if (!this.current) {
      toast("Hãy mở một thư mục trước", true);
      return;
    }
    this.dlg.close();
    this.onPick(this.current);
  }

  render(data) {
    const el = this.el;
    el("dirPath").textContent = data.isDriveList ? t("Chọn ổ đĩa") : data.path;
    el("dirManual").value = data.path || "";
    el("dirPick").disabled = data.isDriveList;
    el("dirUp").disabled = data.isDriveList;

    const shortcuts = el("dirShortcuts");
    shortcuts.replaceChildren();
    for (const s of data.shortcuts || []) {
      const b = document.createElement("button");
      b.textContent = `★ ${s.name}`;
      b.title = s.path;
      b.onclick = () => this.open(s.path);
      shortcuts.appendChild(b);
    }

    const list = el("dirList");
    list.replaceChildren();
    if (!data.items.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = data.isDriveList ? t("Không thấy ổ đĩa nào.") : t("Không có thư mục con.");
      list.appendChild(p);
      return;
    }
    for (const item of data.items) {
      const row = document.createElement("div");
      row.className = "file-row";

      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = data.isDriveList ? "💾" : "📁";

      const name = document.createElement("button");
      name.className = "fname";
      name.textContent = item.name;
      name.title = item.path;
      name.onclick = () => this.open(item.path);

      const here = document.createElement("button");
      here.textContent = t("Chọn");
      here.title = t("Tạo terminal tại {path}", { path: item.path });
      here.onclick = () => {
        this.dlg.close();
        this.onPick(item.path);
      };

      row.append(icon, name, here);
      list.appendChild(row);
    }
  }
}
