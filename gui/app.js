// design-canvas GUI. Screens render in same-origin iframes; the canvas reads and edits their DOM
// directly. Every edit is an op keyed by data-id, so it can be previewed, undone, replayed after
// the agent reloads a screen, and sent to the agent as an exact instruction.
//
// Frames: one artboard per view of a screen. "screen" is the screen itself; "breakpoint" the same
// screen at a narrower width; "variant" an alternative the agent offered; "proposal" the agent's
// proposed version; "build" a screenshot of the real build; "catalog" the component catalog.
// DOM edits (text, move, delete…) replay into every editable frame of a screen. Style edits render
// as one override stylesheet per frame, so a breakpoint edit is a real @media rule, a hover edit a
// real :hover rule and a component edit a rule on every instance.

import { installForcedStates, stateSelector, statesFor, STATES } from "./states.js";
import { openPlayer, playerOpen, playerKey } from "./player.js";

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cssq = (id) => `[data-id="${CSS.escape(id)}"]`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const snap = (v) => Math.round(v / 4) * 4;
const platformOf = (device) => (device === "iphone" ? "ios" : device === "android" ? "android" : "web");
const ago = (t) => { const s = (Date.now() - new Date(t).getTime()) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };

export const S = {
  project: null, tokens: [], devices: {}, motion: null, threads: [], lint: null,
  variants: [], proposal: null, proposalScreens: [], compare: [], catalog: {},
  version: null, phase: "editing", doneAt: null, compareAt: null,
  frames: new Map(),          // frame key -> frame
  ops: [], sentOps: [],       // pending edits; edits sent but not yet applied by the agent
  drafts: [],                 // new comments not yet sent
  replies: [],                // replies/resolves on existing threads not yet sent
  dismissed: [],              // variant sets the user turned down: { set, note }
  proposalResp: null,         // { decision, accepted:Set, system, answers:{}, reply }
  sel: null,                  // { frame, screen, id, cat?, catState? }
  hover: null,                // { frame, id }
  forced: null,               // { frame, id, state }: interaction state shown on the selected element
  mode: "select",
  tab: "inspect",
  view: { x: 40, y: 80, k: 0.5 },
  show: { breakpoints: true, components: false, build: true },
  buildMode: {},              // screen -> "image" | "diff"
  audit: { issues: [], used: null },
  showResolved: false,
};

// ---------------------------------------------------------------------------------------------
// persistence: unsent work survives a reload; it replays by data-id, so it still applies after the
// agent changes the files, and edits whose element is gone simply do nothing.

const stashKey = () => `design-canvas:${S.dir}`;
function stash() {
  try {
    localStorage.setItem(stashKey(), JSON.stringify({ ops: S.ops, drafts: S.drafts, replies: S.replies, dismissed: S.dismissed, sentOps: S.phase === "editing" ? [] : S.sentOps }));
    localStorage.setItem("design-canvas:show", JSON.stringify(S.show));
  } catch { /* storage off */ }
}
function unstash() {
  try {
    const v = JSON.parse(localStorage.getItem(stashKey()) ?? "null");
    if (v) {
      S.ops = v.ops ?? []; S.drafts = v.drafts ?? []; S.replies = v.replies ?? []; S.dismissed = v.dismissed ?? [];
      if (S.phase !== "editing") S.sentOps = v.sentOps ?? [];
    }
    Object.assign(S.show, JSON.parse(localStorage.getItem("design-canvas:show") ?? "{}"));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------
// boot & sync with the agent

async function boot() {
  await loadProject();
  unstash();
  filterVariants();
  buildWorld();
  bindChrome();
  bindCanvas();
  render();
  setTimeout(() => fit(false), 0);
  setInterval(poll, 1200);
}

async function loadProject() {
  const r = await fetch("/api/project").then((r) => r.json());
  S.project = r.project; S.tokens = r.tokens; S.devices = r.devices; S.motion = r.motion; S.threads = r.comments.threads ?? [];
  S.lint = r.lint; S.version = r.status.version; S.dir = r.status.dir; S.phase = r.status.phase; S.doneAt = r.status.done?.at ?? null;
  S.compareAt = r.status.compareAt; S.compare = r.compare ?? []; S.catalog = r.catalog ?? {};
  S.allVariants = r.variants ?? [];
  filterVariants();
  const hadProposal = S.proposal?.createdAt;
  S.proposal = r.proposal; S.proposalScreens = r.proposalScreens ?? [];
  if (!S.proposal) S.proposalResp = null;
  else if (S.proposal.createdAt !== hadProposal || !S.proposalResp) {
    const all = [...S.proposal.changed.screens, ...S.proposal.changed.added, ...S.proposal.changed.removed];
    S.proposalResp = { decision: null, accepted: new Set(all), system: true, answers: {}, reply: "" };
  }
  $("#proj-name").textContent = S.project.name ?? "Design";
  const devs = [...new Set(S.project.screens.map((s) => S.devices[s.device]?.label ?? s.device))];
  $("#proj-meta").textContent = `${S.project.screens.length} screens · ${devs.join(", ")}`;
  document.title = `${S.project.name} · Design Canvas`;
}

/** Variant sets still waiting: not turned down and not picked in this browser. */
function filterVariants() {
  S.variants = (S.allVariants ?? []).filter((v) => !S.dismissed.some((d) => d.set === v.id) && ![...S.ops, ...S.sentOps].some((o) => o.op === "pick-variant" && o.set === v.id));
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const st = await fetch("/api/status").then((r) => r.json());
    const changed = st.version !== S.version;
    const finished = st.done?.at && st.done.at !== S.doneAt;
    const compared = st.compareAt && st.compareAt !== S.compareAt;
    const prevPhase = S.phase;
    S.phase = st.phase;
    // While the agent works the source is half-applied: replaying sent edits on it would double
    // duplicates and sketches. Hold the preview until it runs `done`.
    if (changed && !finished && st.phase !== "editing" && S.sentOps.length) { renderBanner(); renderSend(); polling = false; return; }
    if (changed || finished || compared) {
      const wasSent = S.sentOps.length > 0 || prevPhase !== "editing";
      if (st.phase === "editing" && finished) S.sentOps = [];
      await loadProject();
      reloadAll(changed || finished);
      render();
      if (finished && wasSent) toast(st.done.summary ? `Agent: ${st.done.summary}` : "The agent applied your changes.", 7000);
      else if (compared) toast("Build comparison is ready: see the Build tab.", 5000);
    }
    renderBanner();
    renderSend();
  } catch { /* server restarting */ }
  polling = false;
}

// ---------------------------------------------------------------------------------------------
// world: frame definitions → artboards in device frames

export const ICONS_STATUS = '<span class="icons"><svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="0.8"/><rect x="5" y="5.5" width="3" height="6.5" rx="0.8"/><rect x="10" y="3" width="3" height="9" rx="0.8"/><rect x="15" y="0" width="3" height="12" rx="0.8"/></svg><svg viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.1-1.2A10.2 10.2 0 0 0 8 .5C5.3.5 2.8 1.6.9 3.4L2 4.6a8.6 8.6 0 0 1 6-2.4zm0 3.4c1.4 0 2.6.5 3.6 1.4l1.1-1.2A7 7 0 0 0 8 3.9 7 7 0 0 0 3.3 5.8L4.4 7c1-.9 2.2-1.4 3.6-1.4zM8 9a1.6 1.6 0 1 0 0 3.2A1.6 1.6 0 0 0 8 9z"/></svg><svg viewBox="0 0 27 12" fill="none"><rect x="0.5" y="0.5" width="23" height="11" rx="3.5" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="18" height="8" rx="2" fill="currentColor"/><path d="M25 4v4c.8-.3 1.4-1.1 1.4-2S25.8 4.3 25 4z" fill="currentColor" opacity="0.5"/></svg></span>';
const ICONS = {
  desktop: '<svg class="dev-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14h5"/></svg>',
  phone: '<svg class="dev-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="4" y="1.5" width="8" height="13" rx="2"/><path d="M7 12.5h2"/></svg>',
  comps: '<svg class="dev-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="2.5"/><rect x="2" y="9" width="5" height="5" rx="1"/><path d="M9 11.5h5M11.5 9v5"/></svg>',
};
const LETTERS = "ABCDEFGH";
const isEditable = (f) => f && (f.kind === "screen" || f.kind === "breakpoint" || f.kind === "catalog");
const screenKinds = (f) => f.kind === "screen" || f.kind === "breakpoint";
const framesOfScreen = (id) => [...S.frames.values()].filter((f) => screenKinds(f) && f.s.id === id);
const opScreenOf = (f) => (f.kind === "catalog" ? "__components" : f.s.id);

function breakpointsFor(s) {
  if (platformOf(s.device) !== "web" || s.device === "mobile-web") return [];
  const dev = S.devices[s.device];
  return (s.breakpoints ?? S.project.breakpoints ?? []).filter((w) => w < dev.width).sort((a, b) => b - a);
}

function frameDefs() {
  const defs = [];
  if (S.show.components) for (const pf of ["web", "ios", "android"]) if (S.catalog[pf]?.length) {
    defs.push({ key: `__components-${pf}`, kind: "catalog", pf, group: `__components-${pf}`, row: "c", s: { id: `__components-${pf}`, name: `Components · ${pf === "ios" ? "iOS" : pf === "android" ? "Android" : "Web"}`, device: "desktop" } });
  }
  const removed = new Set(S.proposal?.changed.removed ?? []);
  const changed = new Set(S.proposal?.changed.screens ?? []);
  for (const s of S.project.screens) {
    const group = s.of && S.project.screens.some((o) => o.id === s.of) ? s.of : s.id;
    const base = { s, group, row: s.id };
    defs.push({ ...base, key: s.id, kind: "screen", removed: removed.has(s.id) });
    if (S.show.breakpoints) for (const w of breakpointsFor(s)) defs.push({ ...base, key: `${s.id}@${w}`, kind: "breakpoint", width: w });
    for (const set of S.variants.filter((v) => v.screen === s.id)) set.options.forEach((o, i) => defs.push({ ...base, key: `${s.id}~${set.id}~${o.id}`, kind: "variant", set, option: o, letter: LETTERS[i], first: i === 0 }));
    if (changed.has(s.id)) defs.push({ ...base, key: `${s.id}+proposal`, kind: "proposal", s: S.proposalScreens.find((p) => p.id === s.id) ?? s });
    const rep = S.show.build && S.compare.find((r) => r.screen === s.id);
    if (rep) defs.push({ ...base, key: `${s.id}#build`, kind: "build", report: rep });
  }
  for (const id of S.proposal?.changed.added ?? []) {
    const s = S.proposalScreens.find((p) => p.id === id);
    if (s) defs.push({ key: `${id}+proposal`, kind: "proposal", added: true, s, group: `${id}+proposal`, row: id });
  }
  return defs;
}

function devFor(def) {
  if (def.kind === "catalog") return { width: def.pf === "web" ? 1040 : 980, height: 480, autoHeight: true, phone: false, label: "Every shared component, in every state" };
  if (def.kind === "breakpoint") return def.width < 700 ? { width: def.width, height: 844, autoHeight: true, phone: true, label: "Mobile web", device: "mobile-web" } : { width: def.width, height: 1100, autoHeight: true, phone: false, label: "Tablet", device: "tablet" };
  return S.devices[def.s.device] ?? S.devices.desktop;
}

function srcFor(f) {
  const v = `v=${S.version}-${Date.now()}`;
  if (f.kind === "catalog") return `/screen/__components-${f.pf}?${v}`;
  if (f.kind === "variant") return `/screen/${encodeURIComponent(f.s.id)}?variant=${encodeURIComponent(f.set.id + "/" + f.option.id)}&${v}`;
  if (f.kind === "proposal") return `/screen/${encodeURIComponent(f.s.id)}?proposal=1&${v}`;
  return `/screen/${encodeURIComponent(f.s.id)}?${v}`;
}

function labelFor(f) {
  const s = f.s, dev = f.dev;
  const dims = `<span class="dim">${esc(dev.label)} · ${dev.width}${dev.autoHeight ? "" : "×" + dev.height}</span>`;
  switch (f.kind) {
    case "screen": return `<b data-fly="${esc(f.key)}">${esc(s.name ?? s.id)}</b>${s.state ? `<span class="state">${esc(s.state)}</span>` : ""}${dims}${f.removed ? '<span class="state del">removed in proposal</span>' : ""}<button class="ab-btn" data-play-motion="${esc(f.key)}" title="Replay entrance motion" hidden>▶ Motion</button>`;
    case "breakpoint": return `<b data-fly="${esc(f.key)}" title="Edits here apply at ${f.width}px and below">${esc(s.name ?? s.id)}</b><span class="state">${f.width}px</span>`;
    case "variant": return `<span class="vtag">Variant ${f.letter}</span><b>${esc(f.option.label ?? f.option.id)}</b><button class="ab-btn go" data-pick="${esc(f.set.id)}|${esc(f.option.id)}">Pick</button>${f.first ? `<button class="ab-btn" data-none="${esc(f.set.id)}">None of these</button>` : ""}${f.option.rationale ? `<span class="why">${esc(f.option.rationale)}</span>` : ""}`;
    case "proposal": return `<span class="vtag prop">Proposed</span><b>${esc(s.name ?? s.id)}</b>${f.added ? '<span class="state add">new screen</span>' : ""}${dims}`;
    case "build": return `<span class="vtag build">Built</span><b>${esc(matchLine(f.report))}</b><span class="dim">${esc(f.report.source.replace(/^file:\/\/.*\/([^/]+\/[^/]+)$/, "$1"))} · ${ago(f.report.at)}</span><button class="ab-btn" data-buildmode="${esc(s.id)}">${S.buildMode[s.id] === "diff" ? "Show build" : "Show pixel diff"}</button>`;
    case "catalog": return `<b data-fly="${esc(f.key)}">${ICONS.comps} ${esc(s.name)}</b><span class="dim">${esc(dev.label)} · edits change the component everywhere</span>`;
  }
  return "";
}

function buildWorld() {
  const world = $("#world");
  world.innerHTML = "";
  S.frames.clear();
  for (const def of frameDefs()) {
    const dev = devFor(def);
    const f = { ...def, dev, doc: null, win: null, tokenCache: null, ready: false, marks: [] };
    const ab = document.createElement("div");
    ab.className = `artboard ab-${f.kind}`;
    ab.dataset.frame = f.key;
    const devClass = f.kind === "catalog" ? "catalog" : dev.device ?? f.s.device;
    const light = f.s.statusBar === "light" ? " light" : "";
    let chrome = "", deco = "";
    if (["desktop", "laptop", "tablet"].includes(devClass)) chrome = `<div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="url">${esc((f.s.address ?? (S.project.name ?? "").toLowerCase() + ".app") + (f.kind === "breakpoint" ? ` · ${f.width}px` : ""))}</span><span></span></div>`;
    if (devClass === "iphone") deco = `<div class="island"></div><div class="statusbar${light}"><span>9:41</span>${ICONS_STATUS}</div><div class="home-indicator${light}"></div>`;
    if (devClass === "android") deco = `<div class="punch"></div><div class="statusbar${light}"><span>9:41</span>${ICONS_STATUS}</div>`;
    const inner = f.kind === "build"
      ? `<img alt="Screenshot of the build" src="/compare/${encodeURIComponent(f.s.id)}/${S.buildMode[f.s.id] === "diff" ? "diff" : "build"}.png?t=${encodeURIComponent(f.report.at)}" width="${dev.width}">`
      : `<iframe title="${esc(f.s.name ?? f.s.id)}" width="${dev.width}" height="${dev.height}" scrolling="${dev.autoHeight ? "no" : "auto"}"></iframe>`;
    ab.innerHTML = `
      <div class="ab-label">${labelFor(f)}</div>
      <div class="device device-${esc(devClass)}${f.kind === "proposal" ? " is-proposal" : ""}${f.removed ? " is-removed" : ""}">
        ${chrome}
        <div class="device-screen" style="width:${dev.width}px;height:${f.kind === "build" ? "auto" : dev.height + "px"}">
          ${inner}
          ${deco}
          <div class="overlay"></div>
        </div>
      </div>`;
    world.appendChild(ab);
    Object.assign(f, { ab, iframe: $("iframe", ab), img: $("img", ab), screenEl: $(".device-screen", ab), overlay: $(".overlay", ab) });
    S.frames.set(f.key, f);
    if (f.iframe) { f.iframe.addEventListener("load", () => onFrameLoad(f)); f.iframe.src = srcFor(f); }
    if (f.img) f.img.addEventListener("load", () => { layout(); drawOverlay(f); });
  }
  layout();
  renderScreens();
}

function layout() {
  // Groups left to right; inside a group, one row per screen (its views side by side), states below.
  const GAP_X = 140, GAP_IN = 72, GAP_Y = 150;
  const groups = new Map();
  for (const f of S.frames.values()) {
    if (!groups.has(f.group)) groups.set(f.group, new Map());
    const rows = groups.get(f.group);
    if (!rows.has(f.row)) rows.set(f.row, []);
    rows.get(f.row).push(f);
  }
  let x = 0;
  for (const rows of groups.values()) {
    let y = 0, gw = 0;
    for (const row of rows.values()) {
      let rx = x, rh = 0;
      for (const f of row) {
        const dv = $(".device", f.ab);
        f.ab.style.left = rx + "px"; f.ab.style.top = y + "px";
        rx += dv.offsetWidth + GAP_IN; rh = Math.max(rh, dv.offsetHeight);
      }
      gw = Math.max(gw, rx - GAP_IN - x);
      y += rh + GAP_Y;
    }
    x += gw + GAP_X;
  }
}

function reloadFrame(f) {
  if (!f.iframe) return;
  f.ready = false;
  f.iframe.src = srcFor(f);
}

function reloadAll(contentChanged = true) {
  const want = frameDefs().map((d) => d.key).join("|");
  const have = [...S.frames.keys()].join("|");
  if (want !== have || S.project.screens.some((s) => S.frames.get(s.id)?.s.device !== s.device)) { buildWorld(); return; }
  for (const f of S.frames.values()) {
    if (f.kind === "screen" || f.kind === "breakpoint") f.s = S.project.screens.find((s) => s.id === f.s.id) ?? f.s;
    if (contentChanged) reloadFrame(f);
  }
  renderScreens();
}

function onFrameLoad(f) {
  const doc = f.iframe.contentDocument;
  if (!doc || !doc.body) return;
  f.doc = doc; f.win = f.iframe.contentWindow; f.tokenCache = null; f.ready = true;
  doc.documentElement.classList.add("dc-" + S.mode);
  if (f.dev.autoHeight) doc.documentElement.dataset.autoHeight = "";
  installForcedStates(doc);
  if (screenKinds(f)) for (const op of [...S.sentOps, ...S.ops]) if (op.screen === f.s.id) applyOpDom(f, op);
  renderOpStyles(f);
  bindFrame(f);
  if (f.dev.autoHeight) {
    const fitH = () => {
      if (!f.doc?.body) return;
      const h = Math.max(f.kind === "catalog" ? 200 : f.dev.height, Math.ceil(doc.body.getBoundingClientRect().height));
      if (Math.abs(h - f.iframe.offsetHeight) > 1) {
        f.iframe.height = h; f.screenEl.style.height = h + "px";
        layout(); drawAll();
      }
    };
    new f.win.ResizeObserver(fitH).observe(doc.body);
    fitH();
    doc.fonts?.ready.then(fitH);
  }
  const mb = $(`[data-play-motion="${CSS.escape(f.key)}"]`, f.ab);
  if (mb) mb.hidden = !doc.querySelector("[data-motion]");
  if (f.kind === "proposal" || (f.kind === "screen" && S.proposal)) diffProposal(f.s.id);
  if (f.kind === "variant") { const t = doc.querySelector(cssq(f.set.target)); f.marks = t ? [{ id: f.set.target, kind: "variant" }] : []; }
  drawOverlay(f);
  scheduleAudit();
  if (S.sel?.frame === f.key) renderPanel();
}

/** Used by the player: replay the user's unsent edits into any document showing a screen. */
export function applyAllOps(doc, screenId) {
  const fake = { doc, win: doc.defaultView, kind: "screen", s: { id: screenId } };
  installForcedStates(doc);
  for (const op of [...S.sentOps, ...S.ops]) if (op.screen === screenId) applyOpDom(fake, op);
  renderOpStyles(fake);
}

// ---------------------------------------------------------------------------------------------
// proposal diff: which elements the proposal adds, removes or changes, by data-id

/** What makes an element itself different: tag, attributes, and text not inside an id'd child. */
function sig(el) {
  const own = [];
  const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) own.push(c.textContent.trim()); else if (c.nodeType === 1 && !c.dataset.id) { own.push(`<${c.tagName}${c.className ? "." + c.className : ""}>`); walk(c); } } };
  walk(el);
  const attrs = [...el.attributes].filter((a) => a.name !== "data-dc-state" && a.name !== "style").map((a) => `${a.name}=${a.value}`).sort().join("&");
  return `${el.tagName}|${attrs}|${own.filter(Boolean).join(" ")}`;
}

