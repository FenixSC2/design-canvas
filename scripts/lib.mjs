// design-canvas shared library: project loading, a small offset-preserving HTML parser,
// lint, changeset formatting and the mechanical part of `apply`.
// Zero dependencies on purpose: the skill must run with nothing but Node.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DEVICES = {
  desktop: { width: 1440, height: 900, autoHeight: true, phone: false, label: "Desktop" },
  laptop: { width: 1280, height: 800, autoHeight: true, phone: false, label: "Laptop" },
  tablet: { width: 834, height: 1194, autoHeight: true, phone: false, label: "Tablet" },
  "mobile-web": { width: 390, height: 844, autoHeight: true, phone: true, label: "Mobile web" },
  iphone: { width: 393, height: 852, autoHeight: false, phone: true, label: "iPhone 15" },
  android: { width: 412, height: 915, autoHeight: false, phone: true, label: "Android" },
};

// ---------------------------------------------------------------------------------------------
// Project files

export function paths(dir) {
  const d = path.resolve(dir);
  return {
    dir: d,
    design: path.join(d, "design.json"),
    tokens: path.join(d, "tokens.css"),
    components: path.join(d, "components.css"),
    comments: path.join(d, "comments.json"),
    changeset: path.join(d, "changeset.json"),
    applying: path.join(d, "changeset.applying.json"),
    internal: path.join(d, ".canvas"),
    state: path.join(d, ".canvas", "state.json"),
    history: path.join(d, ".canvas", "history"),
  };
}

export const readJson = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
export const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  fs.renameSync(tmp, p);
};

export function loadProject(dir) {
  const P = paths(dir);
  if (!fs.existsSync(P.design)) throw new Error(`No design.json in ${P.dir}. Run \`canvas.mjs init ${dir}\` first.`);
  const project = readJson(P.design);
  if (!project) throw new Error(`design.json in ${P.dir} is not valid JSON`);
  project.screens ??= [];
  for (const s of project.screens) {
    s.device ??= project.defaultDevice ?? "desktop";
    s.file ??= `screens/${s.id}.html`;
  }
  return project;
}

export function readComments(dir) {
  return readJson(paths(dir).comments, { threads: [] });
}
export function writeComments(dir, c) {
  writeJson(paths(dir).comments, c);
}

export function readState(dir) {
  return readJson(paths(dir).state, { version: 0 });
}

/** A content hash of everything the GUI renders. Changes when the agent edits any design file. */
export function versionOf(dir) {
  const P = paths(dir);
  const h = crypto.createHash("sha1");
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.name.startsWith("changeset")) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const st = fs.statSync(f);
        h.update(`${f}:${st.size}:${st.mtimeMs}\n`);
      }
    }
  };
  walk(P.dir);
  return h.digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------------------------
// Tokens

/** Custom properties declared in tokens.css, in order, first declaration wins (dark overrides ignored). */
export function parseTokens(css) {
  const out = [];
  const seen = new Set();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(stripped))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: m[1], value: m[2].trim(), group: tokenGroup(m[1]) });
  }
  return out;
}

export function tokenGroup(name) {
  const prefixes = [
    ["color", "color"], ["text", "text"], ["font-size", "text"], ["space", "space"], ["spacing", "space"],
    ["radius", "radius"], ["weight", "weight"], ["font", "font"], ["shadow", "shadow"],
    ["leading", "leading"], ["tracking", "tracking"], ["ease", "motion"], ["duration", "motion"],
  ];
  for (const [p, g] of prefixes) if (name === p || name.startsWith(p + "-")) return g;
  return "other";
}

// ---------------------------------------------------------------------------------------------
// HTML parsing that keeps source offsets, so edits splice into the agent's own formatting.

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const RAW = new Set(["script", "style", "textarea", "title"]);
const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return attrs;
}

