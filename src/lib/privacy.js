/**
 * Which parts of a terminal row to hide when the screen is being shown to
 * someone - a screen share, a stream, a screenshot for the README.
 *
 * What you typed stays readable; that is what tells a viewer what is going on.
 * What came back is blurred; that is where the private things are - file
 * contents, paths, keys an agent printed.
 *
 *   PS C:\work\project> npm test     prompt blurred (it is a path), command kept
 *   > summarise the failing tests    a message to an agent, kept
 *   ● The tests fail because …       the answer, blurred
 *
 * Returns [start, end) ranges of string indices to cover; [] keeps the row.
 */

const SHELL_PROMPTS = [
  /^PS [^>]*>\s?/, // PowerShell:  PS C:\path>
  /^[A-Za-z]:\\[^>]*>/, // cmd:  C:\path>
  /^[\w.-]+@[\w.-]+(?::[^$#]*)?[$#]\s?/, // bash / zsh:  user@host:~/dir$
];

// A line an agent echoes back as yours: "> text" in Claude Code and Gemini CLI,
// "❯ text" in Claude Code's input box, "› text" in Codex - possibly inside a
// box border.
const AGENT_INPUT = /^[\s│┃▌]*[>❯›]\s+\S/;

export function classifyRow(text) {
  const line = String(text || "").replace(/\s+$/, "");
  if (!line.trim()) return [];
  for (const re of SHELL_PROMPTS) {
    const m = line.match(re);
    if (m) return [[0, m[0].trimEnd().length]];
  }
  if (AGENT_INPUT.test(line)) return [];
  const start = line.length - line.trimStart().length;
  return [[start, line.length]];
}