function diffProposal(screenId) {
  const cur = S.frames.get(screenId), prop = S.frames.get(`${screenId}+proposal`);
  if (!cur?.doc || !prop?.doc) return;
  const map = (doc) => new Map([...doc.querySelectorAll("[data-id]")].map((el) => [el.dataset.id, el]));
  const a = map(cur.doc), b = map(prop.doc);
  const top = (marks, doc) => marks.filter((m) => { let p = idParentEl(doc.querySelector(cssq(m.id))); while (p) { if (marks.some((x) => x.id === p.dataset.id && x.kind !== "changed")) return false; p = idParentEl(p); } return true; });
  const added = [...b.keys()].filter((id) => !a.has(id)).map((id) => ({ id, kind: "added" }));
  // Reordering or adding children doesn't change a parent: the children carry their own marks.
  const changed = [...b.keys()].filter((id) => a.has(id) && sig(a.get(id)) !== sig(b.get(id))).map((id) => ({ id, kind: "changed" }));
  prop.marks = top([...added, ...changed], prop.doc);
  cur.marks = top([...a.keys()].filter((id) => !b.has(id)).map((id) => ({ id, kind: "removed" })), cur.doc);
  drawOverlay(prop); drawOverlay(cur);
}

// ---------------------------------------------------------------------------------------------
// view: pan & zoom