export function parseHtml(html) {
  const lineStarts = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (off) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const root = { tag: "#root", attrs: {}, children: [], start: 0, openEnd: 0, innerStart: 0, innerEnd: html.length, end: html.length, parent: null, line: 1 };
  const stack = [root];
  const re = new RegExp(TAG_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    const [all, close, tagRaw, attrStr, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (close) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag !== tag) continue;
        for (let j = stack.length - 1; j >= k; j--) {
          stack[j].innerEnd = m.index;
          stack[j].end = j === k ? m.index + all.length : m.index;
        }
        stack.length = k;
        break;
      }
      continue;
    }
    const top = stack[stack.length - 1];
    const node = { tag, attrs: parseAttrs(attrStr || ""), children: [], start: m.index, openEnd: m.index + all.length, innerStart: m.index + all.length, parent: top, line: lineAt(m.index) };
    top.children.push(node);
    if (VOID.has(tag) || selfClose) { node.innerEnd = node.end = node.openEnd; continue; }
    if (RAW.has(tag)) {
      const e = html.toLowerCase().indexOf("</" + tag, node.openEnd);
      node.innerEnd = e < 0 ? html.length : e;
      const gt = html.indexOf(">", node.innerEnd);
      node.end = gt < 0 ? html.length : gt + 1;
      re.lastIndex = node.end;
      continue;
    }
    stack.push(node);
  }
  for (let j = stack.length - 1; j > 0; j--) { stack[j].innerEnd ??= html.length; stack[j].end ??= html.length; }
  return root;
}

export function* walk(node) {
  for (const c of node.children) { yield c; yield* walk(c); }
}

export const textOf = (html, node) =>
  html.slice(node.innerStart, node.innerEnd).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<\/?(em|strong|b|i|small|a)\b[^>]*>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function indexIds(html) {
  const root = parseHtml(html);
  const ids = new Map();
  const dupes = [];
  for (const n of walk(root)) {
    const id = n.attrs["data-id"];
    if (!id) continue;
    if (ids.has(id)) dupes.push({ id, line: n.line });
    else ids.set(id, n);
  }
  return { root, ids, dupes };
}

