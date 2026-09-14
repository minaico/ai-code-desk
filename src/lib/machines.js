/**
 * A shape per machine.
 *
 * With terminals from several machines side by side in one tab strip, the thing
 * you need at a glance is not "is it alive" - it is "which machine am I about to
 * type into". Colour already means status, and colour is also what tab colours
 * use, so the machine gets shape instead: the first machine in the list is a
 * circle, the next a triangle, then a square, and so on.
 *
 * Shape follows the order of the machine list, not which machine happens to
 * be serving this page. The list is the same file on every machine in the
 * group, so a machine keeps its shape when another one becomes the main host.
 */

import { t } from "./i18n.js";

const SHAPES = ["circle", "triangle", "square", "diamond", "pentagon", "hexagon"];

const LOCAL = "local";

/**
 * The id behind "local" and behind no id at all: the machine running the web
 * server this page came from.
 */
export function localHostId(hosts = []) {
  const found = hosts.find((h) => h && h.local);
  return found ? found.id : LOCAL;
}

function resolve(hostId, hosts) {
  const id = String(hostId || LOCAL);
  return id === LOCAL ? localHostId(hosts) : id;
}

/**
 * @param {string} hostId
 * @param {Array<{id:string, local?:boolean}>} hosts in registry order
 * @returns {string} one of SHAPES
 */
export function machineShape(hostId, hosts = []) {
  const id = resolve(hostId, hosts);
  const i = hosts.findIndex((h) => h && h.id === id);
  if (i >= 0) return SHAPES[Math.min(i, SHAPES.length - 1)];
  // Before the list has loaded, the machine serving the page is the one thing
  // known, and it has always been the circle.
  if (id === LOCAL) return SHAPES[0];
  // An unknown machine (an entry from a host that has since been removed) gets
  // the last shape rather than borrowing somebody else's.
  return SHAPES[SHAPES.length - 1];
}

/** Every machine has a name; the generic one is only what is left when nothing is known. */
export function machineName(hostId, hosts = [], fallback = "") {
  const id = resolve(hostId, hosts);
  const found = hosts.find((h) => h && h.id === id);
  if (found && found.name) return found.name;
  return fallback || (id === LOCAL ? t("Máy này") : id);
}

/**
 * The marker shown on a tab, a session card or a history row.
 *
 * Shape says which machine; colour says what is in the terminal. Red is
 * closed. Yellow is a shell and nothing more. Green means an agent has worked
 * here - which is the question actually being asked of a row of tabs: not
 * "is this alive" but "is this the one where Claude is".
 *
 * @param {string} hostId
 * @param {Array} hosts
 * @param {"running"|"exited"|string} status
 * @param {string} fallbackName
 * @param {string} agent kind of agent that has run here, if any
 */
export function markState(status, agent = "") {
  if (status !== "running") return "exited";
  return agent ? "agent" : "shell";
}

/** The agent kinds server/agent-log.js recognises, as people call them. */
const AGENT_NAMES = { claude: "Claude", antigravity: "Antigravity", codex: "Codex", gemini: "Gemini" };

/** What the colour is saying, in words, for the tooltip. */
export function markLabel(status, agent = "") {
  const state = markState(status, agent);
  if (state === "exited") return t("đã đóng");
  if (state === "shell") return t("đang chạy");
  return t("đang chạy · đã chạy {agent}", { agent: AGENT_NAMES[agent] || "Claude" });
}

export function machineMark(hostId, hosts = [], status = "running", fallbackName = "", agent = "") {
  const span = document.createElement("span");
  span.className = `mark ${machineShape(hostId, hosts)} ${markState(status, agent)}`;
  span.title = `${machineName(hostId, hosts, fallbackName)} · ${markLabel(status, agent)}`;
  return span;
}

export { SHAPES };