function applyView(fly = false) {
  const w = $("#world"), c = $("#canvas");
  w.classList.toggle("flying", fly);
  w.style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.k})`;
  w.style.setProperty("--k", S.view.k);
  const g = 22 * S.view.k;
  c.style.backgroundSize = `${g}px ${g}px`;
  c.style.backgroundPosition = `${S.view.x}px ${S.view.y}px`;
  $("#zoom-label").textContent = Math.round(S.view.k * 100) + "%";
  if (fly) setTimeout(() => w.classList.remove("flying"), 600);
}

function zoomAt(k, cx, cy) {
  k = clamp(k, 0.06, 2.5);
  const { x, y, k: k0 } = S.view;
  S.view.x = cx - ((cx - x) * k) / k0;
  S.view.y = cy - ((cy - y) * k) / k0;
  S.view.k = k;
  applyView();
}

/** Bounds of artboards; long scrolling pages count only their first `maxH` px so phones stay legible. */
function boundsOf(els, maxH = Infinity) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const el of els) {
    const x = el.offsetLeft, y = el.offsetTop, dv = $(".device", el) ?? el;
    l = Math.min(l, x); t = Math.min(t, y - 48); r = Math.max(r, x + dv.offsetWidth); b = Math.max(b, y + Math.min(dv.offsetHeight, maxH));
  }
  return { l, t, r, b };
}

function fitBounds({ l, t, r, b }, fly = true, maxK = 1, top = false) {
  const c = $("#canvas").getBoundingClientRect();
  const pad = 56;
  const k = clamp(Math.min((c.width - pad * 2) / (r - l), (c.height - pad * 2) / (b - t)), 0.06, maxK);
  S.view.k = k;
  S.view.x = (c.width - (r - l) * k) / 2 - l * k;
  S.view.y = (top ? pad : Math.max(pad, (c.height - (b - t) * k) / 2)) - t * k;
  applyView(fly);
}

// Fit the base screens and the top of long pages; states and page bottoms are a pan away.
const fit = (fly = true) => fitBounds(boundsOf([...S.frames.values()].filter((f) => f.kind === "screen" && !f.s.of).map((f) => f.ab), 1000), fly, 0.9, true);

function flyToScreen(key) {
  const f = S.frames.get(key);
  if (!f) return;
  const dv = $(".device", f.ab);
  fitBounds({ l: f.ab.offsetLeft, t: f.ab.offsetTop - 48, r: f.ab.offsetLeft + dv.offsetWidth, b: f.ab.offsetTop + Math.min(dv.offsetHeight, 1400) }, true, 1);
}

function flyToRow(key) {
  const f = S.frames.get(key);
  if (!f) return;
  const row = [...S.frames.values()].filter((x) => x.group === f.group && x.row === f.row).map((x) => x.ab);
  fitBounds(boundsOf(row, 1100), true, 0.9);
}

function flyToElement(key, id) {
  const f = S.frames.get(key), el = f && findEl(f, id);
  if (!el) return flyToScreen(key);
  const r = el.getBoundingClientRect();
  const o = screenOrigin(f);
  const c = $("#canvas").getBoundingClientRect();
  const k = clamp(Math.min(S.view.k < 0.4 ? 0.7 : S.view.k, (c.width * 0.6) / r.width, (c.height * 0.6) / r.height), 0.2, 1.2);
  const cxw = o.x + r.left + r.width / 2, cyw = o.y + r.top + r.height / 2;
  S.view.k = k; S.view.x = c.width / 2 - cxw * k; S.view.y = c.height / 2 - cyw * k;
  applyView(true);
}

/** World coordinates of a frame's screen origin. */
function screenOrigin(f) {
  const dv = $(".device", f.ab);
  let x = f.ab.offsetLeft + dv.offsetLeft + f.screenEl.offsetLeft, y = f.ab.offsetTop + dv.offsetTop + f.screenEl.offsetTop;
  const cs = getComputedStyle(dv);
  x += parseFloat(cs.borderLeftWidth) || 0; y += parseFloat(cs.borderTopWidth) || 0;
  return { x, y };
}

function bindCanvas() {
  const c = $("#canvas");
  c.addEventListener("wheel", (e) => { e.preventDefault(); wheel(e.deltaX, e.deltaY, e.ctrlKey || e.metaKey, e.clientX, e.clientY); }, { passive: false });
  let pan = null;
  c.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".pin, .handle, iframe, button, .region")) return;
    if (e.target.closest("[data-fly]")) { flyToScreen(e.target.closest("[data-fly]").dataset.fly); return; }
    pan = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y, moved: false };
    c.setPointerCapture(e.pointerId);
    c.classList.add("panning");
  });
  c.addEventListener("pointermove", (e) => {
    if (!pan) return;
    if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 3) pan.moved = true;
    S.view.x = pan.vx + e.clientX - pan.x; S.view.y = pan.vy + e.clientY - pan.y; applyView();
  });
  c.addEventListener("pointerup", () => {
    if (pan && !pan.moved && S.mode !== "preview") select(null);
    pan = null; c.classList.remove("panning");
  });
  // Buttons on artboard labels and build regions
  c.addEventListener("click", (e) => {
    const b = e.target.closest("button, .region");
    if (!b) return;
    if (b.dataset.pick) { const [set, opt] = b.dataset.pick.split("|"); pickVariant(set, opt); }
    else if (b.dataset.none) dismissVariants(b.dataset.none);
    else if (b.dataset.playMotion) replayMotion(S.frames.get(b.dataset.playMotion));
    else if (b.dataset.buildmode) { const id = b.dataset.buildmode; S.buildMode[id] = S.buildMode[id] === "diff" ? "image" : "diff"; const f = S.frames.get(id + "#build"); if (f) { f.img.src = `/compare/${encodeURIComponent(id)}/${S.buildMode[id] === "diff" ? "diff" : "build"}.png?t=${encodeURIComponent(f.report.at)}`; $(".ab-label", f.ab).innerHTML = labelFor(f); } }
    else if (b.dataset.region) { const [screen, id] = b.dataset.region.split("|"); if (id) { select({ frame: screen, screen, id }); flyToElement(screen, id); } }
  });
  window.addEventListener("resize", () => applyView());
}

function wheel(dx, dy, zoom, clientX, clientY) {
  const c = $("#canvas").getBoundingClientRect();
  if (zoom) zoomAt(S.view.k * Math.exp(-dy * 0.0085), clientX - c.left, clientY - c.top);
  else { S.view.x -= dx; S.view.y -= dy; applyView(); }
}

// ---------------------------------------------------------------------------------------------
// frame events: hover, select, edit text, drag to move

function findEl(f, id) { return f?.doc?.querySelector(cssq(id)) ?? null; }
const idOf = (el) => el?.closest?.("[data-id]") ?? null;
const idParentEl = (el) => el?.parentElement?.closest("[data-id]") ?? null;
function idChildrenEl(c) {
  const out = [];
  const rec = (x) => { for (const ch of x.children) { if (ch.dataset.id) out.push(ch); else rec(ch); } };
  rec(c);
  return out;
}
const toWindow = (f, x, y) => { const r = f.iframe.getBoundingClientRect(); return { x: r.left + x * S.view.k, y: r.top + y * S.view.k }; };
/** In the catalog, the thing you select is the component instance, not its insides. */
const pickTarget = (f, el) => (f.kind === "catalog" ? el?.closest("[data-cat-class]") ?? null : idOf(el));
const selFor = (f, el) => (el ? { frame: f.key, screen: opScreenOf(f), id: el.dataset.id, ...(f.kind === "catalog" ? { cat: el.dataset.catClass, catState: el.dataset.dcState ?? null } : {}) } : null);

function bindFrame(f) {
  const doc = f.doc;
  const editable = isEditable(f);
  doc.addEventListener("keydown", (e) => { if (playerOpen()) { if (playerKey(e)) e.preventDefault(); return; } onKey(e); });
  doc.addEventListener("wheel", (e) => {
    const scroller = f.dev.autoHeight ? null : doc.querySelector(".ios-scroll, .md-scroll") ?? doc.scrollingElement;
    const canScroll = scroller && scroller.scrollHeight > scroller.clientHeight + 1 && !(e.ctrlKey || e.metaKey) && Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    if (canScroll) return;
    e.preventDefault();
    const p = toWindow(f, e.clientX, e.clientY);
    wheel(e.deltaX, e.deltaY, e.ctrlKey || e.metaKey, p.x, p.y);
  }, { passive: false });
  doc.addEventListener("scroll", () => drawOverlay(f), true);
  if (!editable) {
    doc.addEventListener("click", (e) => { if (e.target.closest("a[href], button, [data-goto]")) e.preventDefault(); }, true);
    return;
  }
  doc.addEventListener("mousemove", (e) => {
    if (S.mode === "preview" || drag) return;
    const el = pickTarget(f, e.target);
    const h = el ? { frame: f.key, id: el.dataset.id } : null;
    if (h?.id !== S.hover?.id || h?.frame !== S.hover?.frame) { S.hover = h; drawAll(); }
  });
  doc.addEventListener("mouseleave", () => { if (S.hover) { S.hover = null; drawAll(); } });
  doc.addEventListener("click", (e) => {
    if (editing && editing.el.contains(e.target)) return;
    if (S.mode === "preview") {
      const g = e.target.closest("[data-goto]");
      if (e.target.closest("a[href]") || g) e.preventDefault();
      if (g) { flyToScreen(g.dataset.goto); flash(g.dataset.goto); }
      return;
    }
    e.preventDefault(); e.stopPropagation();
    if (suppressClick) { suppressClick = false; return; }
    const el = pickTarget(f, e.target);
    if (S.mode === "comment") {
      const tgt = el ?? doc.body.firstElementChild;
      const r = tgt.getBoundingClientRect();
      draftComment(f, tgt.dataset?.id ?? null, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, toWindow(f, e.clientX, e.clientY));
      return;
    }
    select(selFor(f, el));
  }, true);
  if (f.kind === "catalog") return; // catalog instances are samples: style them, don't restructure them
  doc.addEventListener("dblclick", (e) => {
    if (S.mode !== "select") return;
    e.preventDefault();
    const el = idOf(e.target);
    if (el && editableText(el)) { select(selFor(f, el)); startEdit(f, el); }
  }, true);
  doc.addEventListener("mousedown", (e) => {
    if (S.mode !== "select" || e.button !== 0 || editing) return;
    const el = idOf(e.target);
    if (!el || S.sel?.frame !== f.key || S.sel.id !== el.dataset.id) return;
    if (!idParentEl(el)) return;
    e.preventDefault();
    pendingDrag = { f, el, x: e.clientX, y: e.clientY };
  }, true);
  doc.addEventListener("mousemove", (e) => {
    if (pendingDrag && !drag && Math.hypot(e.clientX - pendingDrag.x, e.clientY - pendingDrag.y) > 5) beginDrag();
    if (drag) updateDrag(e.clientX, e.clientY, e.altKey);
  });
  doc.addEventListener("mouseup", () => { if (drag) endDrag(); pendingDrag = null; });
}

let pendingDrag = null, drag = null, suppressClick = false;

function beginDrag() {
  const { f, el } = pendingDrag;
  drag = { f, el, from: { parent: idParentEl(el).dataset.id, index: idChildrenEl(idParentEl(el)).indexOf(el) }, target: null };
  el.style.pointerEvents = "none";
  drawOverlay(f);
}

function updateDrag(x, y, into) {
  const { f, el } = drag;
  const hit = f.doc.elementFromPoint(clamp(x, 1, f.dev.width - 1), clamp(y, 1, f.iframe.offsetHeight - 1));
  const home = idParentEl(el);
  let c = idOf(hit);
  // Reorder by default: hovering a sibling targets the shared parent. Alt drops into the hovered element.
  while (c && (c === el || el.contains(c) || (!into && idParentEl(c) === home && c !== home) || (!into && !idChildrenEl(c).some((k) => k !== el) && c !== home))) c = idParentEl(c);
  if (!c) c = home;
  const kids = idChildrenEl(c).filter((k) => k !== el);
  const cs = f.win.getComputedStyle(c.matches("ul,ol") || !kids[0] ? c : kids[0].parentElement);
  const row = cs.display.includes("flex") && cs.flexDirection.startsWith("row") && cs.flexWrap === "nowrap";
  const grid = cs.display.includes("grid") || (cs.display.includes("flex") && cs.flexWrap !== "nowrap" && cs.flexDirection.startsWith("row"));
  let index = kids.length;
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    const before = row ? x < r.left + r.width / 2 : grid ? y < r.top || (y <= r.bottom && x < r.left + r.width / 2) : y < r.top + r.height / 2;
    if (before) { index = i; break; }
  }
  drag.target = { container: c, index, kids, horizontal: row || (grid && kids.length > 1 && Math.abs(kids[0].getBoundingClientRect().top - kids[1].getBoundingClientRect().top) < 4) };
  drawOverlay(f);
}

function endDrag() {
  const { f, el, from, target } = drag;
  el.style.pointerEvents = "";
  drag = null; pendingDrag = null; suppressClick = true;
  setTimeout(() => (suppressClick = false), 50);
  if (!target) return drawOverlay(f);
  const parent = target.container.dataset.id;
  if (parent === from.parent && target.index === from.index) return drawOverlay(f);
  addOp({ op: "move", screen: f.s.id, id: el.dataset.id, parent, index: target.index, before: from });
}

function moveBy(delta) {
  const f = selFrame(), el = selEl();
  if (!el || !screenKinds(f)) return;
  const p = idParentEl(el);
  if (!p) return;
  const sibs = idChildrenEl(p);
  const i = sibs.indexOf(el);
  const j = clamp(i + delta, 0, sibs.length - 1);
  if (j === i) return;
  addOp({ op: "move", screen: f.s.id, id: el.dataset.id, parent: p.dataset.id, index: j, before: { parent: p.dataset.id, index: i } });
}

// inline text editing
let editing = null;
const INLINE = new Set(["BR", "EM", "STRONG", "B", "I", "SMALL", "SPAN"]);
function editableText(el) {
  if (!el.textContent.trim()) return false;
  return [...el.children].every((c) => INLINE.has(c.tagName) && !c.dataset.id && !c.querySelector("[data-id]"));
}
function startEdit(f, el) {
  editing = { f, el, before: el.textContent };
  el.contentEditable = "plaintext-only";
  f.doc.documentElement.classList.add("dc-editing");
  el.focus();
  const range = f.doc.createRange(); range.selectNodeContents(el);
  const sel = f.win.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  el.addEventListener("blur", () => endEdit(true), { once: true });
  el.addEventListener("input", () => drawOverlay(f));
}
function endEdit(commit) {
  if (!editing) return;
  const { f, el, before } = editing;
  editing = null;
  el.removeAttribute("contenteditable");
  f.doc.documentElement.classList.remove("dc-editing");
  const after = el.textContent;
  if (!commit) { el.textContent = before; drawOverlay(f); return; }
  if (after !== before) addOp({ op: "text", screen: f.s.id, id: el.dataset.id, value: after.trim(), before });
}

// resize handles (live in the parent document; a shield keeps events away from iframes)
function startResize(e, dir) {
  e.preventDefault(); e.stopPropagation();
  const f = selFrame(), el = selEl();
  if (!el) return;
  const r0 = el.getBoundingClientRect();
  const sx = e.clientX, sy = e.clientY;
  const shield = $("#shield");
  shield.classList.add("on");
  shield.style.cursor = dir === "e" ? "ew-resize" : dir === "s" ? "ns-resize" : "nwse-resize";
  let last = null;
  const move = (ev) => {
    const dx = (ev.clientX - sx) / S.view.k, dy = (ev.clientY - sy) / S.view.k;
    last = {};
    if (dir !== "s") { last.width = Math.max(8, snap(r0.width + dx)); el.style.setProperty("width", last.width + "px", "important"); el.style.setProperty("max-width", "none", "important"); }
    if (dir !== "e") { last.height = Math.max(8, snap(r0.height + dy)); el.style.setProperty("height", last.height + "px", "important"); }
    drawOverlay(f);
  };
  const up = () => {
    shield.classList.remove("on");
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    for (const p of ["width", "height", "max-width"]) el.style.removeProperty(p);
    if (last) addOp(scoped(f, { op: "resize", ...last, before: { width: Math.round(r0.width), height: Math.round(r0.height) } }));
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------------------------------------
// ops

const STYLE_OPS = new Set(["style", "resize"]);

/** Tag a style-like op with where it applies: a component, an interaction state, a breakpoint. */
function scoped(f, op) {
  op.screen = opScreenOf(f);
  op.id = S.sel.id;
  if (S.sel.cat) { op.component = S.sel.cat; if (S.sel.catState) op.state = S.sel.catState; }
  else if (S.forced?.frame === f.key && S.forced.id === S.sel.id && S.forced.state) op.state = S.forced.state;
  if (f.kind === "breakpoint") op.viewport = f.width;
  return op;
}

function describe(op) {
  const where = [op.component ? `.${op.component}` : "", op.state ? `:${op.state}` : "", op.viewport ? `≤${op.viewport}px` : ""].filter(Boolean).join(" ");
  const w = where ? ` (${where})` : "";
  switch (op.op) {
    case "text": return ["Text", `“${op.value}”`];
    case "style": return ["Style", `${op.prop}: ${op.token ? "--" + op.token : op.value}${w}`];
    case "resize": return ["Resize", ([op.width !== undefined ? `w ${op.width ?? "auto"}` : "", op.height !== undefined ? `h ${op.height ?? "auto"}` : ""].filter(Boolean).join(" · ") || "auto") + w];
    case "move": return ["Move", `to ${op.parent} #${op.index + 1}`];
    case "remove": return ["Delete", op.label ? `“${op.label}”` : ""];
    case "duplicate": return ["Duplicate", `→ ${op.id}${op.suffix}`];
    case "sketch": return ["Sketch", op.note];
    case "attr": return ["Motion", Object.entries(op.attrs).map(([k, v]) => `${k.replace(/^data-/, "")}: ${v ?? "none"}`).join(", ")];
    case "pick-variant": return ["Variant", `${op.label ?? op.option} for ${op.id}`];
  }
  return [op.op, ""];
}

const sameTarget = (a, b) => a.screen === b.screen && a.id === b.id && (a.component ?? null) === (b.component ?? null) && (a.state ?? null) === (b.state ?? null) && (a.viewport ?? null) === (b.viewport ?? null);

function addOp(op) {
  // Coalesce repeated edits of the same thing; keep the first `before`.
  const same = S.ops.findIndex((o) => o.op === op.op && sameTarget(o, op) && (op.op === "text" || op.op === "resize" || op.op === "attr" || (op.op === "style" && o.prop === op.prop)));
  if (same >= 0 && op.op !== "move") {
    const prev = S.ops[same];
    op.before = prev.before;
    if (op.op === "attr") { op.attrs = { ...prev.attrs, ...op.attrs }; op.before = { ...op.before, ...Object.fromEntries(Object.keys(op.attrs).filter((k) => !(k in (prev.before ?? {}))).map((k) => [k, op.before?.[k] ?? null])) }; }
    if (op.op === "resize") { if (prev.width !== undefined && op.width === undefined) op.width = prev.width; if (prev.height !== undefined && op.height === undefined) op.height = prev.height; }
    S.ops.splice(same, 1);
    if (op.op === "text" && op.value === op.before) { applyOpEverywhere({ ...op }); afterOps(); return; }
  }
  // Successive moves of one element are one move; moving it back where it started is no move.
  const last = S.ops.at(-1);
  if (op.op === "move" && last?.op === "move" && last.screen === op.screen && last.id === op.id) {
    op.before = last.before;
    S.ops.pop();
    applyOpEverywhere(op);
    if (!(op.before.parent === op.parent && op.before.index === op.index)) S.ops.push(op);
    afterOps();
    return;
  }
  S.ops.push(op);
  applyOpEverywhere(op);
  if (op.op === "remove" && S.sel?.id === op.id) S.sel = null;
  afterOps();
}

function applyOpEverywhere(op) {
  if (STYLE_OPS.has(op.op)) { for (const f of S.frames.values()) if (f.doc) renderOpStyles(f); return; }
  for (const f of framesOfScreen(op.screen)) applyOpDom(f, op);
  if (op.op === "pick-variant") for (const f of framesOfScreen(op.screen)) renderOpStyles(f);
}

function afterOps() {
  render();
  drawAll();
  scheduleAudit();
}

function undoOp(i) {
  const [op] = S.ops.splice(i, 1);
  if (!op) return;
  if (op.op === "pick-variant") { filterVariants(); buildWorld(); render(); return; } // the variant set comes back
  if (STYLE_OPS.has(op.op)) { for (const f of S.frames.values()) if (f.doc) renderOpStyles(f); }
  else for (const f of framesOfScreen(op.screen)) reloadFrame(f);
  render(); drawAll();
}

function applyOpDom(f, op) {
  const doc = f.doc;
  if (!doc) return;
  const el = op.id ? doc.querySelector(cssq(op.id)) : null;
  const insertAt = (node, parentId, index) => {
    const c = doc.querySelector(cssq(parentId));
    if (!c) return;
    const kids = idChildrenEl(c).filter((k) => k !== node);
    if (index < kids.length) kids[index].before(node);
    else if (kids.length) kids.at(-1).after(node);
    else c.appendChild(node);
  };
  switch (op.op) {
    case "text": if (el) el.textContent = op.value; break;
    case "move": if (el) insertAt(el, op.parent, op.index); break;
    case "remove": el?.remove(); break;
    case "duplicate": {
      if (!el) break;
      const c = el.cloneNode(true);
      for (const n of [c, ...c.querySelectorAll("[data-id]")]) n.dataset.id += op.suffix;
      el.after(c);
      break;
    }
    case "sketch": {
      const n = doc.createElement("div");
      n.dataset.id = op.newId; n.dataset.sketch = ""; n.textContent = op.note;
      insertAt(n, op.parent, op.index);
      break;
    }
    case "attr":
      if (!el) break;
      for (const [k, v] of Object.entries(op.attrs)) v === null ? el.removeAttribute(k) : el.setAttribute(k, v);
      break;
    case "pick-variant": {
      if (!el || !op.html) break;
      const t = doc.createElement("template");
      t.innerHTML = op.html.trim();
      const node = t.content.firstElementChild;
      if (node) el.replaceWith(node);
      break;
    }
  }
}

/** Style-like ops as real CSS: id or component selector, state pseudo-class, breakpoint media query. */
function opRules(f) {
  const out = [];
  for (const o of [...S.sentOps, ...S.ops]) {
    if (o.op === "pick-variant") { if (screenKinds(f) && o.screen === f.s.id && o.css) out.push(o.css); continue; }
    if (!STYLE_OPS.has(o.op)) continue;
    let sel;
    if (o.component) sel = `.${CSS.escape(o.component)}`;
    else if (screenKinds(f) && o.screen === f.s.id) sel = cssq(o.id);
    else continue;
    let decl = "";
    if (o.op === "style") decl = `${o.prop}: ${o.value} !important;`;
    else {
      if (o.width !== undefined) decl += o.width === null ? "width: auto !important; " : `width: ${o.width}px !important; max-width: none !important; `;
      if (o.height !== undefined) decl += o.height === null ? "height: auto !important;" : `height: ${o.height}px !important;`;
    }
    let rule = `${stateSelector(sel, o.state)} { ${decl} }`;
    if (o.viewport) rule = `@media (max-width: ${o.viewport}px) { ${rule} }`;
    out.push(rule);
  }
  return out.join("\n");
}

