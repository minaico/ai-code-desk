/**
 * Turn a Claude Code screen into the list of steps it actually represents.
 *
 * Claude Code is a TUI: it repaints the whole screen constantly, folds tool
 * output under the call that made it, and interleaves its thinking with its
 * answer. Read on a phone that is a wall of redrawn text. The web UI shows the
 * same session as a short list - "Read lib.ts", "Edited lib.ts +33 -0",
 * "Ran 3 commands" - with the prose in between, and that is what this rebuilds
 * from the rendered rows.
 *
 * No imports, so the parsing can be tested without a DOM or a terminal.
 */

/** The tools Claude Code announces, and the verb each one deserves. */
const TOOL_VERBS = {
  Read: "Đọc",
  Write: "Tạo",
  Edit: "Sửa",
  MultiEdit: "Sửa",
  Update: "Sửa",
  Create: "Tạo",
  NotebookEdit: "Sửa",
  Glob: "Tìm",
  Grep: "Tìm",
  Search: "Tìm",
  Task: "Giao việc",
  Agent: "Giao việc",
  WebFetch: "Tải",
  WebSearch: "Tra",
  TodoWrite: "Ghi việc",
};
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "Kill", "KillShell", "Shell"]);

const TOOL_CALL = /^([A-Z][\w.-]*)\((.*)\)\s*$/;
/* A long argument gets cut off by the screen edge, closing paren and all. */
const TOOL_CALL_CUT = /^([A-Z][\w.-]*)\(([^)]*)$/;
/* Claude Code collapses its own runs too; keep its count rather than re-deriving one. */
const RAN_MANY = /^(?:Ran|Chạy)\s+(\d+)\s+(?:shell\s+)?(?:commands?|lệnh)/i;
const THINKING = /^(thinking|đang suy nghĩ|suy nghĩ)\b/i;
/**
 * How long the thinking took: "Baked for 1m 26s", "Cogitated for 44s". The verb
 * changes with almost every release, so match the shape and not the word.
 */
const THOUGHT_FOR = /^\S+ for \d+\s*(m|s|ms|phút|giây)\b/i;
const USER_LINE = /^>\s?(.*)$/;
const RESULT_LINE = /^⎿\s?(.*)$/;
const DIFF_STAT = /(\d+)\s+additions?[^0-9]+(\d+)\s+removals?/i;
const BOX_ROW = /^[│┃┆┊┌┐└┘├┤┬┴┼─━┄┈╔╗╚╝║═╭╮╯╰]/;
const BOX_ONLY = /^[\s│┃┆┊┌┐└┘├┤┬┴┼─━┄┈╔╗╚╝║═╭╮╯╰]+$/;
const SHELL_PROMPT = /^(PS\s+)?[A-Za-z]:\\[^\n]*>\s*$/;

