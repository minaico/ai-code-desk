/**
 * Two interface languages: Vietnamese, which the UI was written in, and
 * English.
 *
 * The Vietnamese text itself is the key. Nothing in the markup or the code had
 * to be renamed to become translatable, and a string nobody translated yet still
 * reads correctly to half the audience instead of showing an identifier.
 *
 *   t("Đã tạo {title}", { title })   dynamic text, with {placeholders}
 *   tr(message)                       text from elsewhere (the server, the
 *                                     browser) - exact match, then patterns
 *   translateDom(root)                the static shell markup, once, at mount
 *
 * The language is fixed for the life of the page. Switching it reloads, which
 * is simpler and more honest than chasing every label that was already drawn.
 */
import { EN, EN_PATTERNS } from "./i18n-en.js";

const KEY = "wt.lang";
const LANGS = ["vi", "en"];

function detect() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch {}
  // Vietnamese for a browser that asks for it, English for everyone else.
  const nav = typeof navigator === "undefined" ? {} : navigator;
  const wanted = nav.languages && nav.languages.length ? nav.languages : [nav.language || ""];
  return wanted.some((l) => /^vi\b/i.test(String(l))) ? "vi" : "en";
}

export const lang = detect();

export function setLang(next) {
  if (!LANGS.includes(next)) return;
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  location.reload();
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const norm = (s) => String(s).replace(/\s+/g, " ").trim();

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (has(vars, k) ? String(vars[k]) : m));
}

/** A string written in this codebase, possibly with {placeholders}. */
export function t(vi, vars) {
  const text = lang === "en" && has(EN, vi) ? EN[vi] : vi;
  return fill(text, vars);
}

/**
 * A string that came from somewhere else - a server error, a browser message.
 * Exact translations first, then patterns for the ones that carry a value.
 */
export function tr(message) {
  const text = String(message ?? "");
  if (lang !== "en") return text;
  const key = norm(text);
  if (has(EN, key)) return EN[key];
  for (const [re, en] of EN_PATTERNS) {
    if (re.test(key)) return key.replace(re, en);
  }
  return text;
}

const ATTRS = ["placeholder", "title", "aria-label"];

/**
 * Translate markup in place: every text node that is exactly a key (after
 * collapsing whitespace, so the template can wrap lines), and the attributes
 * people read.
 */
export function translateDom(root) {
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  if (lang !== "en" || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const key = norm(node.nodeValue);
    if (!key || !has(EN, key)) continue;
    // Keep the whitespace around the text: it is what separates it from the
    // <b> or <code> next to it.
    const lead = /^\s/.test(node.nodeValue) ? " " : "";
    const tail = /\s$/.test(node.nodeValue) ? " " : "";
    node.nodeValue = lead + EN[key] + tail;
  }
  for (const attr of ATTRS) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const key = norm(el.getAttribute(attr));
      if (has(EN, key)) el.setAttribute(attr, EN[key]);
    }
  }
}