function renderOpStyles(f) {
  const doc = f.doc;
  if (!doc?.head) return;
  let el = doc.getElementById("dc-ops");
  if (!el) { el = doc.createElement("style"); el.id = "dc-ops"; doc.head.appendChild(el); }
  const css = opRules(f);
  if (el.textContent !== css) { el.textContent = css; installForcedStates(doc); }
  f.tokenCache = null;
}

function uniqueId(f, base) {
  let k = 2;
  while (f.doc.querySelector(cssq(base + "-" + k)) || S.ops.some((o) => o.newId === base + "-" + k)) k++;
  return base + "-" + k;
}

// ---------------------------------------------------------------------------------------------
// selection, forced states & overlay

const selFrame = () => (S.sel ? S.frames.get(S.sel.frame) : null);
const selEl = () => { const f = selFrame(); return f ? findEl(f, S.sel.id) : null; };

function setForced(state) {
  const prev = S.forced;
  if (prev) { const pf = S.frames.get(prev.frame); const pe = findEl(pf, prev.id); if (pe) { pe.removeAttribute("data-dc-state"); if (prev.state === "disabled" && !pe.dataset.dcWasDisabled) pe.removeAttribute("aria-disabled"); } }
  S.forced = null;
  const f = selFrame(), el = selEl();
  if (!state || !el || S.sel?.cat) return;
  el.setAttribute("data-dc-state", state);
  if (state === "disabled") el.setAttribute("aria-disabled", "true");
  S.forced = { frame: f.key, id: S.sel.id, state };
}

function select(sel) {
  if (editing) endEdit(true);
  setForced(null);
  S.sel = sel;
  if (sel) S.tab = "inspect";
  render();
  drawAll();
}

function drawAll() { for (const f of S.frames.values()) drawOverlay(f); }

function box(r, cls, extra = "") {
  return `<div class="ov-box ${cls}" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px">${extra}</div>`;
}

function drawOverlay(f) {
  if (f.kind === "build") return drawBuildOverlay(f);
  if (!f.doc) return;
  let html = "";
  if (S.mode !== "preview") {
    if (S.hover?.frame === f.key && S.hover.id !== S.sel?.id && !drag) {
      const el = findEl(f, S.hover.id);
      if (el) html += box(el.getBoundingClientRect(), "ov-hover", `<span class="tag">${esc(el.dataset.catClass ? "." + el.dataset.catClass : S.hover.id)}</span>`);
    }
    if (S.sel?.frame === f.key) {
      const el = findEl(f, S.sel.id);
      if (el) {
        const r = el.getBoundingClientRect();
        const canMove = screenKinds(f) && idParentEl(el);
        const handles = S.mode === "select" && !editing
          ? `${canMove ? '<i class="handle grip" data-grip title="Drag to move (or ⌥↑ / ⌥↓)"></i>' : ""}<i class="handle e" data-h="e"></i><i class="handle s" data-h="s"></i><i class="handle se" data-h="se"></i>` : "";
        const name = S.sel.cat ? `.${S.sel.cat}${S.sel.catState ? ":" + S.sel.catState : ""}` : S.sel.id;
        html += box(r, "ov-sel" + (drag ? " drag-src" : ""), `<span class="tag">${esc(name)}${S.forced?.frame === f.key ? ` :${S.forced.state}` : ""} · ${Math.round(r.width)}×${Math.round(r.height)}</span>${handles}`);
      }
    } else if (S.sel && !S.sel.cat && f.kind !== "catalog" && screenKinds(f) && f.s.id === S.sel.screen) {
      // the same element in the screen's other widths
      const el = findEl(f, S.sel.id);
      if (el) html += box(el.getBoundingClientRect(), "ov-echo");
    }
    if (drag?.target && drag.f === f) {
      const { container, index, kids, horizontal } = drag.target;
      html += box(container.getBoundingClientRect(), "ov-container");
      let line;
      if (!kids.length) { const r = container.getBoundingClientRect(); line = { left: r.left + 4, top: r.top + 4, width: r.width - 8, height: 3 }; }
      else {
        const ref = kids[Math.min(index, kids.length - 1)].getBoundingClientRect();
        const after = index >= kids.length;
        line = horizontal
          ? { left: (after ? ref.right + 2 : ref.left - 4), top: ref.top, width: 3, height: ref.height }
          : { left: ref.left, top: (after ? ref.bottom + 2 : ref.top - 4), width: ref.width, height: 3 };
      }
      html += `<div class="ov-drop" style="left:${line.left}px;top:${line.top}px;width:${line.width}px;height:${line.height}px"></div>`;
    }
    if (S.audit.highlight?.frame === f.key) {
      const el = findEl(f, S.audit.highlight.id);
      if (el) html += box(el.getBoundingClientRect(), "ov-issue");
    }
  }
  for (const m of f.marks ?? []) {
    const el = findEl(f, m.id);
    if (el) html += box(el.getBoundingClientRect(), `ov-mark ${m.kind}`, m.kind === "variant" ? "" : `<span class="mtag">${m.kind}</span>`);
  }
  if (f.kind === "screen" && S.show.build && S.tab === "build") {
    const rep = S.compare.find((r) => r.screen === f.s.id);
    for (const [i, r] of findingsOf(rep).entries()) html += regionBox(r, i, f.s.id);
  }
  if (f.flash) html += box({ left: 0, top: 0, width: f.dev.width, height: f.iframe.offsetHeight }, "ov-flash");
  html += pinsFor(f);
  f.overlay.innerHTML = html;
  for (const h of $$("[data-h]", f.overlay)) h.addEventListener("pointerdown", (e) => startResize(e, h.dataset.h));
  const grip = $("[data-grip]", f.overlay);
  if (grip) grip.addEventListener("pointerdown", (e) => gripDrag(e, f));
  for (const p of $$(".pin", f.overlay)) p.addEventListener("click", (e) => { e.stopPropagation(); openThread(p.dataset.thread, p.dataset.draft); });
}

/** One list for both comparison modes: element findings (build has ids) or pixel regions (it doesn't). */
function findingsOf(rep) {
  if (!rep) return [];
  if (rep.mode === "elements") return rep.elements ?? [];
  return (rep.regions ?? []).map((r) => ({ id: r.ids?.[0] ?? null, kind: "area", detail: `${r.w}×${r.h} area differs${r.ids?.length ? "" : " (no element under it)"}`, x: r.x, y: r.y, w: r.w, h: r.h }));
}
const matchLine = (rep) => (rep.mode === "elements" ? `${rep.total - new Set((rep.elements ?? []).map((x) => x.id)).size}/${rep.total} elements match` : `${(rep.mismatch * 100).toFixed(1)}% of pixels differ`);

const regionBox = (r, i, screen, onBuild = false) => {
  const x = onBuild ? r.bx ?? r.x : r.x, y = onBuild ? r.by ?? r.y : r.y, w = onBuild ? r.bw ?? r.w : r.w, h = onBuild ? r.bh ?? r.h : r.h;
  if (onBuild && r.kind === "missing") return "";
  return `<button class="region k-${esc(r.kind)}" data-region="${esc(screen)}|${esc(r.id ?? "")}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px" title="${esc(`${r.id ?? ""} ${r.detail}`)}"><span>${i + 1}</span></button>`;
};

function drawBuildOverlay(f) {
  f.overlay.innerHTML = findingsOf(f.report).map((r, i) => regionBox(r, i, f.s.id, true)).join("");
}

// Dragging by the grip starts in the parent document, so map pointer coords into the frame.
function gripDrag(e, f) {
  e.preventDefault(); e.stopPropagation();
  const el = selEl();
  if (!el) return;
  pendingDrag = { f, el, x: 0, y: 0 };
  beginDrag();
  const shield = $("#shield");
  shield.classList.add("on"); shield.style.cursor = "grabbing";
  const local = (ev) => { const r = f.iframe.getBoundingClientRect(); return [(ev.clientX - r.left) / S.view.k, (ev.clientY - r.top) / S.view.k]; };
  const move = (ev) => updateDrag(...local(ev), ev.altKey);
  const up = () => { shield.classList.remove("on"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); endDrag(); suppressClick = false; };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

function flash(key) {
  const f = S.frames.get(key);
  if (!f) return;
  f.flash = true; drawOverlay(f);
  setTimeout(() => { f.flash = false; drawOverlay(f); }, 1900);
}

function replayMotion(f, el) {
  if (!f?.doc) return;
  const anims = el ? el.getAnimations({ subtree: true }) : f.doc.getAnimations();
  for (const a of anims) { a.cancel(); a.play(); }
}

// ---------------------------------------------------------------------------------------------
// variants

function pickVariant(setId, optId) {
  const set = S.variants.find((v) => v.id === setId);
  const o = set?.options.find((x) => x.id === optId);
  if (!o) return;
  addOp({ op: "pick-variant", screen: set.screen, id: set.target, set: set.id, option: o.id, label: o.label, html: o.html, css: o.css ?? "" });
  filterVariants();
  buildWorld();
  select({ frame: set.screen, screen: set.screen, id: set.target });
  flyToScreen(set.screen);
  toast(`Picked ${o.label ?? o.id}. Send to make it real; undo it in Changes.`);
}

function dismissVariants(setId) {
  const set = S.variants.find((v) => v.id === setId);
  const f = S.frames.get(`${set.screen}~${set.id}~${set.options[0].id}`);
  const r = f?.ab.getBoundingClientRect() ?? { left: innerWidth / 2, top: innerHeight / 2 };
  const p = popover(`<h4><span>None of these</span></h4><textarea placeholder="What's missing? (optional) e.g. “all too busy, try one with no card”"></textarea>
    <div class="foot"><button class="btn-s" data-x>Cancel</button><button class="btn-s go" data-ok>Dismiss variants</button></div>`, { x: r.left, y: r.top });
  $("[data-x]", p).onclick = closePopover;
  $("[data-ok]", p).onclick = () => {
    S.dismissed.push({ set: setId, note: $("textarea", p).value.trim() || undefined });
    filterVariants();
    closePopover(); buildWorld(); render();
  };
}

function askVariants() {
  const f = selFrame(), el = selEl();
  if (!el) return;
  const r = el.getBoundingClientRect();
  const p = popover(`<h4><span>Variants of <span class="mono">${esc(S.sel.id)}</span></span></h4>
    <textarea placeholder="Direction for the agent (optional) e.g. “calmer”, “more data-dense”, “no card”"></textarea>
    <div class="row" style="margin-top:8px"><label style="width:auto;margin-right:6px">How many</label><div class="chips">${[2, 3, 4].map((n) => `<button class="tok" data-n="${n}" aria-pressed="${n === 3}">${n}</button>`).join("")}</div></div>
    <div class="foot"><span class="muted">Sends now, with your other edits</span><button class="btn-s" data-x>Cancel</button><button class="btn-s go" data-ok>Ask</button></div>`, toWindow(f, r.right, r.top));
  let n = 3;
  for (const b of $$("[data-n]", p)) b.onclick = () => { n = +b.dataset.n; for (const x of $$("[data-n]", p)) x.setAttribute("aria-pressed", String(x === b)); };
  $("[data-x]", p).onclick = closePopover;
  $("[data-ok]", p).onclick = () => { closePopover(); requestNow({ type: "variants", screen: f.s.id, id: S.sel.id, prompt: $("textarea", p).value.trim() || undefined, count: n }, `Asked for ${n} variants of ${S.sel.id}.`); };
}

// ---------------------------------------------------------------------------------------------
// comments

function pinPos(f, target, x, y) {
  const el = target ? findEl(f, target) : null;
  if (!el) return { left: f.dev.width - 40, top: 40 };
  const r = el.getBoundingClientRect();
  return { left: r.left + r.width * clamp(x, 0, 1), top: r.top + r.height * clamp(y, 0, 1) };
}

function pinsFor(f) {
  if (f.kind !== "screen" && f.kind !== "catalog") return "";
  let html = "";
  const list = S.threads.filter((t) => t.screen === f.s.id && (t.status === "open" || S.showResolved));
  for (const t of list) {
    const p = pinPos(f, t.target, t.x, t.y);
    const last = t.messages.at(-1)?.by;
    const cls = t.status === "resolved" ? "resolved" : last === "agent" ? "agent" : "waiting";
    html += `<button class="pin ${cls}" data-thread="${esc(t.id)}" style="left:${p.left}px;top:${p.top}px" title="${esc(t.messages[0]?.text)}">${esc(t.id.replace(/^c/, ""))}</button>`;
  }
  S.drafts.forEach((d, i) => {
    if (d.screen !== f.s.id) return;
    const p = pinPos(f, d.target, d.x, d.y);
    html += `<button class="pin draft" data-draft="${i}" style="left:${p.left}px;top:${p.top}px" title="${esc(d.text)}">+</button>`;
  });
  return html;
}

function popover(html, at) {
  const p = $("#popover");
  p.innerHTML = html;
  p.classList.add("on");
  const w = p.offsetWidth, hgt = p.offsetHeight;
  p.style.left = clamp(at.x + 14, 8, innerWidth - w - 8) + "px";
  p.style.top = clamp(at.y - 20, 56, innerHeight - hgt - 8) + "px";
  $("textarea", p)?.focus();
  return p;
}
const closePopover = () => $("#popover").classList.remove("on");

function draftComment(f, target, x, y, at) {
  const where = f.kind === "breakpoint" ? `(at ${f.width}px) ` : "";
  const p = popover(`<h4><span>Comment on <span class="mono">${esc(target ?? f.s.id)}</span>${where ? ` <span class="muted">${f.width}px</span>` : ""}</span></h4>
    <textarea placeholder="Ask a question or describe a change…"></textarea>
    <div class="foot"><span class="muted">⌘↩ to add</span><button class="btn-s" data-x>Cancel</button><button class="btn-s go" data-ok>Add</button></div>`, at);
  const ok = () => {
    const text = $("textarea", p).value.trim();
    if (!text) return;
    S.drafts.push({ screen: f.s.id, target, x, y, text: where + text });
    closePopover(); render(); drawAll();
  };
  $("[data-ok]", p).onclick = ok;
  $("[data-x]", p).onclick = closePopover;
  $("textarea", p).onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ok(); if (e.key === "Escape") closePopover(); };
}

function openThread(id, draftIdx) {
  const pinEl = $(`.pin[data-${id ? "thread" : "draft"}="${id ?? draftIdx}"]`);
  const r = pinEl?.getBoundingClientRect() ?? { right: innerWidth / 2, top: innerHeight / 2 };
  const at = { x: r.right, y: r.top };
  if (draftIdx !== undefined && !id) {
    const d = S.drafts[draftIdx];
    const p = popover(`<h4><span>Not sent yet · <span class="mono">${esc(d.target ?? d.screen)}</span></span></h4><div class="msg pending">${esc(d.text)}</div>
      <div class="foot"><button class="btn-s" data-del>Delete</button><button class="btn-s" data-x>Close</button></div>`, at);
    $("[data-del]", p).onclick = () => { S.drafts.splice(draftIdx, 1); closePopover(); render(); drawAll(); };
    $("[data-x]", p).onclick = closePopover;
    return;
  }
  const t = S.threads.find((x) => x.id === id);
  if (!t) return;
  const pend = S.replies.filter((x) => x.thread === id);
  const msgs = t.messages.map((m) => `<div class="msg ${m.by}"><div class="by">${m.by === "agent" ? "Agent" : "You"}</div>${esc(m.text)}</div>`).join("")
    + pend.filter((x) => x.text).map((x) => `<div class="msg pending"><div class="by">You · not sent</div>${esc(x.text)}</div>`).join("");
  const p = popover(`<h4><span>${esc(t.id)} · <span class="mono">${esc(t.target ?? t.screen)}</span></span><span class="muted">${t.status}</span></h4>${msgs}
    <textarea placeholder="Reply…" style="min-height:56px"></textarea>
    <div class="foot"><button class="btn-s" data-res>${t.status === "resolved" ? "Close" : "Resolve"}</button><button class="btn-s go" data-ok>Reply</button></div>`, at);
  const ok = () => {
    const text = $("textarea", p).value.trim();
    if (!text) return;
    S.replies.push({ thread: id, text });
    closePopover(); render();
  };
  $("[data-ok]", p).onclick = ok;
  $("[data-res]", p).onclick = () => { if (t.status !== "resolved") { S.replies.push({ thread: id, resolve: true, text: $("textarea", p).value.trim() || undefined }); t.status = "resolved"; } closePopover(); render(); drawAll(); };
  $("textarea", p).onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ok(); if (e.key === "Escape") closePopover(); };
}

