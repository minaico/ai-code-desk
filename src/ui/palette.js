/**
 * Command palette (Ctrl+K on desktop, the ⌘ button on mobile).
 * Doubles as session search: sessions are listed as commands.
 */
import { t } from "../lib/i18n.js";

export class Palette {
  constructor(el, provider) {
    this.dlg = el("paletteDlg");
    this.input = el("paletteInput");
    this.list = el("paletteList");
    this.provider = provider;
    this.items = [];
    this.filtered = [];
    this.cursor = 0;

    this.input.addEventListener("input", () => this.filter());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.dlg.addEventListener("close", () => {
      this.input.value = "";
    });
    this.dlg.addEventListener("click", (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
  }

  open() {
    this.items = this.provider();
    this.cursor = 0;
    this.input.value = "";
    this.filter();
    if (!this.dlg.open) this.dlg.showModal();
    // A phone should not pop the keyboard before the list is readable.
    if (!matchMedia("(pointer: coarse)").matches) this.input.focus();
  }

  filter() {
    const q = this.input.value.trim().toLowerCase();
    this.filtered = !q
      ? this.items
      : this.items.filter((it) => `${it.label} ${it.hint || ""}`.toLowerCase().includes(q));
    this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
    this.render();
  }

  render() {
    this.list.replaceChildren();
    if (!this.filtered.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.style.padding = "10px";
      p.textContent = t("Không có kết quả.");
      this.list.appendChild(p);
      return;
    }
    this.filtered.forEach((item, i) => {
      const b = document.createElement("button");
      b.className = `palette-item${i === this.cursor ? " active" : ""}`;
      const label = document.createElement("span");
      label.textContent = item.label;
      const hint = document.createElement("span");
      hint.className = "hintkey";
      hint.textContent = item.hint || "";
      b.append(label, hint);
      b.onclick = () => this.run(item);
      this.list.appendChild(b);
    });
  }

  onKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.cursor = Math.min(this.cursor + 1, this.filtered.length - 1);
      this.render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.cursor = Math.max(this.cursor - 1, 0);
      this.render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = this.filtered[this.cursor];
      if (item) this.run(item);
    }
  }

  run(item) {
    this.dlg.close();
    try {
      item.run();
    } catch (err) {
      console.error(err);
    }
  }
}