/** Nearest ancestor that carries a data-id (or the root). */
export const idParent = (n) => { let p = n.parent; while (p && p.tag !== "#root" && !p.attrs["data-id"]) p = p.parent; return p; };
/** Direct data-id children: descendants with a data-id whose nearest data-id ancestor is `n`. */
export function idChildren(n) {
  const out = [];
  const rec = (x) => { for (const c of x.children) { if (c.attrs["data-id"]) out.push(c); else rec(c); } };
  rec(n);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lint: static checks over the design files. Runtime checks (contrast, tap targets, off-scale
// computed values) run in the GUI's Audit tab, where the real layout exists.

const INTERACTIVE = new Set(["button", "a", "input", "select", "textarea"]);

export function lintProject(dir) {
  const P = paths(dir);
  const errors = [], warnings = [], info = [];
  let project;
  try { project = loadProject(dir); } catch (e) { errors.push({ where: "design.json", msg: e.message }); return { errors, warnings, info }; }

  const ids = new Set();
  for (const s of project.screens) {
    if (!s.id) errors.push({ where: "design.json", msg: "A screen has no id" });
    else if (ids.has(s.id)) errors.push({ where: "design.json", msg: `Duplicate screen id "${s.id}"` });
    ids.add(s.id);
    if (!DEVICES[s.device]) errors.push({ where: "design.json", msg: `Screen "${s.id}": unknown device "${s.device}" (one of ${Object.keys(DEVICES).join(", ")})` });
    if (s.of && !project.screens.some((o) => o.id === s.of)) errors.push({ where: "design.json", msg: `Screen "${s.id}" is a state of "${s.of}", which doesn't exist` });
  }

  // tokens
  if (!fs.existsSync(P.tokens)) errors.push({ where: "tokens.css", msg: "Missing tokens.css: every design needs a token set" });
  else {
    const toks = parseTokens(fs.readFileSync(P.tokens, "utf8"));
    const groups = new Set(toks.map((t) => t.group));
    for (const g of ["color", "text", "space", "radius"]) if (!groups.has(g)) warnings.push({ where: "tokens.css", msg: `No --${g}-* tokens. The inspector and audit use them as the scale.` });
    checkCss(fs.readFileSync(P.tokens, "utf8"), "tokens.css", warnings, { allowRawColor: true });
  }
  if (fs.existsSync(P.components)) checkCss(fs.readFileSync(P.components, "utf8"), "components.css", warnings, {});

  for (const s of project.screens) {
    const file = path.join(P.dir, s.file);
    const where = s.file;
    if (!fs.existsSync(file)) { errors.push({ where: "design.json", msg: `Screen "${s.id}": file ${s.file} not found` }); continue; }
    const html = fs.readFileSync(file, "utf8");
    const { root, dupes } = indexIds(html);
    for (const d of dupes) errors.push({ where: `${where}:${d.line}`, msg: `Duplicate data-id "${d.id}"` });
    for (const n of walk(root)) {
      const at = `${where}:${n.line}`;
      if (n.attrs["data-sketch"] !== undefined) errors.push({ where: at, msg: `Sketch "${n.attrs["data-id"]}" not elaborated yet: "${textOf(html, n).slice(0, 80)}"` });
      if (INTERACTIVE.has(n.tag) && !n.attrs["data-id"]) warnings.push({ where: at, msg: `<${n.tag}> without data-id: the user can't select or comment on it` });
      if (n.tag === "img" && n.attrs.alt === undefined) warnings.push({ where: at, msg: "<img> without alt" });
      if (n.attrs.style) checkCss(n.attrs.style, at, warnings, { inline: true });
      if (n.tag === "style") checkCss(html.slice(n.innerStart, n.innerEnd), at, warnings, {});
      if (n.attrs["data-goto"] && !ids.has(n.attrs["data-goto"])) warnings.push({ where: at, msg: `data-goto="${n.attrs["data-goto"]}" points at no screen` });
    }
    // copy checks on text only
    const text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>/gi, "").replace(/<[^>]+>/g, " ");
    if (/—|&mdash;/.test(text)) warnings.push({ where, msg: "Em dash in copy. Use a comma, colon, period or parentheses." });
    if (/\s--\s/.test(text)) warnings.push({ where, msg: "\"--\" used as a dash in copy." });
    if (/lorem ipsum/i.test(text)) warnings.push({ where, msg: "Lorem ipsum. Write real copy: the mock is judged on it." });
  }

  const c = readComments(dir);
  const open = c.threads.filter((t) => t.status === "open");
  const waiting = open.filter((t) => t.messages.at(-1)?.by === "user");
  if (waiting.length) info.push({ where: "comments.json", msg: `${waiting.length} comment(s) waiting for your reply: ${waiting.map((t) => t.id).join(", ")}` });
  return { errors, warnings, info };
}

function checkCss(css, where, warnings, { allowRawColor = false, inline = false }) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const w = (msg) => warnings.push({ where, msg });
  if (/border-(left|right)(-width)?\s*:\s*([2-9]|\d{2,})(\.\d+)?px/.test(s)) w("Side-stripe border (>1px on one side). Use a full border, a tint, or nothing.");
  if (/background-clip\s*:\s*text/.test(s)) w("Gradient text (background-clip: text). Use one solid color.");
  if (/backdrop-filter/.test(s)) w("backdrop-filter: glass effects only when purposeful (e.g. a sheet over content).");
  if (/(^|[^-\w])(#000(000)?|#fff(fff)?)\b/i.test(s) || /:\s*(black|white)\s*(;|$)/i.test(s)) w("Pure #000/#fff. Tint neutrals toward the brand hue.");
  if (!allowRawColor) {
    const raw = s.replace(/var\([^)]*\)/g, "").match(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch|oklab|lab|lch)\(/gi);
    if (raw) w(`Raw color ${raw[0]}${raw[0].endsWith("(") ? "…)" : ""}: use a --color-* token.`);
    const fs_ = s.match(/font-size\s*:\s*([\d.]+(px|rem|em|pt))/i);
    if (fs_) w(`Raw font-size ${fs_[1]}: use a --text-* token.`);
  }
  if (inline && /(padding|margin|gap)\s*:\s*[^;]*\d+px/.test(s.replace(/var\([^)]*\)/g, ""))) w("Raw spacing in an inline style: use --space-* tokens.");
}