/** Spinners, hints and counters: chrome, never part of the transcript. */
const STATUS_ROW = [
  /\(esc to interrupt\)/i,
  /^\?\s+for shortcuts/i,
  /^⏵⏵/,
  /[↑↓]\s*[\d.,]+\s*k?\s*tokens/i,
  /^[✻✽✳✢·*]\s*\S+…/,
  /^\S+…\s*\(\d+s\b/,
  /^\d+\s*(lines?|dòng)\s+(hidden|ẩn)/i,
];

/**
 * Signs that this is Claude Code.
 *
 * The bullet and the result marker came from a version that no longer draws
 * them: a real v2.1 screen of a finished answer contains neither. The signs
 * that survive are the frame around the composer and the line that reports how
 * long the thinking took - and both of those sit *below* the cursor, which is
 * why the reader has to be given the whole buffer rather than everything up to
 * the cursor.
 */
const CLAUDE_SIGNS = [
  /^\s*[●⎿]/,
  /\(esc to interrupt\)/i,
  /^\s*⏵⏵/,
  /auto mode on/i,
  /Claude Code\s+v\d/,
  /^\s*[✻✽✳✢]\s*\S+ for \d+/i,
  /shift\+tab to cycle/i,
];

/** Does this screen belong to Claude Code at all? */
export function looksLikeClaude(lines) {
  return (lines || []).some((row) => CLAUDE_SIGNS.some((re) => re.test(String(row))));
}

const isStatus = (text) => STATUS_ROW.some((re) => re.test(text));

/** Strip the box drawing and bullets a reader would only stumble over. */
function plain(text) {
  return String(text)
    .replace(/[│┃┆┊┌┐└┘├┤┬┴┼─━┄┈╔╗╚╝║═╭╮╯╰]/g, " ")
    .replace(/^[\s✻✽✳✢·•●○◉❯›▶▸]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "scripts/lib.ts" from a path, "npm test" left as it is. */
function shorten(argument, max = 60) {
  const value = String(argument || "").trim().replace(/^["']|["']$/g, "");
  if (value.length <= max) return value;
  return "…" + value.slice(-(max - 1));
}

function toolStep(name, argument) {
  if (SHELL_TOOLS.has(name)) {
    return { kind: "run", name, label: shorten(argument) || "lệnh", detail: "" };
  }
  const verb = TOOL_VERBS[name] || name;
  // verb and target travel separately so the reader can translate the verb.
  return { kind: "tool", name, verb, target: shorten(argument), label: `${verb} ${shorten(argument)}`.trim(), detail: "" };
}

/**
 * @param {string[]} lines rendered terminal rows, oldest first
 * @returns {Array<{kind:string,label?:string,text?:string,detail?:string,count?:number}>}
 */
export function parseTranscript(lines) {
  const rows = (lines || []).map((l) => String(l).replace(/\s+$/, ""));
  const steps = [];
  let mode = "none";
  let current = null; // the step a ⎿ result would belong to

  /**
   * Claude Code repaints by moving the cursor to an absolute position and
   * writing over what is there - 1595 such moves in one measured session. What
   * reaches the scrollback is therefore not a transcript but the parts of
   * successive frames that happened to scroll past, and the same sentence
   * arrives three or four times, sometimes cut in half by the screen edge.
   *
   * So a line that has already been read is not read again. This is the whole
   * difference between a summary and the wall of repeats the terminal shows.
   */
  const seen = new Set();
  const pushProse = (text) => {
    if (!text) return;
    // Eight characters, not twenty-four: "2. Đã hoàn thành" and
    // "Gemini 3.1 (Vertex AI)." are both under twenty-four and both arrived
    // three times. Anything shorter than this is a bullet or a bare number,
    // where a repeat is more likely to be real than to be a repaint.
    const key = text.length > 8 ? text : null;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    const last = steps[steps.length - 1];
    if (last && last.kind === "prose") {
      if (last.text.endsWith(text)) return; // the same frame painted again
      // Newline, not space: a briefing is headings and bullet lists, and
      // running them into one paragraph is how a summary stops being readable.
      last.text += "\n" + text;
      return;
    }
    steps.push({ kind: "prose", text });
  };

  for (const raw of rows) {
    const text = plain(raw);
    if (!text) continue;
    if (BOX_ONLY.test(raw)) {
      mode = "none";
      current = null;
      continue;
    }
    if (BOX_ROW.test(raw)) {
      // The composer at the foot of the screen: what is in it was never sent.
      continue;
    }
    if (isStatus(text)) {
      mode = "none";
      continue;
    }
    if (SHELL_PROMPT.test(text)) continue;

    if (THINKING.test(text) || THOUGHT_FOR.test(text)) {
      mode = "thinking";
      current = null;
      const last = steps[steps.length - 1];
      if (!last || last.kind !== "thinking") steps.push({ kind: "thinking", lines: 0 });
      continue;
    }

    const user = raw.trim().match(USER_LINE);
    if (user) {
      mode = "user";
      current = null;
      const body = plain(user[1]);
      if (body) steps.push({ kind: "user", text: body });
      continue;
    }

    const result = raw.trim().match(RESULT_LINE);
    if (result) {
      mode = "result";
      const body = plain(result[1]);
      if (current && current.kind !== "runs" && body) {
        const diff = body.match(DIFF_STAT);
        if (diff) {
          current.detail = `+${diff[1]} -${diff[2]}`;
          current.diff = true;
        } else if (!current.detail) {
          current.detail = shorten(body, 70);
        }
      }
      continue;
    }

    const bulleted = /^\s*●/.test(raw);
    if (bulleted) {
      const body = plain(raw);
      const many = body.match(RAN_MANY);
      if (many) {
        current = { kind: "runs", count: Number(many[1]), labels: [] };
        steps.push(current);
        mode = "tool";
        continue;
      }

      const call = body.match(TOOL_CALL) || body.match(TOOL_CALL_CUT);
      if (call) {
        current = toolStep(call[1], call[2]);
        steps.push(current);
        mode = "tool";
        continue;
      }
      current = null;
      mode = "prose";
      pushProse(body);
      continue;
    }

    // An unmarked row continues whatever block it sits in - and by default that
    // block is the answer.
    //
    // It used to be nothing: prose was only recorded once a line beginning with
    // "●" had switched the mode, and Claude Code v2.1 stopped drawing that
    // bullet. On a real screen from it there are none, so the reader recorded
    // nothing at all and reported an empty session. Everything that is not
    // thinking, not chrome and not a tool call is what Claude said.
    if (mode === "thinking") {
      const last = steps[steps.length - 1];
      if (last && last.kind === "thinking") last.lines += 1;
    } else if (mode !== "result" && mode !== "tool") {
      // Everything except the folded output of a tool call, which belongs to
      // the call above it and not to the answer.
      pushProse(text);
    }
  }

  return collapse(steps);
}

/** Consecutive shell calls read better as one line, exactly as the web UI does. */
function collapse(steps) {
  const out = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (step.kind === "run" && last && last.kind === "runs") {
      last.count += 1;
      last.labels.push(step.label);
      continue;
    }
    if (step.kind === "runs" && last && last.kind === "runs") {
      last.count += step.count;
      last.labels.push(...step.labels);
      continue;
    }
    if (step.kind === "runs" && last && last.kind === "run") {
      out[out.length - 1] = {
        kind: "runs",
        count: step.count + 1,
        labels: [last.label, ...step.labels],
      };
      continue;
    }
    if (step.kind === "run" && last && last.kind === "run") {
      out[out.length - 1] = { kind: "runs", count: 2, labels: [last.label, step.label] };
      continue;
    }
    if (step.kind === "thinking" && last && last.kind === "thinking") {
      last.lines += step.lines;
      continue;
    }
    out.push(step);
  }
  return out;
}

/** One line of plain text per step, for anything that cannot render DOM. */
export function summarise(steps) {
  return steps
    .map((s) => {
      if (s.kind === "user") return `> ${s.text}`;
      if (s.kind === "prose") return s.text;
      if (s.kind === "runs") return `Chạy ${s.count} lệnh`;
      if (s.kind === "run") return `Chạy ${s.label}`;
      if (s.kind === "thinking") return "(đang suy nghĩ)";
      return s.detail ? `${s.label} ${s.detail}` : s.label;
    })
    .join("\n");
}