// ---------------------------------------------------------------------------------------------
// tokens: resolved per frame (so dark-mode or platform overrides are respected)

const cv = document.createElement("canvas"); cv.width = cv.height = 1;
const cx = cv.getContext("2d", { willReadFrequently: true });
const rgbaCache = new Map();
function rgba(str) {
  if (rgbaCache.has(str)) return rgbaCache.get(str);
  cx.clearRect(0, 0, 1, 1); cx.fillStyle = "rgba(0,0,0,0)"; cx.fillStyle = str; cx.fillRect(0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data;
  const v = [d[0], d[1], d[2], d[3] / 255];
  rgbaCache.set(str, v);
  return v;
}
const ckey = (c) => (c[3] < 0.02 ? "transparent" : `${c[0]},${c[1]},${c[2]},${c[3].toFixed(2)}`);
const tokensIn = (g) => S.tokens.filter((t) => t.group === g);

function tokenValues(f) {
  if (f.tokenCache) return f.tokenCache;
  const doc = f.doc, win = f.win;
  const probe = doc.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0";
  doc.body.appendChild(probe);
  const out = { color: new Map(), text: new Map(), space: new Map(), radius: new Map(), weight: new Map() };
  const read = (prop, val) => { probe.style.setProperty(prop, val); const v = win.getComputedStyle(probe).getPropertyValue(prop); probe.style.removeProperty(prop); return v; };
  for (const t of tokensIn("color")) out.color.set(t.name, ckey(rgba(read("color", `var(--${t.name})`))));
  for (const t of tokensIn("text")) out.text.set(t.name, parseFloat(read("font-size", `var(--${t.name})`)));
  for (const t of tokensIn("space")) out.space.set(t.name, parseFloat(read("width", `var(--${t.name})`)));
  for (const t of tokensIn("radius")) out.radius.set(t.name, parseFloat(read("border-top-left-radius", `var(--${t.name})`)));
  for (const t of tokensIn("weight")) out.weight.set(t.name, parseFloat(read("font-weight", `var(--${t.name})`)));
  probe.remove();
  f.tokenCache = out;
  return out;
}

/** A color token as the screens resolve it (tokens may reference other tokens). */
function colorOf(t) {
  const f = [...S.frames.values()].find((x) => x.ready && x.doc?.body && x.kind === "screen");
  const k = f && tokenValues(f).color.get(t.name);
  if (!k) return t.value;
  if (k === "transparent") return "transparent";
  const [r, g, b, a] = k.split(",");
  return `rgba(${r},${g},${b},${a})`;
}

const near = (a, b) => Math.abs(a - b) < 0.6;
function tokenFor(map, val, isColor = false) {
  for (const [n, v] of map) if (isColor ? v === val : near(v, val)) return n;
  return null;
}

// ---------------------------------------------------------------------------------------------
// audit: runtime checks the static lint can't do

let auditTimer = null;
function scheduleAudit() { clearTimeout(auditTimer); auditTimer = setTimeout(runAudit, 350); }

function lum([r, g, b]) {
  const c = [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const blend = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };

function effectiveBg(win, el) {
  const layers = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = win.getComputedStyle(n);
    if (cs.backgroundImage !== "none") return null;
    const c = rgba(cs.backgroundColor);
    if (c[3] > 0.02) { layers.push(c); if (c[3] > 0.98) break; }
  }
  let base = [255, 255, 255, 1];
  for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
  return base;
}

const KIT = /^(ios|md)-/;
// Kit components follow the platform's own metrics (a 32pt segmented control, a 51×31 switch), so
// they're exempt from scale and tap checks; the project's own components are not.
const isKit = (el) => [el, el.parentElement].some((n) => n && [...n.classList].some((c) => KIT.test(c)));
/** Safe-area insets of this device, so `calc(var(--safe-bottom) + var(--space-4))` counts as on-scale. */
function insets(f) {
  const cs = f.win.getComputedStyle(f.doc.documentElement);
  return [0, parseFloat(cs.getPropertyValue("--safe-top")) || 0, parseFloat(cs.getPropertyValue("--safe-bottom")) || 0];
}
const secs = (v) => Math.max(0, ...String(v).split(",").map((x) => (x.trim().endsWith("ms") ? parseFloat(x) / 1000 : parseFloat(x) || 0)));
const LAYOUT_PROP = /^(width|height|top|left|right|bottom|margin|padding|max-height|min-height|inset)/;

function runAudit() {
  const issues = [];
  const used = { text: new Map(), color: new Map(), space: new Map(), radius: new Map() };
  const bump = (m, k, off) => { const e = m.get(k) ?? { n: 0, off }; e.n++; m.set(k, e); };
  for (const f of S.frames.values()) {
    if (!f.ready || !f.doc?.body || !screenKinds(f)) continue;
    const win = f.win, tv = tokenValues(f);
    const ins = insets(f);
    const onSpace = (v) => ins.some((i) => (i === 0 ? tokenFor(tv.space, v) : near(v, i) || tokenFor(tv.space, v - i)));
    const seen = new Set();
    const at = f.kind === "breakpoint" ? ` at ${f.width}px` : "";
    const add = (el, kind, sev, msg) => {
      const id = idOf(el)?.dataset.id ?? null;
      const key = `${id}|${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push({ frame: f.key, screen: f.s.id, id, kind, sev, msg: msg + at });
    };
    for (const el of f.doc.body.querySelectorAll("*")) {
      if (el.closest("[data-sketch], svg, script, style, template")) continue;
      const cs = win.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const kit = isKit(el);
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (hasText) {
        const size = parseFloat(cs.fontSize);
        const tok = tokenFor(tv.text, size);
        if (!kit) bump(used.text, size, !tok);
        if (!tok && !kit && tv.text.size) add(el, "type", "warn", `Off-scale font size ${size}px`);
        const fg = rgba(cs.color);
        const ctok = tokenFor(tv.color, ckey(fg), true);
        bump(used.color, cs.color, !ctok);
        if (!ctok && tv.color.size) add(el, "color", "warn", `Text color isn't a token (${cs.color})`);
        const bg = effectiveBg(win, el);
        if (bg) {
          const fgc = fg[3] < 1 ? blend(fg, bg) : fg;
          const L1 = lum(fgc), L2 = lum(bg);
          const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
          const large = size >= 24 || (size >= 18.66 && parseFloat(cs.fontWeight) >= 700);
          const need = large ? 3 : 4.5;
          if (ratio < need) add(el, "contrast", ratio < need - 1 ? "error" : "warn", `Contrast ${ratio.toFixed(2)}:1, needs ${need}:1 (WCAG AA${large ? ", large text" : ""})`);
        }
      }
      const bgc = rgba(cs.backgroundColor);
      if (bgc[3] > 0.02 && cs.backgroundImage === "none") {
        const t = tokenFor(tv.color, ckey(bgc), true);
        bump(used.color, cs.backgroundColor, !t);
        if (!t && !kit && tv.color.size) add(el, "fill", "warn", `Fill isn't a token (${cs.backgroundColor})`);
      }
      if (!kit) {
        for (const p of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"]) {
          const v = parseFloat(cs[p]);
          if (!(v > 2.5)) continue;
          const t = onSpace(v);
          bump(used.space, v, !t);
          if (!t && tv.space.size) { add(el, "space", "warn", `Off-scale ${p.replace(/[A-Z]/, (m) => "-" + m.toLowerCase())} ${v}px`); break; }
        }
        const rad = parseFloat(cs.borderTopLeftRadius);
        if (rad > 0.5 && rad < 900 && !cs.borderTopLeftRadius.includes("%")) {
          const t = tokenFor(tv.radius, rad);
          bump(used.radius, rad, !t);
          if (!t && tv.radius.size) add(el, "radius", "warn", `Off-scale radius ${rad}px`);
        }
      }
      // motion
      if (secs(cs.transitionDuration) > 0) {
        const props = cs.transitionProperty.split(",").map((x) => x.trim());
        if (props.includes("all")) add(el, "motion", "warn", "transition: all. Name the properties (transform, opacity, color)");
        else if (props.some((x) => LAYOUT_PROP.test(x))) add(el, "motion", "warn", `Transitions a layout property (${props.find((x) => LAYOUT_PROP.test(x))}). Use transform/opacity`);
        if (secs(cs.transitionDuration) > 0.6) add(el, "motion", "warn", `Transition of ${Math.round(secs(cs.transitionDuration) * 1000)}ms feels sluggish for UI`);
      }
      if (cs.animationName !== "none" && secs(cs.animationDuration) + secs(cs.animationDelay) > 1.2) add(el, "motion", "warn", `Entrance finishes after ${Math.round((secs(cs.animationDuration) + secs(cs.animationDelay)) * 1000)}ms. Shorten it or the stagger`);
      if (f.dev.phone && !kit && el.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=switch], [data-goto]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.width < 43.5 || r.height < 43.5)) add(el, "tap", "warn", `Tap target ${Math.round(r.width)}×${Math.round(r.height)}, under 44×44`);
      }
      if (el.tagName === "IMG" && !el.hasAttribute("alt")) add(el, "a11y", "warn", "Image without alt text");
    }
    if (f.kind === "screen") {
      const ids = new Map();
      for (const el of f.doc.querySelectorAll("[data-id]")) { const n = (ids.get(el.dataset.id) ?? 0) + 1; ids.set(el.dataset.id, n); if (n === 2) add(el, "id", "error", `Duplicate data-id "${el.dataset.id}"`); }
      for (const el of f.doc.querySelectorAll("[data-sketch]")) add(el, "sketch", "info", "Sketch: the agent will build this");
      // horizontal overflow at this width is the classic responsive bug
    }
    if (f.kind === "breakpoint" && f.doc.documentElement.scrollWidth > f.width + 1) issues.push({ frame: f.key, screen: f.s.id, id: null, kind: "overflow", sev: "error", msg: `Page is ${f.doc.documentElement.scrollWidth}px wide at ${f.width}px: it scrolls sideways` });
  }
  for (const e of S.lint?.errors ?? []) issues.push({ screen: null, id: null, kind: "lint", sev: "error", msg: e.msg, where: e.where });
  for (const w of S.lint?.warnings ?? []) issues.push({ screen: null, id: null, kind: "lint", sev: "warn", msg: w.msg, where: w.where });
  for (const w of S.lint?.info ?? []) if (/:hover|:active/.test(w.msg)) issues.push({ screen: null, id: null, kind: "lint", sev: "info", msg: w.msg, where: w.where });
  S.audit.issues = issues; S.audit.used = used;
  renderAuditChip();
  if (S.tab === "audit") renderPanel();
}

// ---------------------------------------------------------------------------------------------
// rendering: chrome, left rail, right panel

function render() { stash(); renderScreens(); renderChanges(); renderTabs(); renderPanel(); renderSend(); renderBanner(); renderAuditChip(); renderShow(); renderProposalChip(); }

function renderScreens() {
  const list = $("#screen-list");
  const items = S.project.screens.map((s) => {
    const n = S.ops.filter((o) => o.screen === s.id).length + S.drafts.filter((d) => d.screen === s.id).length;
    const phone = S.devices[s.device]?.phone;
    const extra = S.variants.some((v) => v.screen === s.id) ? '<span class="dotv" title="Variants waiting"></span>' : S.proposal?.changed.screens.includes(s.id) ? '<span class="dotp" title="Changed in the proposal"></span>' : "";
    return `<li><button class="screen-item${s.of ? " is-state" : ""}${S.sel?.screen === s.id ? " active" : ""}" data-fly="${esc(s.id)}">${phone ? ICONS.phone : ICONS.desktop}<span>${esc(s.name ?? s.id)}${s.state ? ` <span class="muted">· ${esc(s.state)}</span>` : ""}${extra}</span><span class="count">${n || ""}</span></button></li>`;
  });
  const hasCat = Object.values(S.catalog).some((l) => l.length);
  if (hasCat) items.push(`<li><button class="screen-item" data-components>${ICONS.comps}<span>Components</span><span class="count">${S.ops.filter((o) => o.component).length || ""}</span></button></li>`);
  list.innerHTML = items.join("");
}

function renderChanges() {
  const all = [...S.sentOps.map((o) => ({ o, sent: true })), ...S.ops.map((o, i) => ({ o, i }))];
  const nC = S.drafts.length + S.replies.length + S.dismissed.length + (S.proposalResp?.decision ? 1 : 0);
  $("#changes-count").textContent = S.ops.length + nC ? String(S.ops.length + nC) : "";
  const items = all.map(({ o, i, sent }) => {
    const [what, detail] = describe(o);
    return `<li class="change${sent ? " sent" : ""}"><span class="what">${what} <em>${esc(o.component ? "." + o.component : o.id ?? o.newId)}</em></span>${sent ? "" : `<button class="undo" data-undo="${i}" title="Undo">✕</button>`}<span class="detail">${esc(detail)}</span></li>`;
  });
  for (const d of S.drafts) items.push(`<li class="change"><span class="what">Comment <em>${esc(d.target ?? d.screen)}</em></span><span class="detail">${esc(d.text)}</span></li>`);
  for (const r of S.replies) items.push(`<li class="change"><span class="what">${r.resolve ? "Resolve" : "Reply"} <em>${esc(r.thread)}</em></span><span class="detail">${esc(r.text ?? "")}</span></li>`);
  S.dismissed.forEach((d, i) => items.push(`<li class="change"><span class="what">No variant <em>${esc(d.set)}</em></span><button class="undo" data-undismiss="${i}" title="Undo">✕</button><span class="detail">${esc(d.note ?? "none of these")}</span></li>`));
  if (S.proposalResp?.decision) items.push(`<li class="change"><span class="what">Proposal <em>${esc(S.proposalResp.decision)}</em></span><button class="undo" data-unpropose title="Undo">✕</button><span class="detail">${esc(S.proposal?.title ?? "")}</span></li>`);
  $("#change-list").innerHTML = items.join("") || `<p class="empty">Edits and comments you make show up here until you send them.</p>`;
}

function renderTabs() {
  for (const b of $$(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === S.tab));
  $('.tabs [data-tab="proposal"]').hidden = !S.proposal;
  const open = S.threads.filter((t) => t.status === "open");
  $("#n-comments").textContent = open.length + S.drafts.length ? String(open.length + S.drafts.length) : "";
  const worst = S.compare.length ? Math.max(...S.compare.map((r) => r.mismatch)) : null;
  $("#n-build").textContent = worst === null ? "" : `${(worst * 100).toFixed(0)}%`;
}