// ---------------------------------------------------------------------------------------------
// Changesets

export const OP_LABEL = {
  text: "text", style: "style", resize: "resize", move: "move", remove: "remove",
  duplicate: "duplicate", sketch: "sketch",
};

/** Ops the CLI applies to the source itself (pure structure/content). The rest is the agent's craft. */
export const MECHANICAL = new Set(["text", "remove", "move", "duplicate"]);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const q = (s, n = 60) => { const t = String(s ?? "").replace(/\s+/g, " "); return `"${t.length > n ? t.slice(0, n - 1) + "…" : t}"`; };

function describeOp(op) {
  switch (op.op) {
    case "text": return `${op.id}  ${q(op.before)} → ${q(op.value)}`;
    case "style": return `${op.id}  ${op.prop}: ${op.before ?? "(inherited)"} → ${op.value}${op.token ? "" : "   ⚠ off-scale raw value"}`;
    case "resize": {
      const parts = [];
      if (op.width !== undefined) parts.push(`width ${op.before?.width ?? "?"} → ${op.width === null ? "auto" : op.width + "px"}`);
      if (op.height !== undefined) parts.push(`height ${op.before?.height ?? "?"} → ${op.height === null ? "auto" : op.height + "px"}`);
      return `${op.id}  ${parts.join(", ")}`;
    }
    case "move": return `${op.id}  into ${op.parent ?? "(same parent)"} at position ${op.index + 1}${op.before ? `  (was ${op.before.parent === op.parent ? "" : op.before.parent + " "}position ${op.before.index + 1})` : ""}`;
    case "remove": return `${op.id}${op.label ? "  " + q(op.label) : ""}`;
    case "duplicate": return `${op.id}  → copy with ids suffixed "${op.suffix}"`;
    case "sketch": return `new ${op.newId} in ${op.parent} at index ${op.index}: ${q(op.note, 120)}`;
    default: return JSON.stringify(op);
  }
}

