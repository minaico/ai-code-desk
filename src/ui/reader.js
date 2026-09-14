/**
 * The reading view: a Claude Code session as a short list of steps.
 *
 * The terminal itself keeps running underneath and is one tap away; this is
 * only a way to read what happened without the repainting, the folded tool
 * output and the thinking getting in the way. It is an ordinary scrolling
 * element, so scrolling it is the browser's own - which on a phone is exactly
 * as smooth as scrolling anything else.
 */
import { parseTranscript, looksLikeClaude } from "../lib/transcript.js";
import { t } from "../lib/i18n.js";

const ICONS = {
  user: "❯",
  prose: "",
  tool: "◆",
  run: "$",
  runs: "$",
  thinking: "✻",
};

export class Reader {
  constructor(el) {
    this.root = el("reader");
    this.list = el("readerList");
    this.empty = el("readerEmpty");
    this.active = false;
    this.lastSignature = "";
  }

  get visible() {
    return this.active;
  }

  toggle(on) {
    this.active = on === undefined ? !this.active : !!on;
    this.root.classList.toggle("hidden", !this.active);
    document.body.classList.toggle("reader-open", this.active);
    this.lastSignature = "";
    return this.active;
  }

  /**
   * Steps read from Claude Code's own transcript.
   *
   * This is the good path: thinking, prose and tool calls arrive as separate
   * blocks, so nothing has to be guessed from what the screen happens to show.
   */
  renderSteps(steps) {
    this.draw(steps, t("Chưa có gì để hiển thị."));
  }

  /**
   * Steps guessed from the rendered terminal.
   *
   * Only for sessions with no transcript to read - a plain shell, or a machine
   * running an older PTY host.
   *
   * @param {string[]} lines rendered terminal rows
   */
  render(lines) {
    if (!this.active) return;
    this.draw(
      parseTranscript(lines),
      looksLikeClaude(lines)
        ? t("Chưa có gì để hiển thị.")
        : t("Phiên này không phải Claude Code — hãy xem ở chế độ terminal.")
    );
  }

  draw(steps, emptyText) {
    if (!this.active) return;

    // Re-rendering an identical list would fight the reader's scroll position.
    const signature = JSON.stringify(steps);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    const atBottom =
      this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;

    this.list.replaceChildren();
    if (!steps.length) {
      this.empty.textContent = emptyText;
      this.empty.classList.remove("hidden");
      return;
    }
    this.empty.classList.add("hidden");

    for (const step of steps) {
      this.list.appendChild(this.row(step));
    }
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  row(step) {
    const node = document.createElement("div");
    node.className = `step step-${step.kind}`;

    if (step.kind === "prose" || step.kind === "user") {
      const body = document.createElement("div");
      body.className = "step-text";
      body.textContent = step.text;
      if (step.kind === "user") {
        const mark = document.createElement("span");
        mark.className = "step-icon";
        mark.textContent = ICONS.user;
        node.append(mark, body);
      } else {
        node.append(body);
      }
      return node;
    }

    const icon = document.createElement("span");
    icon.className = "step-icon";
    icon.textContent = ICONS[step.kind] || "◆";

    const label = document.createElement("span");
    label.className = "step-label";
    if (step.kind === "runs") {
      label.textContent = t("Chạy {n} lệnh", { n: step.count });
      node.title = step.labels.join("\n");
    } else if (step.kind === "run") {
      label.textContent = t("Chạy {label}", { label: step.label === "lệnh" ? t("lệnh") : step.label });
    } else if (step.kind === "thinking") {
      label.textContent = step.lines ? t("Suy nghĩ ({n} dòng)", { n: step.lines }) : t("Suy nghĩ");
    } else {
      label.textContent = step.verb ? `${t(step.verb)} ${step.target || ""}`.trim() : step.label;
    }

    node.append(icon, label);

    if (step.detail) {
      const detail = document.createElement("span");
      detail.className = step.diff ? "step-detail is-diff" : "step-detail";
      detail.textContent = step.detail;
      node.append(detail);
    }
    return node;
  }
}