function renderShow() {
  for (const b of $$("[data-show]")) b.setAttribute("aria-pressed", String(!!S.show[b.dataset.show]));
  $('[data-show="build"]').hidden = !S.compare.length;
  $('[data-show="components"]').hidden = !Object.values(S.catalog).some((l) => l.length);
  $('[data-show="breakpoints"]').hidden = !S.project.screens.some((s) => breakpointsFor(s).length);
}

function renderProposalChip() {
  const c = $("#proposal-chip");
  c.hidden = !S.proposal;
  if (S.proposal) c.innerHTML = `<span class="dot"></span>Proposal: ${esc(S.proposal.title)}`;
}

function renderAuditChip() {
  const n = S.audit.issues.filter((i) => i.sev !== "info").length;
  $("#audit-label").textContent = n ? `${n} issue${n === 1 ? "" : "s"}` : "No issues";
  $("#audit-chip").classList.toggle("has-issues", n > 0);
  $("#n-audit").textContent = n ? String(n) : "";
}

const pendingCount = () => S.ops.length + S.drafts.length + S.replies.length + S.dismissed.length + (S.proposalResp?.decision ? 1 : 0);

function renderSend() {
  const n = pendingCount();
  $("#send-count").textContent = String(n);
  $("#send").disabled = n === 0 || S.phase !== "editing";
}

function renderBanner() {
  const b = $("#banner");
  if (S.phase === "sent") { b.innerHTML = `<span class="spinner"></span>Sent. Waiting for the agent to pick it up…`; b.classList.add("on"); }
  else if (S.phase === "applying") { b.innerHTML = `<span class="spinner"></span>The agent is working on it…`; b.classList.add("on"); }
  else b.classList.remove("on");
}

let toastT = null;
function toast(msg, ms = 3000) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), ms);
}

function renderPanel() {
  const p = $("#panel");
  const a = document.activeElement;
  const keep = a?.dataset?.copy !== undefined ? { start: a.selectionStart, end: a.selectionEnd } : null;
  if (S.tab === "audit") p.innerHTML = auditPanel();
  else if (S.tab === "comments") p.innerHTML = commentsPanel();
  else if (S.tab === "build") p.innerHTML = buildPanel();
  else if (S.tab === "proposal" && S.proposal) p.innerHTML = proposalPanel();
  else p.innerHTML = S.sel && selEl() ? inspector() : systemPanel();
  if (keep) { const t = $("[data-copy]"); if (t) { t.focus(); t.setSelectionRange(keep.start, keep.end); } }
}

// --- design system overview (nothing selected)
function systemPanel() {
  const colors = tokensIn("color"), text = tokensIn("text"), space = tokensIn("space"), radius = tokensIn("radius"), motion = S.tokens.filter((t) => t.group === "motion");
  const font = tokensIn("font")[0];
  return `<div class="sec"><p class="hint">Click an element to inspect it. Double-click text to edit it. Drag the round grip to move, the square handles to resize.</p>
    <div class="keys"><kbd>Esc</kbd><span>Select parent</span><kbd>⌫</kbd><span>Delete</span><kbd>⌘D</kbd><span>Duplicate</span><kbd>⌥↑ ⌥↓</kbd><span>Reorder</span><kbd>⌘Z</kbd><span>Undo</span><kbd>⇧P</kbd><span>Play the prototype</span><kbd>B</kbd><span>Breakpoints</span><kbd>K</kbd><span>Components</span><kbd>⇧1</kbd><span>Fit all</span></div></div>
    <div class="sec"><h3>Color <span class="cur">${colors.length}</span></h3><div class="palette">${colors.map((t) => `<span class="sw" title="--${esc(t.name)}: ${esc(t.value)}" style="background:${esc(colorOf(t))}"></span>`).join("")}</div></div>
    <div class="sec"><h3>Type scale <span class="cur">${text.length}</span></h3><div class="scale-type">${text.slice().reverse().map((t) => `<div><code>${esc(t.name.replace(/^text-/, ""))}</code><span style="font-size:${esc(t.value)};font-family:${esc(font?.value ?? "inherit")};line-height:1.15">Aa</span><span class="muted mono">${esc(t.value)}</span></div>`).join("")}</div></div>
    <div class="sec"><h3>Spacing <span class="cur">${space.length}</span></h3><div class="space-bars">${space.map((t) => `<div><code style="width:64px">${esc(t.name)}</code><i style="width:min(160px, ${esc(t.value)})"></i>${esc(t.value)}</div>`).join("")}</div></div>
    <div class="sec"><h3>Radius</h3><div class="chips">${radius.map((t) => `<span class="tok" title="${esc(t.value)}">${esc(t.name.replace(/^radius-/, ""))}</span>`).join("")}</div></div>
    <div class="sec"><h3>Motion <span class="cur">${motion.length}</span></h3>${motion.length ? `<div class="motion-toks">${motion.map((t) => `<div><code>--${esc(t.name)}</code><span class="mono muted">${esc(t.value)}</span>${t.name.startsWith("ease") ? `<i class="ease-demo" style="--e:${esc(t.value)}"></i>` : ""}</div>`).join("")}</div>` : `<p class="hint">No --duration-* or --ease-* tokens. Motion falls back to the kit's defaults; define them in tokens.css.</p>`}</div>`;
}

// --- inspector
const INTERACTIVE_SEL = "button, a[href], input, select, textarea, [role=button], [role=switch], [data-goto]";

function inspector() {
  const f = selFrame(), el = selEl(), win = f.win;
  const cs = win.getComputedStyle(el);
  const tv = tokenValues(f);
  const id = S.sel.id;
  const cat = S.sel.cat;
  const crumbs = [];
  if (!cat) for (let n = idParentEl(el); n; n = idParentEl(n)) crumbs.unshift(n.dataset.id);
  const kids = idChildrenEl(el);
  const comp = el.dataset.component;
  const editable = !cat && editableText(el);
  const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || editable || (cat && el.textContent.trim());
  const isBox = cs.display.includes("flex") || cs.display.includes("grid");
  const interactive = el.matches(INTERACTIVE_SEL);

  const curText = tokenFor(tv.text, parseFloat(cs.fontSize));
  const curColor = tokenFor(tv.color, ckey(rgba(cs.color)), true);
  const bgKey = ckey(rgba(cs.backgroundColor));
  const curBg = bgKey === "transparent" ? "none" : tokenFor(tv.color, bgKey, true);
  const curPad = tokenFor(tv.space, parseFloat(cs.paddingTop));
  const curGap = tokenFor(tv.space, parseFloat(cs.rowGap) || parseFloat(cs.columnGap));
  const curRad = tokenFor(tv.radius, parseFloat(cs.borderTopLeftRadius));
  const curW = tokenFor(tv.weight, parseFloat(cs.fontWeight));
  const r = el.getBoundingClientRect();
  const short = (n, pre) => n.replace(new RegExp("^" + pre + "-"), "");
  const chips = (group, prop, cur, label = (n) => n) => tokensIn(group).map((t) => `<button class="tok" data-style="${prop}" data-token="${esc(t.name)}" aria-pressed="${cur === t.name}" title="--${esc(t.name)}: ${esc(t.value)}">${esc(label(t.name))}</button>`).join("");
  const swatches = (prop, cur, allowNone) => (allowNone ? `<button class="sw none" data-style="${prop}" data-raw="transparent" aria-pressed="${cur === "none"}" title="none"></button>` : "")
    + tokensIn("color").map((t) => `<button class="sw" data-style="${prop}" data-token="${esc(t.name)}" aria-pressed="${cur === t.name}" title="--${esc(t.name)}" style="background:${esc(colorOf(t))}"></button>`).join("");
  const off = (cur, v) => (cur ? `<span class="cur">--${esc(cur)}</span>` : `<span class="offscale">off-scale ${esc(v)}</span>`);
  const elOps = S.ops.map((o, i) => [o, i]).filter(([o]) => (cat ? o.component === cat : o.screen === S.sel.screen && (o.id === id || o.parent === id)));
  const threads = S.threads.filter((t) => t.screen === f.s.id && t.target === id);

  // scope line: where edits made now will land
  const forced = S.forced?.frame === f.key ? S.forced.state : null;
  const scope = cat
    ? `Component <b>.${esc(cat)}</b>${S.sel.catState ? ` in <b>:${esc(S.sel.catState)}</b>` : ""}: edits change every instance (${(S.catalog[f.pf]?.find((c) => c.cls === cat)?.count) ?? "?"} on ${esc((S.catalog[f.pf]?.find((c) => c.cls === cat)?.screens ?? []).join(", "))}).`
    : [f.kind === "breakpoint" ? `Width <b>${f.width}px</b>: edits apply at this width and below.` : "", forced ? `State <b>:${forced}</b>: edits apply in this state only.` : ""].filter(Boolean).join(" ");

  const found = cat ? new Set() : statesFor(el);
  const stateList = interactive ? STATES : STATES.filter((s) => found.has(s));
  const statesSec = !cat && stateList.length ? `<div class="sec"><h3>State ${forced ? `<span class="cur">:${forced}</span>` : ""}</h3><div class="seg">${["default", ...stateList].map((s) => `<button data-force="${s}" aria-pressed="${(forced ?? "default") === s}">${s}${s !== "default" && !found.has(s) ? '<i class="unstyled" title="No style for this state yet">○</i>' : ""}</button>`).join("")}</div>
    ${interactive && STATES.some((s) => !found.has(s)) ? `<p class="hint" style="margin-top:6px">○ = no style yet. Pick the state, then change the style to design it.</p>` : ""}</div>` : "";

  const ds = el.dataset;
  const enter = ds.motion ?? "none";
  const gotoSel = `<select data-attr="data-goto" class="sel">${[`<option value="">No link</option>`, ...S.project.screens.map((s) => `<option value="${esc(s.id)}"${ds.goto === s.id ? " selected" : ""}>${esc(s.name ?? s.id)}${s.state ? " · " + esc(s.state) : ""}</option>`)].join("")}</select>`;
  const motionSec = cat || f.kind !== "screen" ? "" : `<div class="sec"><h3>Motion ${enter !== "none" ? `<button class="mini" data-act="replay">▶ Play</button>` : ""}</h3>
      <div class="row"><label>Enter</label><div class="chips">${["none", ...S.motion.enter].map((m) => `<button class="tok" data-attr="data-motion" data-v="${m}" aria-pressed="${enter === m}">${m}</button>`).join("")}</div></div>
      ${enter !== "none" ? `<div class="row"><label>Speed</label><div class="chips">${S.motion.speed.map((m) => `<button class="tok" data-attr="data-motion-speed" data-v="${m}" aria-pressed="${(ds.motionSpeed ?? "base") === m}">${m}</button>`).join("")}</div></div>
      <div class="row"><label>Easing</label><div class="chips">${S.motion.ease.map((m) => `<button class="tok" data-attr="data-motion-ease" data-v="${m}" aria-pressed="${(ds.motionEase ?? "out") === m}">${m}</button>`).join("")}</div></div>
      <div class="row"><label>Order</label><div class="stepper-s"><button data-order="-1">−</button><span class="mono">${ds.motionOrder ?? 0}</span><button data-order="1">+</button></div><span class="hint">stagger slot</span></div>` : ""}
      ${interactive ? `<div class="row"><label>Press</label><div class="chips">${["none", ...S.motion.press].map((m) => `<button class="tok" data-attr="data-press" data-v="${m}" aria-pressed="${(ds.press ?? "none") === m}">${m}</button>`).join("")}</div></div>` : ""}
      <div class="row"><label>Links to</label>${gotoSel}</div>
      ${ds.goto ? `<div class="row"><label>Transition</label><div class="chips">${S.motion.transition.map((m) => `<button class="tok" data-attr="data-transition" data-v="${m}" aria-pressed="${(ds.transition ?? (S.devices[f.s.device]?.phone ? "push" : "fade")) === m}">${m}</button>`).join("")}</div></div>
      <button class="btn-s" data-act="play-from" style="width:100%;margin-top:6px">▶ Play the prototype from here</button>` : ""}
    </div>`;

  return `<div class="sec">
      <div class="el-head"><span class="pill">&lt;${el.tagName.toLowerCase()}&gt;</span><span class="id">${esc(cat ? "." + cat : id)}</span>${comp ? `<span class="pill comp" title="Native component this maps to">${esc(comp)}</span>` : ""}</div>
      ${crumbs.length ? `<div class="crumbs">${crumbs.map((c) => `<button data-sel="${esc(c)}">${esc(c.split(".").at(-1))}</button><span>/</span>`).join("")}<b class="mono">${esc(id.split(".").at(-1))}</b></div>` : ""}
      ${scope ? `<p class="scope">${scope}</p>` : ""}
      ${!cat && kids.length ? `<p class="hint" style="margin-top:8px">${kids.length} child element${kids.length === 1 ? "" : "s"} · Enter selects the first</p>` : ""}
    </div>
    ${statesSec}
    ${editable ? `<div class="sec"><h3>Copy</h3><textarea class="copy" rows="${Math.min(5, Math.ceil(el.textContent.length / 34) || 1)}" data-copy>${esc(el.textContent.trim())}</textarea></div>` : ""}
    ${hasText ? `<div class="sec"><h3>Text ${off(curText, cs.fontSize)}</h3>
      <div class="chips">${chips("text", "font-size", curText, (n) => short(n, "text"))}</div>
      ${tokensIn("weight").length ? `<div class="row" style="margin-top:8px"><label>Weight</label><div class="chips">${chips("weight", "font-weight", curW, (n) => short(n, "weight"))}</div></div>` : ""}
      <div class="row" style="margin-top:10px;align-items:flex-start"><label>Color</label><div class="chips">${swatches("color", curColor, false)}</div></div>
      ${curColor ? "" : `<p class="offscale" style="margin-top:6px">Color ${esc(cs.color)} isn't a token</p>`}</div>` : ""}
    <div class="sec"><h3>Fill ${curBg === "none" ? '<span class="cur">none</span>' : off(curBg, cs.backgroundColor)}</h3><div class="chips">${swatches("background-color", curBg, true)}</div></div>
    <div class="sec"><h3>Spacing</h3>
      <div class="row"><label>Padding</label><div class="chips">${chips("space", "padding", curPad, (n) => short(n, "space"))}</div></div>
      ${isBox ? `<div class="row"><label>Gap</label><div class="chips">${chips("space", "gap", curGap, (n) => short(n, "space"))}</div></div>` : ""}
      <div class="row"><label>Radius</label><div class="chips">${chips("radius", "border-radius", curRad, (n) => short(n, "radius"))}</div></div>
    </div>
    <div class="sec"><h3>Size</h3><div class="sizes">
      <div class="num"><span>W</span><input data-size="width" value="${Math.round(r.width)}" inputmode="numeric"><button data-auto="width" title="Back to automatic width">auto</button></div>
      <div class="num"><span>H</span><input data-size="height" value="${Math.round(r.height)}" inputmode="numeric"><button data-auto="height" title="Back to automatic height">auto</button></div>
    </div></div>
    ${motionSec}
    ${cat ? "" : `<div class="sec"><h3>Actions</h3><div class="actions">
      <button class="act" data-act="up"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 13V3M4 7l4-4 4 4"/></svg>Earlier <kbd>⌥↑</kbd></button>
      <button class="act" data-act="down"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M4 9l4 4 4-4"/></svg>Later <kbd>⌥↓</kbd></button>
      <button class="act" data-act="dup"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7"/></svg>Duplicate <kbd>⌘D</kbd></button>
      <button class="act" data-act="sketch-after"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 1.6"><rect x="2" y="4" width="12" height="8" rx="1.5"/></svg>Sketch after</button>
      <button class="act" data-act="sketch-in"${kids.length || isBox ? "" : " disabled"}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5"/><rect x="5" y="7" width="6" height="4" rx="1" stroke-dasharray="1.6 1.2"/></svg>Sketch inside</button>
      <button class="act danger" data-act="del"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>Delete <kbd>⌫</kbd></button>
    </div>
    <button class="btn-s wide variants-btn" data-act="variants"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="3" width="4" height="10" rx="1"/><rect x="6" y="3" width="4" height="10" rx="1"/><rect x="10.5" y="3" width="4" height="10" rx="1"/></svg>Ask for variants of this…</button>
    <button class="btn-s wide" data-act="comment">Comment on this element for the agent…</button></div>`}
    ${threads.length ? `<div class="sec"><h3>Comments</h3>${threads.map((t) => `<button class="thread-item" style="padding:6px 0;border:0" data-thread="${esc(t.id)}"><div class="top"><span class="who ${t.by}"></span>${esc(t.id)} · ${t.status}</div><div class="txt">${esc(t.messages.at(-1)?.text)}</div></button>`).join("")}</div>` : ""}
    ${elOps.length ? `<div class="sec"><h3>Unsent edits here</h3>${elOps.map(([o, i]) => { const [w, d] = describe(o); return `<div class="change"><span class="what">${w}</span><button class="undo" data-undo="${i}">✕</button><span class="detail">${esc(d)}</span></div>`; }).join("")}</div>` : ""}
    <div class="sec"><h3>Custom CSS</h3><div class="row"><input class="mono field-s" data-raw-prop placeholder="property" style="width:40%"><input class="mono field-s" data-raw-val placeholder="value" style="flex:1;min-width:0"></div><p class="hint" style="margin-top:6px">Off-scale values are flagged to the agent. Prefer the token chips above.</p></div>`;
}