export function formatChangeset(dir, cs, { applied } = {}) {
  const project = loadProject(dir);
  const byScreen = new Map();
  for (const op of cs.ops ?? []) {
    if (!byScreen.has(op.screen)) byScreen.set(op.screen, []);
    byScreen.get(op.screen).push(op);
  }
  const lines = [];
  const nC = (cs.comments ?? []).length;
  lines.push(`Changeset sent ${cs.sentAt ?? "?"} · ${(cs.ops ?? []).length} edit(s) · ${nC} comment(s)/repl(ies)`);
  if (cs.note) lines.push(`Note from the user: ${q(cs.note, 400)}`);
  let n = 0;
  const todo = [];
  for (const [sid, ops] of byScreen) {
    const s = project.screens.find((x) => x.id === sid);
    lines.push("", `${sid}  (${s?.file ?? "unknown screen"})`);
    let html = s ? safeRead(path.join(paths(dir).dir, s.file)) : "";
    const idx = html ? indexIds(html).ids : new Map();
    for (const op of ops) {
      n++;
      const node = idx.get(op.id) ?? idx.get(op.parent);
      const where = node ? `  [line ${node.line}]` : "";
      const state = applied?.has(op) ? "  ✓ applied" : MECHANICAL.has(op.op) ? "" : "  → you";
      lines.push(`  ${String(n).padStart(2)}. ${op.op.padEnd(9)} ${describeOp(op)}${where}${state}${op.note && op.op !== "sketch" ? `\n      note:${q(op.note, 300)}` : ""}`);
      if (!applied?.has(op)) todo.push({ n, op, sid });
    }
  }
  const comments = cs.comments ?? [];
  if (comments.length) {
    lines.push("", "Comments");
    for (const c of comments) {
      const target = c.target ? `${c.screen} › ${c.target}` : c.screen ?? "(project)";
      const kind = c.reply ? "reply on" : c.resolve ? "resolved" : "new";
      lines.push(`  ${c.thread.padEnd(5)} ${kind.padEnd(8)} ${target}  ${q(c.text, 300)}`);
    }
  }
  lines.push("", "To do");
  if (todo.length) {
    const kinds = new Set(todo.map((t) => t.op.op));
    if (!applied) lines.push("  - Run `apply` first: it applies text/remove/move/duplicate edits to the source for you.");
    if (kinds.has("style") || kinds.has("resize")) lines.push(
      "  - style/resize ops are the user's intent, previewed as inline styles. Express each in the design system:",
      "    a token or a component class change, not an inline style. A resize means \"this should be wider/taller\":",
      "    decide whether that's a max-width, a grid track, flex-basis or padding, and say what you chose.",
      "    If the same element appears on other screens (same class/component), keep them consistent.");
    if (kinds.has("sketch")) lines.push("  - Sketches are placeholders the user drew. Build each into real elements with data-ids, in the design system.");
    for (const t of todo.filter((t) => !applied?.has(t.op))) if (!MECHANICAL.has(t.op.op) || !applied) lines.push(`    #${t.n} ${t.op.op} ${t.op.id ?? t.op.newId} (${t.sid})`);
  }
  if (comments.some((c) => !c.resolve)) lines.push(
    "  - Answer every comment with `reply <dir> <thread> \"…\"` (add --resolve when it's settled).",
    "    A question gets an answer and your pick, not a redesign. A request (\"make this a pill\") is an edit: make it.");
  lines.push("  - Then `done <dir> --summary \"what you changed beyond the literal edits\"`. The GUI reloads.");
  return lines.join("\n");
}

const safeRead = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// ---------------------------------------------------------------------------------------------
// Mechanical apply: text, remove, move, duplicate, spliced into the source with its formatting.

function lineIndentAt(html, off) {
  const ls = html.lastIndexOf("\n", off - 1) + 1;
  const m = /^[ \t]*/.exec(html.slice(ls));
  return { lineStart: ls, indent: m[0], onlyWsBefore: /^[ \t]*$/.test(html.slice(ls, off)) };
}

function cutRange(html, node) {
  // Take the whole line(s) when the element sits on its own lines.
  const { lineStart, onlyWsBefore } = lineIndentAt(html, node.start);
  let s = node.start, e = node.end;
  const nl = html.indexOf("\n", e);
  const after = html.slice(e, nl < 0 ? html.length : nl);
  if (onlyWsBefore && /^[ \t]*$/.test(after)) { s = lineStart; e = nl < 0 ? html.length : nl + 1; }
  return [s, e];
}

function reindent(block, from, to) {
  return block.split("\n").map((l, i) => (i === 0 ? l : l.startsWith(from) ? to + l.slice(from.length) : l)).join("\n");
}

