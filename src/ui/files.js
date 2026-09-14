/**
 * File Explorer dialog: browse, up, new folder, rename, delete, download,
 * upload with progress. Every path is re-validated on the server.
 */
import { api, uploadFile } from "../lib/api.js";
import { toast, formatBytes } from "./shell.js";
import { t } from "../lib/i18n.js";

export class FileExplorer {
  constructor(el, { onOpenInTerminal }) {
    this.el = el;
    this.dlg = el("fileDlg");
    this.onOpenInTerminal = onOpenInTerminal;
    this.current = "";
    this.roots = [];

    el("fileUp").onclick = () => this.up();
    el("fileRefresh").onclick = () => this.open(this.current);
    el("fileNewDir").onclick = () => this.newFolder();
    el("fileUploadBtn").onclick = () => this.upload();
    el("fileRoots").onchange = (e) => this.open(e.target.value);
  }

  async open(path) {
    try {
      const data = await api.listFiles(path);
      this.current = data.path;
      this.roots = data.roots || [];
      this.parent = data.parent;
      this.render(data);
      if (!this.dlg.open) this.dlg.showModal();
    } catch (err) {
      toast(err.message, true);
      throw err;
    }
  }

  up() {
    if (this.parent) this.open(this.parent);
    else toast("Đã ở thư mục gốc được phép");
  }

  render(data) {
    const el = this.el;
    el("filePath").textContent = data.path;

    const rootSel = el("fileRoots");
    rootSel.replaceChildren();
    for (const r of data.roots) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      opt.selected = data.path.toLowerCase().startsWith(r.toLowerCase());
      rootSel.appendChild(opt);
    }

    const list = el("fileList");
    list.replaceChildren();
    if (!data.items.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = t("Thư mục trống.");
      list.appendChild(empty);
    }

    for (const item of data.items) {
      const row = document.createElement("div");
      row.className = "file-row";

      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = item.isDir ? "📁" : "📄";
      row.appendChild(icon);

      const name = document.createElement("button");
      name.className = "fname";
      name.textContent = item.name;
      name.title = item.path;
      name.onclick = () => (item.isDir ? this.open(item.path) : this.download(item));
      row.appendChild(name);

      const size = document.createElement("span");
      size.className = "fsize";
      size.textContent = item.isDir ? "" : formatBytes(item.size);
      row.appendChild(size);

      const actions = document.createElement("span");
      actions.className = "file-actions row";
      if (item.isDir) {
        actions.appendChild(this.button("⇥", t("Mở trong terminal"), () => {
          this.dlg.close();
          this.onOpenInTerminal(item.path);
        }));
      } else {
        actions.appendChild(this.button("⤓", t("Tải về"), () => this.download(item)));
      }
      actions.appendChild(this.button("✎", t("Đổi tên"), () => this.rename(item)));
      actions.appendChild(this.button("🗑", t("Xoá"), () => this.remove(item)));
      row.appendChild(actions);

      list.appendChild(row);
    }
  }

  button(label, title, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.onclick = onClick;
    return b;
  }

  download(item) {
    // A plain navigation so the browser's own download UI handles it.
    const a = document.createElement("a");
    a.href = api.downloadUrl(item.path);
    a.download = item.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async newFolder() {
    const name = prompt(t("Tên thư mục mới:"));
    if (!name) return;
    try {
      await api.mkdir(this.current, name);
      await this.open(this.current);
      toast("Đã tạo thư mục");
    } catch (err) {
      toast(err.message, true);
    }
  }

  async rename(item) {
    const name = prompt(t("Tên mới:"), item.name);
    if (!name || name === item.name) return;
    try {
      await api.renameFile(item.path, name);
      await this.open(this.current);
      toast("Đã đổi tên");
    } catch (err) {
      toast(err.message, true);
    }
  }

  async remove(item) {
    if (!confirm(t('Xoá "{name}"?', { name: item.name }) + (item.isDir ? t(" Toàn bộ nội dung bên trong sẽ mất.") : ""))) return;
    try {
      await api.deleteFile(item.path);
      await this.open(this.current);
      toast("Đã xoá");
    } catch (err) {
      toast(err.message, true);
    }
  }

  async upload() {
    const input = this.el("fileUpload");
    const file = input.files && input.files[0];
    if (!file) {
      toast("Chưa chọn file", true);
      return;
    }
    const bar = this.el("uploadBar");
    const fill = bar.firstElementChild;
    bar.classList.remove("hidden");
    fill.style.width = "0%";
    try {
      await uploadFile(this.current, file, (loaded, total) => {
        fill.style.width = `${Math.round((loaded / total) * 100)}%`;
      });
      toast(t("Đã upload {name} ({size})", { name: file.name, size: formatBytes(file.size) }));
      input.value = "";
      await this.open(this.current);
    } catch (err) {
      toast(err.message, true);
    } finally {
      setTimeout(() => bar.classList.add("hidden"), 600);
    }
  }
}