function auditPanel() {
  const { issues, used } = S.audit;
  const u = (m, fmt) => [...(m?.entries() ?? [])].sort((a, b) => (typeof a[0] === "number" ? a[0] - b[0] : 0)).map(([k, e]) => fmt(k, e)).join("");
  const sum = used ? `<div class="sec audit-sum">
    <div><div class="lbl">Type sizes in use</div><div class="used">${u(used.text, (k, e) => `<span class="tok${e.off ? " off" : ""}" title="${e.n} element(s)${e.off ? ", not on the scale" : ""}">${k}</span>`)}</div></div>
    <div><div class="lbl">Colors in use</div><div class="used">${u(used.color, (k, e) => `<span class="sw${e.off ? " off" : ""}" style="background:${esc(k)}" title="${esc(k)} · ${e.n} use(s)${e.off ? " · not a token" : ""}"></span>`)}</div></div>
    <div><div class="lbl">Spacing in use</div><div class="used">${u(used.space, (k, e) => `<span class="tok${e.off ? " off" : ""}" title="${e.n} use(s)">${k}</span>`)}</div></div>
    <div><div class="lbl">Radii in use</div><div class="used">${u(used.radius, (k, e) => `<span class="tok${e.off ? " off" : ""}" title="${e.n} use(s)">${k}</span>`)}</div></div>
  </div>` : "";
  const groups = new Map();
  for (const i of issues) { const k = i.frame ?? "Source files"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const order = { error: 0, warn: 1, info: 2 };
  const name = (k) => { const f = S.frames.get(k); return f ? `${f.s.name ?? f.s.id}${f.s.state ? " · " + f.s.state : ""}${f.kind === "breakpoint" ? ` · ${f.width}px` : ""}` : k; };
  const list = [...groups].map(([k, arr]) => `<div class="issue-group">${esc(name(k))}</div>` + arr.sort((a, b) => order[a.sev] - order[b.sev]).map((i) => `<button class="issue" ${i.frame ? `data-issue-frame="${esc(i.frame)}" data-issue-id="${esc(i.id ?? "")}"` : ""}><span class="sev ${i.sev}"></span><span><span class="m">${esc(i.msg)}</span><br><span class="w">${esc(i.id ?? i.where ?? "")}</span></span></button>`).join("")).join("");
  return sum + (issues.length ? list : `<div class="sec"><p class="hint">Everything on screen is on the scale, readable, tappable and moves well.</p></div>`)
    + `<div class="sec"><p class="hint">Checks every rendered element on every screen and width: type, color, spacing and radius against tokens.css; WCAG AA contrast; 44pt tap targets on phones; transitions on layout properties or longer than 600ms; sideways scroll at breakpoints. Source lint (banned patterns, missing states, copy) comes from <span class="mono">canvas.mjs lint</span>.</p></div>`;
}

function commentsPanel() {
  const threads = S.threads.filter((t) => t.status === "open" || S.showResolved).sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1));
  const draft = S.drafts.map((d, i) => `<button class="thread-item" data-draft-open="${i}"><div class="top"><span class="who"></span>New · ${esc(d.target ?? d.screen)}<span class="turn">not sent</span></div><div class="txt">${esc(d.text)}</div></button>`).join("");
  const items = threads.map((t) => {
    const last = t.messages.at(-1);
    const yours = last?.by === "agent" && t.status === "open";
    return `<button class="thread-item" data-thread="${esc(t.id)}"><div class="top"><span class="who ${t.by}"></span>${esc(t.id)} · ${esc(S.project.screens.find((s) => s.id === t.screen)?.name ?? t.screen)}${t.target ? ` › <span class="mono">${esc(t.target.split(".").at(-1))}</span>` : ""}<span class="turn${yours ? " you" : ""}">${t.status === "resolved" ? "resolved" : yours ? "your turn" : "agent's turn"}</span></div><div class="txt">${esc(last?.text)}</div></button>`;
  }).join("");
  return `<div class="sec"><p class="hint">Press <kbd>C</kbd> and click anything to pin a comment. Questions get an answer; requests get made. Violet pins are the agent asking you.</p>
    <label class="row" style="margin-top:10px;font-size:12px;color:var(--ink-2)"><input type="checkbox" data-show-resolved ${S.showResolved ? "checked" : ""}> Show resolved</label></div>` + draft + (items || (draft ? "" : `<div class="sec"><p class="hint">No comments yet.</p></div>`));
}

const TARGETS = {
  simulator: { label: "Run in the Simulator", hint: "The agent builds the app, launches it in the iOS Simulator and compares each screen with its mock.", when: (pfs) => pfs.has("ios") },
  device: { label: "Run on my device", hint: "The agent builds and installs on a connected iPhone or Android phone, then you check it in your hand.", when: (pfs) => pfs.has("ios") || pfs.has("android") },
  web: { label: "Run in the browser", hint: "The agent starts the web build and compares each page with its mock at every width.", when: (pfs) => pfs.has("web") },
  compare: { label: "Compare again", hint: "Re-capture the running build and diff it against the mocks.", when: () => true },
};