export function applyMechanical(html, op) {
  const { ids } = indexIds(html);
  const node = ids.get(op.id);
  if (!node) return { html, ok: false, why: `data-id "${op.id}" not found` };
  switch (op.op) {
    case "text": {
      if (node.children.some((c) => c.tag !== "br" && c.tag !== "span" && c.tag !== "em" && c.tag !== "strong" && c.tag !== "b" && c.tag !== "i")) return { html, ok: false, why: "element has child elements; edit by hand" };
      return { html: html.slice(0, node.innerStart) + esc(op.value) + html.slice(node.innerEnd), ok: true };
    }
    case "remove": {
      const [s, e] = cutRange(html, node);
      return { html: html.slice(0, s) + html.slice(e), ok: true };
    }
    case "duplicate": {
      const block = html.slice(node.start, node.end).replace(/data-id="([^"]+)"/g, (_, id) => `data-id="${id}${op.suffix}"`);
      const { indent } = lineIndentAt(html, node.start);
      return { html: html.slice(0, node.end) + "\n" + indent + block + html.slice(node.end), ok: true };
    }
    case "move": {
      const target = op.parent ? ids.get(op.parent) : idParent(node);
      if (!target) return { html, ok: false, why: `parent "${op.parent}" not found` };
      const { indent: fromIndent } = lineIndentAt(html, node.start);
      const block = html.slice(node.start, node.end);
      const [cs, ce] = cutRange(html, node);
      let h2 = html.slice(0, cs) + html.slice(ce);
      // re-index after the cut
      const { ids: ids2 } = indexIds(h2);
      const t2 = op.parent ? ids2.get(op.parent) : (() => { const r = parseHtml(h2); for (const n of walk(r)) if (n.start === (target.start < cs ? target.start : target.start - (ce - cs))) return n; return null; })();
      if (!t2) return { html, ok: false, why: "could not re-locate the target container" };
      const sibs = idChildren(t2);
      let at, indent;
      if (op.index < sibs.length) {
        const ref = sibs[op.index];
        const li = lineIndentAt(h2, ref.start);
        indent = li.indent;
        if (li.onlyWsBefore) { at = li.lineStart; const ins = indent + reindent(block, fromIndent, indent) + "\n"; return { html: h2.slice(0, at) + ins + h2.slice(at), ok: true }; }
        at = ref.start;
        return { html: h2.slice(0, at) + reindent(block, fromIndent, indent) + h2.slice(at), ok: true };
      }
      const last = sibs.at(-1);
      if (last) {
        indent = lineIndentAt(h2, last.start).indent;
        return { html: h2.slice(0, last.end) + "\n" + indent + reindent(block, fromIndent, indent) + h2.slice(last.end), ok: true };
      }
      indent = lineIndentAt(h2, t2.start).indent + "  ";
      return { html: h2.slice(0, t2.innerEnd) + "\n" + indent + reindent(block, fromIndent, indent) + "\n" + lineIndentAt(h2, t2.start).indent + h2.slice(t2.innerEnd).replace(/^\s*/, ""), ok: true };
    }
  }
  return { html, ok: false, why: "not mechanical" };
}

// ---------------------------------------------------------------------------------------------
// Spec: the component tree per screen, for recreating the mock in the real codebase.

export function specOf(dir, screenId) {
  const project = loadProject(dir);
  const P = paths(dir);
  const out = [];
  for (const s of project.screens) {
    if (screenId && s.id !== screenId) continue;
    const html = safeRead(path.join(P.dir, s.file));
    const root = parseHtml(html);
    out.push(`${s.id}  ${s.name ?? ""}${s.state ? ` [state: ${s.state} of ${s.of}]` : ""}  · ${s.device} ${DEVICES[s.device]?.width ?? "?"}w${s.address ? `  · ${s.address}` : ""}`);
    const rec = (n, depth) => {
      for (const c of n.children) {
        const id = c.attrs["data-id"];
        if (!id) { rec(c, depth); continue; }
        const comp = c.attrs["data-component"];
        const cls = (c.attrs.class ?? "").split(/\s+/).filter(Boolean).join(".");
        const kids = idChildren(c);
        const t = kids.length ? "" : textOf(html, c);
        const extras = [c.attrs["data-goto"] ? `→ ${c.attrs["data-goto"]}` : "", c.attrs["data-state"] ? `state:${c.attrs["data-state"]}` : ""].filter(Boolean).join(" ");
        out.push(`${"  ".repeat(depth + 1)}${id}  <${c.tag}${cls ? "." + cls : ""}>${comp ? `  ⟨${comp}⟩` : ""}${t ? "  " + q(t, 50) : ""}${extras ? "  " + extras : ""}`);
        rec(c, depth + 1);
      }
    };
    rec(root, 0);
    out.push("");
  }
  return out.join("\n");
}