function buildPanel() {
  const pfs = new Set(S.project.screens.map((s) => platformOf(s.device)));
  const webUrl = S.project.build?.web?.url;
  const buttons = Object.entries(TARGETS).filter(([, t]) => t.when(pfs)).map(([k, t]) => `<button class="test-btn" data-test="${k}"><b>${t.label}</b><span>${t.hint}</span></button>`).join("");
  const reps = S.compare.slice().sort((a, b) => b.mismatch - a.mismatch);
  const list = reps.map((r) => {
    const s = S.project.screens.find((x) => x.id === r.screen);
    const grade = r.mismatch < 0.03 ? "good" : r.mismatch < 0.15 ? "near" : "off";
    const fs = findingsOf(r);
    return `<div class="rep"><button class="rep-head" data-fly-row="${esc(r.screen)}"><span class="grade ${grade}"></span><b>${esc(s?.name ?? r.screen)}${s?.state ? ` · ${esc(s.state)}` : ""}</b><span class="pct">${esc(matchLine(r))}</span></button>
      <p class="hint">${esc(r.source.replace(/^file:\/\/.*\/([^/]+\/[^/]+)$/, "$1"))} · ${ago(r.at)}${r.heightDelta ? ` · build is ${Math.abs(r.heightDelta)}px ${r.heightDelta > 0 ? "taller" : "shorter"}` : ""}${r.mode === "pixels" ? " · pixel comparison (the build has no ids to match)" : ""}</p>
      ${fs.slice(0, 10).map((g, i) => `<button class="region-row" data-region="${esc(r.screen)}|${esc(g.id ?? "")}"><span class="rn k-${esc(g.kind)}">${i + 1}</span><span class="rbody"><span class="mono">${esc(g.id ?? "unmapped area")}</span><span class="rdetail"><b>${esc(g.kind)}</b> ${esc(g.detail)}</span></span></button>`).join("")}
      ${r.extra?.length ? `<p class="hint" style="margin-left:17px">Only in the build: <span class="mono">${esc(r.extra.slice(0, 5).join(", "))}</span></p>` : ""}
    </div>`;
  }).join("");
  return `<div class="sec"><h3>Test the build</h3><div class="tests">${buttons}</div>
      ${webUrl ? `<a class="btn-s wide" href="${esc(webUrl)}" target="_blank" rel="noopener">Open the running build ↗</a>` : ""}
      <p class="hint" style="margin-top:8px">These go to the agent like a Send (your unsent edits go too). It builds, runs, captures each screen and puts the comparison here.</p></div>
    <div class="sec"><h3>Build vs mock ${reps.length ? `<span class="cur">${reps.length} screen${reps.length === 1 ? "" : "s"}</span>` : ""}</h3>
      ${reps.length ? list : `<p class="hint">No comparison yet. Once something is built, a test run captures each screen of the real app and diffs it against its mock: numbered regions show what's off and which element it is.</p>${S.project.build ? "" : `<p class="hint">The agent maps screens to the build in <span class="mono">design.json</span> → <span class="mono">build</span> (web routes, iOS deep links).</p>`}`}
    </div>`;
}

function proposalPanel() {
  const p = S.proposal, R = S.proposalResp;
  const name = (id) => { const s = S.project.screens.find((x) => x.id === id) ?? S.proposalScreens.find((x) => x.id === id); return s ? `${s.name ?? id}${s.state ? " · " + s.state : ""}` : id; };
  const row = (id, kind) => `<label class="prop-row"><input type="checkbox" data-paccept="${esc(id)}" ${R.accepted.has(id) ? "checked" : ""}><span class="ptag ${kind}">${kind}</span><button class="linkish" data-fly-row="${esc(id)}${kind === "new" ? "+proposal" : ""}">${esc(name(id))}</button></label>`;
  return `<div class="sec"><h3>Proposal</h3><p class="prop-title">${esc(p.title)}</p><p class="hint">${esc(p.summary)}</p>${p.request ? `<p class="hint" style="margin-top:6px">You asked: “${esc(p.request)}”</p>` : ""}</div>
    <div class="sec"><h3>What changes</h3>
      ${p.changed.screens.map((id) => row(id, "changed")).join("")}${p.changed.added.map((id) => row(id, "new")).join("")}${p.changed.removed.map((id) => row(id, "removed")).join("")}
      ${p.changed.system ? `<label class="prop-row"><input type="checkbox" data-psystem ${R.system ? "checked" : ""}><span class="ptag sys">system</span><span>Tokens and components</span></label>` : ""}
      <p class="hint" style="margin-top:8px">Proposed versions sit beside the current ones: <span class="key add">added</span> <span class="key chg">changed</span> <span class="key del">removed</span>.</p></div>
    ${p.questions?.length ? `<div class="sec"><h3>Questions</h3>${p.questions.map((q) => `<div class="pq"><p>${esc(q.question)}</p>${q.options?.length ? `<div class="chips">${q.options.map((o) => `<button class="tok" data-panswer="${esc(q.id)}" data-v="${esc(o)}" aria-pressed="${R.answers[q.id] === o}">${esc(o)}</button>`).join("")}</div>` : ""}<input class="field-s" data-panswer-text="${esc(q.id)}" placeholder="Or say something else…" value="${esc(q.options?.includes(R.answers[q.id]) ? "" : R.answers[q.id] ?? "")}"></div>`).join("")}</div>` : ""}
    <div class="sec"><h3>Reply</h3><textarea class="copy" rows="2" data-preply placeholder="Anything for the agent? (optional)">${esc(R.reply)}</textarea>
      <div class="prop-actions"><button class="btn-s" data-pdecide="rejected">Reject</button><button class="btn-s" data-pdecide="partial">Accept selected</button><button class="btn-s go" data-pdecide="accepted">Accept all</button></div>
      ${R.decision ? `<p class="hint" style="margin-top:8px">Marked <b>${esc(R.decision)}</b>. Press Send to tell the agent.</p>` : ""}</div>`;
}

// ---------------------------------------------------------------------------------------------
// panel & chrome events

function bindChrome() {
  for (const b of $$(".modes button")) b.onclick = () => setMode(b.dataset.mode);
  for (const b of $$(".tabs button")) b.onclick = () => { S.tab = b.dataset.tab; if (S.tab === "audit") runAudit(); renderTabs(); renderPanel(); drawAll(); };
  for (const b of $$("[data-show]")) b.onclick = () => toggleShow(b.dataset.show);
  $("#audit-chip").onclick = () => { S.tab = "audit"; runAudit(); renderTabs(); renderPanel(); };
  $("#proposal-chip").onclick = () => { S.tab = "proposal"; renderTabs(); renderPanel(); const id = S.proposal?.changed.screens[0] ?? S.proposal?.changed.added[0]; if (id) flyToRow(S.frames.has(id) ? id : id + "+proposal"); };
  $("#zoom-in").onclick = () => { const c = $("#canvas").getBoundingClientRect(); zoomAt(S.view.k * 1.25, c.width / 2, c.height / 2); };
  $("#zoom-out").onclick = () => { const c = $("#canvas").getBoundingClientRect(); zoomAt(S.view.k / 1.25, c.width / 2, c.height / 2); };
  $("#zoom-label").onclick = () => fit();
  $("#send").onclick = openSend;
  $("#play").onclick = () => openPlayer(S.sel?.screen && !S.sel.cat ? S.sel.screen : undefined);
  $("#test").onclick = () => { S.tab = "build"; renderTabs(); renderPanel(); drawAll(); };
  $("#screen-list").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.components !== undefined) { if (!S.show.components) toggleShow("components"); setTimeout(() => { const k = [...S.frames.keys()].find((x) => x.startsWith("__components")); if (k) flyToScreen(k); }, 80); return; }
    if (b.dataset.fly) { const has = [...S.frames.values()].some((f) => f.row === b.dataset.fly && f.kind !== "screen"); has ? flyToRow(b.dataset.fly) : flyToScreen(b.dataset.fly); }
  };
  $("#change-list").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.undo) undoOp(Number(b.dataset.undo));
    else if (b.dataset.undismiss) { S.dismissed.splice(Number(b.dataset.undismiss), 1); filterVariants(); buildWorld(); render(); }
    else if (b.dataset.unpropose !== undefined) { S.proposalResp.decision = null; render(); }
  };
  document.addEventListener("keydown", (e) => { if (playerOpen()) { if (playerKey(e)) e.preventDefault(); return; } onKey(e); });
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#popover, .pin")) closePopover(); });

  const panel = $("#panel");
  panel.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const f = selFrame(), el = selEl();
    if (t.dataset.sel) return select({ frame: S.sel.frame, screen: S.sel.screen, id: t.dataset.sel });
    if (t.dataset.undo) return undoOp(Number(t.dataset.undo));
    if (t.dataset.thread) { const th = S.threads.find((x) => x.id === t.dataset.thread); if (th) { flyToElement(th.screen, th.target); setTimeout(() => openThread(th.id), 600); } return; }
    if (t.dataset.draftOpen !== undefined) { const d = S.drafts[Number(t.dataset.draftOpen)]; flyToElement(d.screen, d.target); setTimeout(() => openThread(undefined, t.dataset.draftOpen), 600); return; }
    if (t.dataset.issueFrame) {
      const key = t.dataset.issueFrame, id = t.dataset.issueId || null, f2 = S.frames.get(key);
      S.audit.highlight = id ? { frame: key, id } : null;
      if (id && f2) { S.sel = selFor(f2, findEl(f2, id)); flyToElement(key, id); } else flyToScreen(key);
      drawAll(); renderScreens();
      setTimeout(() => { S.audit.highlight = null; drawAll(); }, 3000);
      return;
    }
    if (t.dataset.test) { const k = t.dataset.test; requestNow({ type: k === "compare" ? "compare" : "test", target: k }, k === "compare" ? "Asked the agent to compare the build again." : `Asked the agent to ${TARGETS[k].label.toLowerCase()}.`); return; }
    if (t.dataset.region) { const [screen, id] = t.dataset.region.split("|"); if (id) { select({ frame: screen, screen, id }); flyToElement(screen, id); } else flyToRow(screen); return; }
    if (t.dataset.flyRow) return flyToRow(t.dataset.flyRow);
    if (t.dataset.panswer) { S.proposalResp.answers[t.dataset.panswer] = t.dataset.v; renderPanel(); return; }
    if (t.dataset.pdecide) {
      const d = t.dataset.pdecide, R = S.proposalResp;
      R.decision = d;
      if (d === "accepted") { R.accepted = new Set([...S.proposal.changed.screens, ...S.proposal.changed.added, ...S.proposal.changed.removed]); R.system = true; }
      if (d === "rejected") R.accepted = new Set();
      render();
      toast(d === "rejected" ? "Marked as rejected. Send to tell the agent." : "Marked. Send to have the agent apply it.");
      return;
    }
    if (t.dataset.force) { setForced(t.dataset.force === "default" ? null : t.dataset.force); f.tokenCache = null; renderPanel(); drawAll(); return; }
    if (!el) return;
    if (t.dataset.style) {
      const prop = t.dataset.style;
      const value = t.dataset.token ? `var(--${t.dataset.token})` : t.dataset.raw;
      const before = f.win.getComputedStyle(el).getPropertyValue(prop);
      addOp(scoped(f, { op: "style", prop, value, token: t.dataset.token ?? (t.dataset.raw === "transparent" ? "none" : undefined), before }));
      return;
    }
    if (t.dataset.auto) { addOp(scoped(f, { op: "resize", [t.dataset.auto]: null, before: {} })); return; }
    if (t.dataset.attr) { setAttr(t.dataset.attr, t.dataset.v === "none" ? null : t.dataset.v); return; }
    if (t.dataset.order) { const n = clamp((parseInt(el.dataset.motionOrder ?? "0", 10) || 0) + Number(t.dataset.order), 0, 12); setAttr("data-motion-order", n ? String(n) : null); return; }
    const act = t.dataset.act;
    if (act === "up") moveBy(-1);
    else if (act === "down") moveBy(1);
    else if (act === "dup") duplicate();
    else if (act === "del") remove();
    else if (act === "sketch-after" || act === "sketch-in") sketch(act === "sketch-in");
    else if (act === "variants") askVariants();
    else if (act === "replay") replayMotion(f, el);
    else if (act === "play-from") openPlayer(f.s.id);
    else if (act === "comment") { const r = el.getBoundingClientRect(); draftComment(f, S.sel.id, 0.95, 0.1, toWindow(f, r.right, r.top)); }
  });
  panel.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.copy !== undefined) {
      const f = selFrame(), el = selEl();
      if (!el) return;
      const before = S.ops.find((o) => o.op === "text" && o.id === S.sel.id && o.screen === S.sel.screen)?.before ?? el.textContent;
      addOp({ op: "text", screen: f.s.id, id: S.sel.id, value: t.value, before });
    }
    if (t.dataset.preply !== undefined) { S.proposalResp.reply = t.value; stash(); }
    if (t.dataset.panswerText) { S.proposalResp.answers[t.dataset.panswerText] = t.value; }
  });
  panel.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.showResolved !== undefined) { S.showResolved = t.checked; renderPanel(); drawAll(); return; }
    if (t.dataset.paccept) { t.checked ? S.proposalResp.accepted.add(t.dataset.paccept) : S.proposalResp.accepted.delete(t.dataset.paccept); if (S.proposalResp.decision) S.proposalResp.decision = "partial"; render(); return; }
    if (t.dataset.psystem !== undefined) { S.proposalResp.system = t.checked; if (S.proposalResp.decision) S.proposalResp.decision = "partial"; render(); return; }
    const f = selFrame(), el = selEl();
    if (!el) return;
    if (t.dataset.attr === "data-goto") { setAttr("data-goto", t.value || null); return; }
    if (t.dataset.size) { const v = parseInt(t.value, 10); if (v > 0) addOp(scoped(f, { op: "resize", [t.dataset.size]: v, before: {} })); }
    if (t.matches("[data-raw-val]")) {
      const prop = $("[data-raw-prop]", panel).value.trim();
      if (prop && t.value.trim()) addOp(scoped(f, { op: "style", prop, value: t.value.trim(), before: f.win.getComputedStyle(el).getPropertyValue(prop) }));
    }
  });
}

function setAttr(name, value) {
  const f = selFrame(), el = selEl();
  if (!el || !screenKinds(f)) return;
  const before = { [name]: el.getAttribute(name) };
  if ((before[name] ?? null) === value) return;
  addOp({ op: "attr", screen: f.s.id, id: S.sel.id, attrs: { [name]: value }, before });
  if (name.startsWith("data-motion")) setTimeout(() => replayMotion(f, findEl(f, S.sel.id)), 16);
}

function toggleShow(k) {
  S.show[k] = !S.show[k];
  stash();
  buildWorld();
  render();
  if (k === "components" && S.show.components) setTimeout(() => { const key = [...S.frames.keys()].find((x) => x.startsWith("__components")); if (key) flyToScreen(key); }, 120);
}

function setMode(m) {
  if (editing) endEdit(true);
  S.mode = m;
  for (const b of $$(".modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  for (const f of S.frames.values()) {
    if (!f.doc) continue;
    f.doc.documentElement.classList.remove("dc-select", "dc-comment", "dc-preview");
    f.doc.documentElement.classList.add("dc-" + m);
  }
  if (m === "preview") S.hover = null;
  drawAll();
}

function duplicate() {
  const f = selFrame(), el = selEl();
  if (!el || !screenKinds(f) || !idParentEl(el)) return;
  const nid = uniqueId(f, S.sel.id);
  addOp({ op: "duplicate", screen: f.s.id, id: S.sel.id, suffix: nid.slice(S.sel.id.length) });
  select({ frame: f.key, screen: f.s.id, id: nid });
}

function remove() {
  const f = selFrame(), el = selEl();
  if (!el || !screenKinds(f)) return;
  if (!idParentEl(el)) return toast("The screen root can't be deleted.");
  const parent = idParentEl(el).dataset.id;
  addOp({ op: "remove", screen: f.s.id, id: S.sel.id, label: el.textContent.trim().replace(/\s+/g, " ").slice(0, 60) });
  select({ frame: f.key, screen: f.s.id, id: parent });
}

function sketch(inside) {
  const f = selFrame(), el = selEl();
  if (!el) return;
  const parentEl = inside ? el : idParentEl(el);
  if (!parentEl) return;
  const index = inside ? idChildrenEl(el).length : idChildrenEl(parentEl).indexOf(el) + 1;
  const r = el.getBoundingClientRect();
  const p = popover(`<h4><span>Sketch ${inside ? "inside" : "after"} <span class="mono">${esc(S.sel.id)}</span></span></h4>
    <textarea placeholder="What goes here? e.g. “a quiet link to past swims”"></textarea>
    <div class="foot"><span class="muted">The agent builds it</span><button class="btn-s" data-x>Cancel</button><button class="btn-s go" data-ok>Add</button></div>`, toWindow(f, r.right, r.bottom));
  const ok = () => {
    const note = $("textarea", p).value.trim();
    if (!note) return;
    const newId = uniqueId(f, `${parentEl.dataset.id}.sketch`);
    addOp({ op: "sketch", screen: f.s.id, parent: parentEl.dataset.id, index, note, newId, id: newId });
    closePopover();
    select({ frame: f.key, screen: f.s.id, id: newId });
  };
  $("[data-ok]", p).onclick = ok;
  $("[data-x]", p).onclick = closePopover;
  $("textarea", p).onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ok(); } if (e.key === "Escape") closePopover(); };
}

// ---------------------------------------------------------------------------------------------
// sending to the agent

async function sendPayload({ note = "", requests = [] } = {}) {
  const R = S.proposalResp;
  const payload = {
    base: S.version, note,
    ops: S.ops,
    comments: [...S.drafts.map((d) => ({ screen: d.screen, target: d.target, x: d.x, y: d.y, text: d.text })), ...S.replies],
    requests,
    variants: S.dismissed.length ? S.dismissed : undefined,
    proposal: R?.decision ? {
      decision: R.decision,
      accepted: R.decision === "rejected" ? [] : [...R.accepted],
      rejected: R.decision === "rejected" ? [...S.proposal.changed.screens, ...S.proposal.changed.added, ...S.proposal.changed.removed] : [...S.proposal.changed.screens, ...S.proposal.changed.added, ...S.proposal.changed.removed].filter((id) => !R.accepted.has(id)),
      system: R.decision !== "rejected" && R.system,
      answers: (S.proposal.questions ?? []).filter((q) => R.answers[q.id]).map((q) => ({ id: q.id, question: q.question, answer: R.answers[q.id] })),
      reply: R.reply || undefined,
    } : undefined,
  };
  const r = await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) { toast((await r.json().catch(() => ({}))).error ?? "Send failed"); return false; }
  S.sentOps = [...S.sentOps, ...S.ops]; S.ops = []; S.drafts = []; S.replies = []; S.dismissed = [];
  if (R) R.decision = null;
  S.phase = "sent";
  await loadProject();
  render(); drawAll();
  return true;
}

async function requestNow(req, label) {
  if (S.phase !== "editing") return toast("The agent is still working on your last send.");
  const extra = pendingCount();
  if (await sendPayload({ requests: [req] })) toast(label + (extra ? ` Your ${extra} unsent change${extra === 1 ? "" : "s"} went with it.` : ""), 4500);
}

function openSend() {
  const nE = S.ops.length, nC = S.drafts.length, nR = S.replies.length;
  const parts = [nE && `${nE} edit${nE === 1 ? "" : "s"}`, nC && `${nC} comment${nC === 1 ? "" : "s"}`, nR && `${nR} repl${nR === 1 ? "y" : "ies"}`, S.dismissed.length && "variants turned down", S.proposalResp?.decision && `the proposal (${S.proposalResp.decision})`].filter(Boolean);
  const b = $("#send").getBoundingClientRect();
  const p = popover(`<h4><span>Send to the agent</span></h4>
    <p class="hint" style="margin-bottom:8px">${esc(parts.join(", "))}. The agent applies them to the source, keeps the design system consistent, and the canvas reloads.</p>
    <textarea placeholder="Anything overall? (optional) e.g. “calmer, less color”"></textarea>
    <div class="foot"><span class="muted">⌘↩</span><button class="btn-s" data-x>Cancel</button><button class="btn-s go" data-ok>Send</button></div>`, { x: b.left - 330, y: b.bottom + 10 });
  const go = async () => { const note = $("textarea", p).value.trim(); closePopover(); await sendPayload({ note }); };
  $("[data-ok]", p).onclick = go;
  $("[data-x]", p).onclick = closePopover;
  $("textarea", p).onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go(); if (e.key === "Escape") closePopover(); };
}

function onKey(e) {
  const t = e.target;
  const typing = t.closest?.("input, textarea, select, [contenteditable]") || (editing && editing.el.contains(t));
  if (editing && (t === editing.el || editing.el.contains(t))) {
    if (e.key === "Escape") { e.preventDefault(); endEdit(false); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); editing.el.blur(); }
    return;
  }
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") {
    if ($("#popover").classList.contains("on")) return closePopover();
    if (S.forced) { setForced(null); renderPanel(); drawAll(); return; }
    const el = selEl();
    const p = el && !S.sel.cat && idParentEl(el);
    select(p ? { frame: S.sel.frame, screen: S.sel.screen, id: p.dataset.id } : null);
    return;
  }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (S.ops.length) undoOp(S.ops.length - 1); return; }
  if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
  if (mod) return;
  if (e.shiftKey && (e.key === "P" || e.key === "p")) return openPlayer(S.sel?.screen && !S.sel.cat ? S.sel.screen : undefined);
  if (e.key === "v" || e.key === "V") return setMode("select");
  if (e.key === "c" || e.key === "C") return setMode("comment");
  if (e.key === "p") return setMode("preview");
  if (e.key === "b" || e.key === "B") return toggleShow("breakpoints");
  if (e.key === "k" || e.key === "K") return toggleShow("components");
  if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) return fit();
  if (e.key === "@" || (e.shiftKey && e.code === "Digit2")) { if (S.sel) flyToElement(S.sel.frame, S.sel.id); return; }
  if (e.key === "=" || e.key === "+") { const c = $("#canvas").getBoundingClientRect(); return zoomAt(S.view.k * 1.25, c.width / 2, c.height / 2); }
  if (e.key === "-") { const c = $("#canvas").getBoundingClientRect(); return zoomAt(S.view.k / 1.25, c.width / 2, c.height / 2); }
  if (!S.sel) return;
  if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); remove(); }
  else if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); moveBy(-1); }
  else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); moveBy(1); }
  else if (e.key === "Enter") {
    e.preventDefault();
    const f = selFrame(), el = selEl();
    if (!el || S.sel.cat) return;
    const kids = idChildrenEl(el);
    if (e.shiftKey) { const p = idParentEl(el); if (p) select({ frame: f.key, screen: S.sel.screen, id: p.dataset.id }); }
    else if (kids.length) select({ frame: f.key, screen: S.sel.screen, id: kids[0].dataset.id });
    else if (editableText(el) && screenKinds(f)) startEdit(f, el);
  } else if (e.key === "Tab") {
    e.preventDefault();
    const el = selEl(), p = el && !S.sel.cat && idParentEl(el);
    if (!p) return;
    const sibs = idChildrenEl(p), i = sibs.indexOf(el);
    const n = sibs[(i + (e.shiftKey ? -1 : 1) + sibs.length) % sibs.length];
    select({ frame: S.sel.frame, screen: S.sel.screen, id: n.dataset.id });
  }
}

boot();
