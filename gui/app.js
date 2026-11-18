// design-canvas GUI. Screens render in same-origin iframes; the canvas reads and edits their DOM
// directly. Every edit is an op keyed by data-id, so it can be previewed, undone, replayed after
// the agent reloads a screen, and sent to the agent as an exact instruction.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cssq = (id) => `[data-id="${CSS.escape(id)}"]`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const snap = (v) => Math.round(v / 4) * 4;

const S = {
  project: null, tokens: [], devices: {}, threads: [], lint: null,
  version: null, phase: "editing", doneAt: null,
  frames: new Map(),          // screenId -> frame
  ops: [], sentOps: [],       // pending edits; edits sent but not yet applied by the agent
  drafts: [],                 // new comments not yet sent
  replies: [],                // replies/resolves on existing threads not yet sent
  sel: null,                  // { screen, id }
  hover: null,                // { screen, id }
  mode: "select",
  tab: "inspect",
  view: { x: 40, y: 80, k: 0.5 },
  audit: { issues: [], used: null },
  showResolved: false,
};

// ---------------------------------------------------------------------------------------------
// boot

// Unsent work survives a reload or a closed tab. It replays by data-id, so it still applies after
// the agent changes the files; edits whose element is gone simply do nothing.
const stashKey = () => `design-canvas:${S.dir}`;
function stash() {
  try { localStorage.setItem(stashKey(), JSON.stringify({ ops: S.ops, drafts: S.drafts, replies: S.replies, sentOps: S.phase === "editing" ? [] : S.sentOps })); } catch { /* storage off */ }
}
function unstash() {
  try {
    const v = JSON.parse(localStorage.getItem(stashKey()) ?? "null");
    if (!v) return;
    S.ops = v.ops ?? []; S.drafts = v.drafts ?? []; S.replies = v.replies ?? [];
    if (S.phase !== "editing") S.sentOps = v.sentOps ?? [];
  } catch { /* ignore */ }
}

async function boot() {
  await loadProject();
  unstash();
  buildWorld();
  bindChrome();
  bindCanvas();
  render();
  requestAnimationFrame(() => fit(false));
  setInterval(poll, 1200);
}

async function loadProject() {
  const r = await fetch("/api/project").then((r) => r.json());
  S.project = r.project; S.tokens = r.tokens; S.devices = r.devices; S.threads = r.comments.threads ?? [];
  S.lint = r.lint; S.version = r.status.version; S.dir = r.status.dir; S.phase = r.status.phase; S.doneAt = r.status.done?.at ?? null;
  $("#proj-name").textContent = S.project.name ?? "Design";
  const devs = [...new Set(S.project.screens.map((s) => S.devices[s.device]?.label ?? s.device))];
  $("#proj-meta").textContent = `${S.project.screens.length} screens · ${devs.join(", ")}`;
  document.title = `${S.project.name} · Design Canvas`;
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const st = await fetch("/api/status").then((r) => r.json());
    const changed = st.version !== S.version;
    const finished = st.done?.at && st.done.at !== S.doneAt;
    const prevPhase = S.phase;
    S.phase = st.phase;
    // While the agent works the source is half-applied: replaying sent edits on it would double
    // duplicates and sketches. Hold the preview until it runs `done`.
    if (changed && !finished && st.phase !== "editing" && S.sentOps.length) { renderBanner(); renderSend(); polling = false; return; }
    if (changed || finished) {
      const wasSent = S.sentOps.length > 0 || prevPhase !== "editing";
      if (st.phase === "editing" && finished) S.sentOps = [];
      await loadProject();
      reloadAll();
      render();
      if (finished && wasSent) toast(st.done.summary ? `Agent: ${st.done.summary}` : "The agent applied your changes.", 6000);
    }
    renderBanner();
    renderSend();
  } catch { /* server restarting */ }
  polling = false;
}

// ---------------------------------------------------------------------------------------------
// world: artboards with device frames

const ICONS = {
  desktop: '<svg class="dev-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14h5"/></svg>',
  phone: '<svg class="dev-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="4" y="1.5" width="8" height="13" rx="2"/><path d="M7 12.5h2"/></svg>',
};
const STATUS_ICONS = '<span class="icons"><svg viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="0.8"/><rect x="5" y="5.5" width="3" height="6.5" rx="0.8"/><rect x="10" y="3" width="3" height="9" rx="0.8"/><rect x="15" y="0" width="3" height="12" rx="0.8"/></svg><svg viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.1-1.2A10.2 10.2 0 0 0 8 .5C5.3.5 2.8 1.6.9 3.4L2 4.6a8.6 8.6 0 0 1 6-2.4zm0 3.4c1.4 0 2.6.5 3.6 1.4l1.1-1.2A7 7 0 0 0 8 3.9 7 7 0 0 0 3.3 5.8L4.4 7c1-.9 2.2-1.4 3.6-1.4zM8 9a1.6 1.6 0 1 0 0 3.2A1.6 1.6 0 0 0 8 9z"/></svg><svg viewBox="0 0 27 12" fill="none"><rect x="0.5" y="0.5" width="23" height="11" rx="3.5" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="18" height="8" rx="2" fill="currentColor"/><path d="M25 4v4c.8-.3 1.4-1.1 1.4-2S25.8 4.3 25 4z" fill="currentColor" opacity="0.5"/></svg></span>';

function buildWorld() {
  const world = $("#world");
  world.innerHTML = "";
  S.frames.clear();
  for (const s of S.project.screens) {
    const dev = S.devices[s.device] ?? S.devices.desktop;
    const ab = document.createElement("div");
    ab.className = "artboard";
    ab.dataset.screen = s.id;
    const isPhoneFrame = s.device === "iphone" || s.device === "android";
    const light = s.statusBar === "light" ? " light" : "";
    let chrome = "", deco = "";
    if (["desktop", "laptop", "tablet"].includes(s.device)) chrome = `<div class="chrome"><span class="lights"><i></i><i></i><i></i></span><span class="url">${esc(s.address ?? (S.project.name ?? "").toLowerCase() + ".app")}</span><span></span></div>`;
    if (s.device === "iphone") deco = `<div class="island"></div><div class="statusbar${light}"><span>9:41</span>${STATUS_ICONS}</div><div class="home-indicator${light}"></div>`;
    if (s.device === "android") deco = `<div class="punch"></div><div class="statusbar${light}"><span>9:41</span>${STATUS_ICONS}</div>`;
    ab.innerHTML = `
      <div class="ab-label"><b data-fly="${esc(s.id)}">${esc(s.name ?? s.id)}</b>${s.state ? `<span class="state">${esc(s.state)}</span>` : ""}<span class="dim">${esc(dev.label)} · ${dev.width}${dev.autoHeight ? "" : "×" + dev.height}</span></div>
      <div class="device device-${esc(s.device)}">
        ${chrome}
        <div class="device-screen" style="width:${dev.width}px;height:${dev.height}px">
          <iframe title="${esc(s.name ?? s.id)}" width="${dev.width}" height="${dev.height}" scrolling="${dev.autoHeight ? "no" : "auto"}"></iframe>
          ${deco}
          <div class="overlay"></div>
        </div>
      </div>`;
    world.appendChild(ab);
    const frame = { s, dev, ab, iframe: $("iframe", ab), screenEl: $(".device-screen", ab), overlay: $(".overlay", ab), doc: null, win: null, tokenCache: null, phoneFrame: isPhoneFrame };
    S.frames.set(s.id, frame);
    frame.iframe.addEventListener("load", () => onFrameLoad(frame));
    frame.iframe.src = `/screen/${encodeURIComponent(s.id)}?v=${S.version}-${Date.now()}`;
  }
  layout();
  renderScreens();
}

function layout() {
  // One column per base screen; its states stack underneath.
  const GAP_X = 140, GAP_Y = 120, LABEL = 36;
  let x = 0;
  const base = S.project.screens.filter((s) => !s.of || !S.frames.has(s.of));
  for (const s of base) {
    const col = [s, ...S.project.screens.filter((o) => o.of === s.id)];
    let y = 0, w = 0;
    for (const c of col) {
      const f = S.frames.get(c.id);
      if (!f) continue;
      f.ab.style.left = x + "px";
      f.ab.style.top = y + "px";
      const dv = $(".device", f.ab);
      w = Math.max(w, dv.offsetWidth);
      y += dv.offsetHeight + GAP_Y + LABEL;
    }
    x += w + GAP_X;
  }
}

function reloadFrame(frame) {
  frame.ready = false;
  frame.iframe.src = `/screen/${encodeURIComponent(frame.s.id)}?v=${S.version}-${Date.now()}`;
}

function reloadAll() {
  const ids = S.project.screens.map((s) => s.id).join("|");
  const had = [...S.frames.keys()].join("|");
  if (ids !== had || S.project.screens.some((s) => S.frames.get(s.id)?.s.device !== s.device)) { buildWorld(); return; }
  for (const s of S.project.screens) { const f = S.frames.get(s.id); f.s = s; reloadFrame(f); }
  renderScreens();
}

function onFrameLoad(frame) {
  const doc = frame.iframe.contentDocument;
  if (!doc || !doc.body) return;
  frame.doc = doc; frame.win = frame.iframe.contentWindow; frame.tokenCache = null; frame.ready = true;
  doc.documentElement.classList.add("dc-" + S.mode);
  if (frame.dev.autoHeight) doc.documentElement.dataset.autoHeight = "";
  for (const op of [...S.sentOps, ...S.ops]) if (op.screen === frame.s.id) applyOpDom(frame, op);
  bindFrame(frame);
  if (frame.dev.autoHeight) {
    const fitH = () => {
      const h = Math.max(frame.dev.height, Math.ceil(doc.body.getBoundingClientRect().height));
      if (Math.abs(h - frame.iframe.offsetHeight) > 1) {
        frame.iframe.height = h; frame.screenEl.style.height = h + "px";
        layout(); drawAll();
      }
    };
    new frame.win.ResizeObserver(fitH).observe(doc.body);
    fitH();
    doc.fonts?.ready.then(fitH);
  }
  drawOverlay(frame);
  scheduleAudit();
  if (S.sel?.screen === frame.s.id) renderPanel();
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
  k = clamp(k, 0.08, 2.5);
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
    l = Math.min(l, x); t = Math.min(t, y - 40); r = Math.max(r, x + dv.offsetWidth); b = Math.max(b, y + Math.min(dv.offsetHeight, maxH));
  }
  return { l, t, r, b };
}

function fitBounds({ l, t, r, b }, fly = true, maxK = 1) {
  const c = $("#canvas").getBoundingClientRect();
  const pad = 56;
  const k = clamp(Math.min((c.width - pad * 2) / (r - l), (c.height - pad * 2) / (b - t)), 0.08, maxK);
  S.view.k = k;
  S.view.x = (c.width - (r - l) * k) / 2 - l * k;
  S.view.y = Math.max(pad, (c.height - (b - t) * k) / 2) - t * k;
  applyView(fly);
}

// Fit the first row (base screens) and the top of long pages; states and page bottoms are a pan away.
const fit = (fly = true) => fitBounds(boundsOf($$(".artboard").filter((a) => !S.project.screens.find((s) => s.id === a.dataset.screen)?.of), 1000), fly, 0.9);

function flyToScreen(id) {
  const f = S.frames.get(id);
  if (!f) return;
  const dv = $(".device", f.ab);
  const b = { l: f.ab.offsetLeft, t: f.ab.offsetTop - 40, r: f.ab.offsetLeft + dv.offsetWidth, b: f.ab.offsetTop + Math.min(dv.offsetHeight, 1400) };
  fitBounds(b, true, 1);
}

function flyToElement(screen, id) {
  const f = S.frames.get(screen), el = f && findEl(f, id);
  if (!el) return flyToScreen(screen);
  const r = el.getBoundingClientRect();
  const o = screenOrigin(f);
  const c = $("#canvas").getBoundingClientRect();
  const k = clamp(Math.min(S.view.k < 0.4 ? 0.7 : S.view.k, (c.width * 0.6) / r.width, (c.height * 0.6) / r.height), 0.2, 1.2);
  const cxw = o.x + r.left + r.width / 2, cyw = o.y + r.top + r.height / 2;
  S.view.k = k; S.view.x = c.width / 2 - cxw * k; S.view.y = c.height / 2 - cyw * k;
  applyView(true);
}

/** World coordinates of a frame's iframe origin. */
function screenOrigin(f) {
  const dv = $(".device", f.ab);
  let x = f.ab.offsetLeft + dv.offsetLeft + f.screenEl.offsetLeft, y = f.ab.offsetTop + dv.offsetTop + f.screenEl.offsetTop;
  // borders/padding of the device frame
  const cs = getComputedStyle(dv);
  x += parseFloat(cs.borderLeftWidth) || 0; y += parseFloat(cs.borderTopWidth) || 0;
  return { x, y };
}

function bindCanvas() {
  const c = $("#canvas");
  c.addEventListener("wheel", (e) => { e.preventDefault(); wheel(e.deltaX, e.deltaY, e.ctrlKey || e.metaKey, e.clientX, e.clientY); }, { passive: false });
  let pan = null;
  c.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".pin, .handle, iframe")) return;
    if (e.target.dataset.fly) { flyToScreen(e.target.dataset.fly); return; }
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
  window.addEventListener("resize", () => applyView());
}

function wheel(dx, dy, zoom, clientX, clientY) {
  const c = $("#canvas").getBoundingClientRect();
  if (zoom) zoomAt(S.view.k * Math.exp(-dy * 0.0085), clientX - c.left, clientY - c.top);
  else { S.view.x -= dx; S.view.y -= dy; applyView(); }
}

// ---------------------------------------------------------------------------------------------
// frame events: hover, select, edit text, drag to move

function findEl(f, id) { return f.doc?.querySelector(cssq(id)) ?? null; }
const idOf = (el) => el?.closest?.("[data-id]") ?? null;
const idParentEl = (el) => el.parentElement?.closest("[data-id]") ?? null;
function idChildrenEl(c) {
  const out = [];
  const rec = (x) => { for (const ch of x.children) { if (ch.dataset.id) out.push(ch); else rec(ch); } };
  rec(c);
  return out;
}
const toWindow = (f, x, y) => { const r = f.iframe.getBoundingClientRect(); return { x: r.left + x * S.view.k, y: r.top + y * S.view.k }; };

function bindFrame(f) {
  const doc = f.doc;
  doc.addEventListener("mousemove", (e) => {
    if (S.mode === "preview" || drag) return;
    const el = idOf(e.target);
    const h = el ? { screen: f.s.id, id: el.dataset.id } : null;
    if (h?.id !== S.hover?.id || h?.screen !== S.hover?.screen) { S.hover = h; drawAll(); }
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
    const el = idOf(e.target);
    if (S.mode === "comment") {
      const tgt = el ?? doc.body.firstElementChild;
      const r = tgt.getBoundingClientRect();
      draftComment(f, tgt.dataset?.id ?? null, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, toWindow(f, e.clientX, e.clientY));
      return;
    }
    select(el ? { screen: f.s.id, id: el.dataset.id } : null);
  }, true);
  doc.addEventListener("dblclick", (e) => {
    if (S.mode !== "select") return;
    e.preventDefault();
    const el = idOf(e.target);
    if (el && editableText(el)) { select({ screen: f.s.id, id: el.dataset.id }); startEdit(f, el); }
  }, true);
  doc.addEventListener("mousedown", (e) => {
    if (S.mode !== "select" || e.button !== 0 || editing) return;
    const el = idOf(e.target);
    if (!el || S.sel?.screen !== f.s.id || S.sel.id !== el.dataset.id) return;
    if (!idParentEl(el)) return;
    e.preventDefault();
    pendingDrag = { f, el, x: e.clientX, y: e.clientY };
  }, true);
  doc.addEventListener("mousemove", (e) => {
    if (pendingDrag && !drag && Math.hypot(e.clientX - pendingDrag.x, e.clientY - pendingDrag.y) > 5) beginDrag();
    if (drag) updateDrag(e.clientX, e.clientY, e.altKey);
  });
  doc.addEventListener("mouseup", () => { if (drag) endDrag(); pendingDrag = null; });
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("wheel", (e) => {
    const scroller = f.dev.autoHeight ? null : doc.querySelector(".ios-scroll, .md-scroll") ?? doc.scrollingElement;
    const canScroll = scroller && scroller.scrollHeight > scroller.clientHeight + 1 && !(e.ctrlKey || e.metaKey) && Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    if (canScroll) return;
    e.preventDefault();
    const p = toWindow(f, e.clientX, e.clientY);
    wheel(e.deltaX, e.deltaY, e.ctrlKey || e.metaKey, p.x, p.y);
  }, { passive: false });
  doc.addEventListener("scroll", () => drawOverlay(f), true);
}

let pendingDrag = null, drag = null, suppressClick = false;

function beginDrag() {
  const { f, el } = pendingDrag;
  drag = { f, el, from: { parent: idParentEl(el).dataset.id, index: idChildrenEl(idParentEl(el)).indexOf(el) }, target: null };
  el.style.pointerEvents = "none";
  el.dataset.dcDragging = "";
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
  delete el.dataset.dcDragging;
  drag = null; pendingDrag = null; suppressClick = true;
  setTimeout(() => (suppressClick = false), 50);
  if (!target) return drawOverlay(f);
  const parent = target.container.dataset.id;
  if (parent === from.parent && target.index === from.index) return drawOverlay(f);
  addOp({ op: "move", screen: f.s.id, id: el.dataset.id, parent, index: target.index, before: from });
}

function moveBy(delta) {
  const f = selFrame(), el = selEl();
  if (!el) return;
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
  if (after !== before) addOp({ op: "text", screen: f.s.id, id: el.dataset.id, value: after.trim(), before }, { applied: true });
}

// resize handles (live in the parent document; a shield keeps events away from iframes)
function startResize(e, dir) {
  e.preventDefault(); e.stopPropagation();
  const f = selFrame(), el = selEl();
  if (!el) return;
  const r0 = el.getBoundingClientRect();
  const before = { width: el.style.width || null, height: el.style.height || null, w: Math.round(r0.width), h: Math.round(r0.height) };
  const sx = e.clientX, sy = e.clientY;
  const shield = $("#shield");
  shield.classList.add("on");
  shield.style.cursor = dir === "e" ? "ew-resize" : dir === "s" ? "ns-resize" : "nwse-resize";
  let last = null;
  const move = (ev) => {
    const dx = (ev.clientX - sx) / S.view.k, dy = (ev.clientY - sy) / S.view.k;
    last = {};
    if (dir !== "s") { last.width = Math.max(8, snap(r0.width + dx)); el.style.width = last.width + "px"; el.style.maxWidth = "none"; }
    if (dir !== "e") { last.height = Math.max(8, snap(r0.height + dy)); el.style.height = last.height + "px"; }
    drawOverlay(f);
  };
  const up = () => {
    shield.classList.remove("on");
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    if (last) addOp({ op: "resize", screen: f.s.id, id: el.dataset.id, ...last, before: { width: before.w, height: before.h } }, { applied: true });
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------------------------------------
// ops

function describe(op) {
  switch (op.op) {
    case "text": return ["Text", `“${op.value}”`];
    case "style": return ["Style", `${op.prop}: ${op.token ? "--" + op.token : op.value}`];
    case "resize": return ["Resize", [op.width ? `w ${op.width}` : "", op.height ? `h ${op.height}` : ""].filter(Boolean).join(" · ") || "auto"];
    case "move": return ["Move", `to ${op.parent} #${op.index + 1}`];
    case "remove": return ["Delete", op.label ? `“${op.label}”` : ""];
    case "duplicate": return ["Duplicate", `→ ${op.id}${op.suffix}`];
    case "sketch": return ["Sketch", op.note];
  }
  return [op.op, ""];
}

function addOp(op, { applied = false } = {}) {
  const f = S.frames.get(op.screen);
  // Coalesce repeated edits of the same thing; keep the first `before`.
  const same = S.ops.findIndex((o) => o.screen === op.screen && o.id === op.id && o.op === op.op && (op.op === "text" || op.op === "resize" || (op.op === "style" && o.prop === op.prop)));
  if (same >= 0 && op.op !== "move") {
    op.before = S.ops[same].before;
    S.ops.splice(same, 1);
    if (op.op === "text" && op.value === op.before) { if (!applied) applyOpDom(f, op); afterOps(); return; }
  }
  // Successive moves of one element are one move; moving it back where it started is no move.
  const last = S.ops.at(-1);
  if (op.op === "move" && last?.op === "move" && last.screen === op.screen && last.id === op.id) {
    op.before = last.before;
    S.ops.pop();
    applyOpDom(f, op);
    if (!(op.before.parent === op.parent && op.before.index === op.index)) S.ops.push(op);
    afterOps();
    return;
  }
  S.ops.push(op);
  if (!applied) applyOpDom(f, op);
  if (op.op === "remove" && S.sel?.id === op.id) S.sel = null;
  afterOps();
}

function afterOps() {
  render();
  drawAll();
  scheduleAudit();
}

function undoOp(i) {
  const [op] = S.ops.splice(i, 1);
  if (!op) return;
  reloadFrame(S.frames.get(op.screen));
  render();
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
    case "style": if (el) el.style.setProperty(op.prop, op.value); break;
    case "resize":
      if (!el) break;
      if (op.width !== undefined) { el.style.width = op.width === null ? "" : op.width + "px"; el.style.maxWidth = "none"; }
      if (op.height !== undefined) el.style.height = op.height === null ? "" : op.height + "px";
      break;
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
  }
}

function uniqueId(f, base) {
  let k = 2;
  while (f.doc.querySelector(cssq(base + "-" + k)) || S.ops.some((o) => o.newId === base + "-" + k)) k++;
  return base + "-" + k;
}

// ---------------------------------------------------------------------------------------------
// selection & overlay

const selFrame = () => (S.sel ? S.frames.get(S.sel.screen) : null);
const selEl = () => { const f = selFrame(); return f ? findEl(f, S.sel.id) : null; };

function select(sel) {
  if (editing) endEdit(true);
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
  if (!f.doc) return;
  let html = "";
  if (S.mode !== "preview") {
    if (S.hover?.screen === f.s.id && S.hover.id !== S.sel?.id && !drag) {
      const el = findEl(f, S.hover.id);
      if (el) html += box(el.getBoundingClientRect(), "ov-hover", `<span class="tag">${esc(S.hover.id)}</span>`);
    }
    if (S.sel?.screen === f.s.id) {
      const el = findEl(f, S.sel.id);
      if (el) {
        const r = el.getBoundingClientRect();
        const handles = S.mode === "select" && !editing
          ? `${idParentEl(el) ? '<i class="handle grip" data-grip title="Drag to move (or ⌥↑ / ⌥↓)"></i>' : ""}<i class="handle e" data-h="e"></i><i class="handle s" data-h="s"></i><i class="handle se" data-h="se"></i>` : "";
        html += box(r, "ov-sel" + (drag ? " drag-src" : ""), `<span class="tag">${esc(S.sel.id)} · ${Math.round(r.width)}×${Math.round(r.height)}</span>${handles}`);
      }
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
    for (const iss of S.audit.highlight?.screen === f.s.id ? [S.audit.highlight] : []) {
      const el = findEl(f, iss.id);
      if (el) html += box(el.getBoundingClientRect(), "ov-issue");
    }
  }
  if (f.flash) { const el = f.doc.body.firstElementChild; if (el) html += box({ left: 0, top: 0, width: f.dev.width, height: f.iframe.offsetHeight }, "ov-flash"); }
  html += pinsFor(f);
  f.overlay.innerHTML = html;
  for (const h of $$("[data-h]", f.overlay)) h.addEventListener("pointerdown", (e) => startResize(e, h.dataset.h));
  const grip = $("[data-grip]", f.overlay);
  if (grip) grip.addEventListener("pointerdown", (e) => gripDrag(e, f));
  for (const p of $$(".pin", f.overlay)) p.addEventListener("click", (e) => { e.stopPropagation(); openThread(p.dataset.thread, p.dataset.draft); });
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

function flash(screenId) {
  const f = S.frames.get(screenId);
  if (!f) return;
  f.flash = true; drawOverlay(f);
  setTimeout(() => { f.flash = false; drawOverlay(f); }, 1900);
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
  let html = "";
  const list = S.threads.filter((t) => t.screen === f.s.id && (t.status === "open" || S.showResolved));
  for (const t of list) {
    const p = pinPos(f, t.target, t.x, t.y);
    const last = t.messages.at(-1)?.by;
    const cls = t.status === "resolved" ? "resolved" : last === "agent" ? "agent" : "waiting";
    html += `<button class="pin ${cls}" data-thread="${esc(t.id)}" style="left:${p.left}px;top:${p.top}px" title="${esc(t.messages[0]?.text)}">${esc(t.id.replace(/^c/, ""))}</button>`;
  }
  S.drafts.filter((d) => d.screen === f.s.id).forEach((d, i) => {
    const p = pinPos(f, d.target, d.x, d.y);
    html += `<button class="pin draft" data-draft="${i}" style="left:${p.left}px;top:${p.top}px" title="${esc(d.text)}">+</button>`;
  });
  return html;
}

function popover(html, at) {
  const p = $("#popover");
  p.innerHTML = html;
  p.classList.add("on");
  const w = 300, hgt = p.offsetHeight;
  p.style.left = clamp(at.x + 14, 8, innerWidth - w - 8) + "px";
  p.style.top = clamp(at.y - 20, 56, innerHeight - hgt - 8) + "px";
  const ta = $("textarea", p);
  ta?.focus();
  return p;
}
const closePopover = () => $("#popover").classList.remove("on");

function draftComment(f, target, x, y, at) {
  const p = popover(`<h4><span>Comment on <span class="mono">${esc(target ?? f.s.id)}</span></span></h4>
    <textarea placeholder="Ask a question or describe a change…"></textarea>
    <div class="foot"><span class="muted">⌘↩ to add</span><button class="btn-s" data-x>Cancel</button><button class="btn-s go" data-ok>Add</button></div>`, at);
  const ok = () => {
    const text = $("textarea", p).value.trim();
    if (!text) return;
    S.drafts.push({ screen: f.s.id, target, x, y, text });
    closePopover(); render(); drawOverlay(f);
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
  const f = [...S.frames.values()].find((x) => x.ready && x.doc?.body);
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
function runAudit() {
  const issues = [];
  const used = { text: new Map(), color: new Map(), space: new Map(), radius: new Map() };
  const bump = (m, k, off) => { const e = m.get(k) ?? { n: 0, off }; e.n++; m.set(k, e); };
  for (const f of S.frames.values()) {
    if (!f.ready || !f.doc?.body) continue;
    const win = f.win, tv = tokenValues(f);
    const ins = insets(f);
    const onSpace = (v) => ins.some((i) => (i === 0 ? tokenFor(tv.space, v) : near(v, i) || tokenFor(tv.space, v - i)));
    const seen = new Set();
    const add = (el, kind, sev, msg) => {
      const owner = idOf(el);
      const id = owner?.dataset.id ?? null;
      const key = `${id}|${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      issues.push({ screen: f.s.id, id, kind, sev, msg });
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
        const fgKey = ckey(fg);
        const ctok = tokenFor(tv.color, fgKey, true);
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
      if (f.dev.phone && !kit && el.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=switch], [data-goto]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.width < 43.5 || r.height < 43.5)) add(el, "tap", "warn", `Tap target ${Math.round(r.width)}×${Math.round(r.height)}, under 44×44`);
      }
      if (el.tagName === "IMG" && !el.hasAttribute("alt")) add(el, "a11y", "warn", "Image without alt text");
    }
    const ids = new Map();
    for (const el of f.doc.querySelectorAll("[data-id]")) { const n = (ids.get(el.dataset.id) ?? 0) + 1; ids.set(el.dataset.id, n); if (n === 2) add(el, "id", "error", `Duplicate data-id "${el.dataset.id}"`); }
    for (const el of f.doc.querySelectorAll("[data-sketch]")) add(el, "sketch", "info", "Sketch: the agent will build this");
  }
  for (const e of S.lint?.errors ?? []) issues.push({ screen: null, id: null, kind: "lint", sev: "error", msg: e.msg, where: e.where });
  for (const w of S.lint?.warnings ?? []) issues.push({ screen: null, id: null, kind: "lint", sev: "warn", msg: w.msg, where: w.where });
  S.audit.issues = issues; S.audit.used = used;
  renderAuditChip();
  if (S.tab === "audit") renderPanel();
}

// ---------------------------------------------------------------------------------------------
// rendering: chrome, left rail, right panel

function render() { stash(); renderScreens(); renderChanges(); renderTabs(); renderPanel(); renderSend(); renderBanner(); renderAuditChip(); }

function renderScreens() {
  const list = $("#screen-list");
  list.innerHTML = S.project.screens.map((s) => {
    const n = S.ops.filter((o) => o.screen === s.id).length + S.drafts.filter((d) => d.screen === s.id).length;
    const phone = S.devices[s.device]?.phone;
    return `<li><button class="screen-item${s.of ? " is-state" : ""}${S.sel?.screen === s.id ? " active" : ""}" data-fly="${esc(s.id)}">${phone ? ICONS.phone : ICONS.desktop}<span>${esc(s.name ?? s.id)}${s.state ? ` <span class="muted">· ${esc(s.state)}</span>` : ""}</span><span class="count">${n || ""}</span></button></li>`;
  }).join("");
}

function renderChanges() {
  const all = [...S.sentOps.map((o) => ({ o, sent: true })), ...S.ops.map((o, i) => ({ o, i }))];
  const nC = S.drafts.length + S.replies.length;
  $("#changes-count").textContent = S.ops.length + nC ? String(S.ops.length + nC) : "";
  const items = all.map(({ o, i, sent }) => {
    const [what, detail] = describe(o);
    return `<li class="change${sent ? " sent" : ""}"><span class="what">${what} <em>${esc(o.id ?? o.newId)}</em></span>${sent ? "" : `<button class="undo" data-undo="${i}" title="Undo">✕</button>`}<span class="detail">${esc(detail)}</span></li>`;
  });
  for (const d of S.drafts) items.push(`<li class="change"><span class="what">Comment <em>${esc(d.target ?? d.screen)}</em></span><span class="detail">${esc(d.text)}</span></li>`);
  for (const r of S.replies) items.push(`<li class="change"><span class="what">${r.resolve ? "Resolve" : "Reply"} <em>${esc(r.thread)}</em></span><span class="detail">${esc(r.text ?? "")}</span></li>`);
  $("#change-list").innerHTML = items.join("") || `<p class="empty">Edits and comments you make show up here until you send them.</p>`;
}

function renderTabs() {
  for (const b of $$(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === S.tab));
  const open = S.threads.filter((t) => t.status === "open");
  $("#n-comments").textContent = open.length + S.drafts.length ? String(open.length + S.drafts.length) : "";
  $("#n-audit").textContent = S.audit.issues.length ? String(S.audit.issues.length) : "";
}

function renderAuditChip() {
  const n = S.audit.issues.filter((i) => i.sev !== "info").length;
  $("#audit-label").textContent = n ? `${n} issue${n === 1 ? "" : "s"}` : "No issues";
  $("#audit-chip").classList.toggle("has-issues", n > 0);
  $("#n-audit").textContent = n ? String(n) : "";
}

function renderSend() {
  const n = S.ops.length + S.drafts.length + S.replies.length;
  $("#send-count").textContent = String(n);
  $("#send").disabled = n === 0 || S.phase !== "editing";
}

function renderBanner() {
  const b = $("#banner");
  if (S.phase === "sent") { b.innerHTML = `<span class="spinner"></span>Sent. Waiting for the agent to pick it up…`; b.classList.add("on"); }
  else if (S.phase === "applying") { b.innerHTML = `<span class="spinner"></span>The agent is applying your changes…`; b.classList.add("on"); }
  else b.classList.remove("on");
}

let toastT = null;
function toast(msg, ms = 3000) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), ms);
}

function renderPanel() {
  const p = $("#panel");
  if (S.tab === "audit") p.innerHTML = auditPanel();
  else if (S.tab === "comments") p.innerHTML = commentsPanel();
  else p.innerHTML = S.sel && selEl() ? inspector() : systemPanel();
}

// --- design system overview (nothing selected)
function systemPanel() {
  const colors = tokensIn("color"), text = tokensIn("text"), space = tokensIn("space"), radius = tokensIn("radius");
  const f = [...S.frames.values()].find((x) => x.ready);
  const font = tokensIn("font")[0];
  return `<div class="sec"><p class="hint">Click an element to inspect it. Double-click text to edit it. Drag the round grip to move, the square handles to resize.</p>
    <div class="keys"><kbd>Esc</kbd><span>Select parent</span><kbd>⌫</kbd><span>Delete</span><kbd>⌘D</kbd><span>Duplicate</span><kbd>⌥↑ ⌥↓</kbd><span>Reorder</span><kbd>⌘Z</kbd><span>Undo</span><kbd>⇧1</kbd><span>Fit all</span></div></div>
    <div class="sec"><h3>Color <span class="cur">${colors.length}</span></h3><div class="palette">${colors.map((t) => `<span class="sw" title="--${esc(t.name)}: ${esc(t.value)}" style="background:${esc(colorOf(t))}"></span>`).join("")}</div></div>
    <div class="sec"><h3>Type scale <span class="cur">${text.length}</span></h3><div class="scale-type">${text.slice().reverse().map((t) => `<div><code>${esc(t.name.replace(/^text-/, ""))}</code><span style="font-size:${esc(t.value)};font-family:${esc(font?.value ?? "inherit")};line-height:1.15">Aa</span><span class="muted mono">${esc(t.value)}</span></div>`).join("")}</div></div>
    <div class="sec"><h3>Spacing <span class="cur">${space.length}</span></h3><div class="space-bars">${space.map((t) => `<div><code style="width:64px">${esc(t.name)}</code><i style="width:min(160px, ${esc(t.value)})"></i>${esc(t.value)}</div>`).join("")}</div></div>
    <div class="sec"><h3>Radius</h3><div class="chips">${radius.map((t) => `<span class="tok" title="${esc(t.value)}">${esc(t.name.replace(/^radius-/, ""))}</span>`).join("")}</div></div>
    ${f ? "" : '<div class="sec"><p class="hint">Loading screens…</p></div>'}`;
}

// --- inspector
function inspector() {
  const f = selFrame(), el = selEl(), win = f.win;
  const cs = win.getComputedStyle(el);
  const tv = tokenValues(f);
  const id = S.sel.id;
  const crumbs = [];
  for (let n = idParentEl(el); n; n = idParentEl(n)) crumbs.unshift(n.dataset.id);
  const kids = idChildrenEl(el);
  const comp = el.dataset.component;
  const editable = editableText(el);
  const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || editable;
  const isBox = cs.display.includes("flex") || cs.display.includes("grid");

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
  const elOps = S.ops.map((o, i) => [o, i]).filter(([o]) => o.screen === S.sel.screen && (o.id === id || o.parent === id));
  const threads = S.threads.filter((t) => t.screen === S.sel.screen && t.target === id);

  return `<div class="sec">
      <div class="el-head"><span class="pill">&lt;${el.tagName.toLowerCase()}&gt;</span><span class="id">${esc(id)}</span>${comp ? `<span class="pill comp" title="Native component this maps to">${esc(comp)}</span>` : ""}</div>
      ${crumbs.length ? `<div class="crumbs">${crumbs.map((c) => `<button data-sel="${esc(c)}">${esc(c.split(".").at(-1))}</button><span>/</span>`).join("")}<b class="mono">${esc(id.split(".").at(-1))}</b></div>` : ""}
      ${kids.length ? `<p class="hint" style="margin-top:8px">${kids.length} child element${kids.length === 1 ? "" : "s"} · Enter on a child to select it</p>` : ""}
    </div>
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
    <div class="sec"><h3>Actions</h3><div class="actions">
      <button class="act" data-act="up"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 13V3M4 7l4-4 4 4"/></svg>Earlier <kbd>⌥↑</kbd></button>
      <button class="act" data-act="down"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M4 9l4 4 4-4"/></svg>Later <kbd>⌥↓</kbd></button>
      <button class="act" data-act="dup"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.8C3 3.3 3.3 3 3.8 3h6.7"/></svg>Duplicate <kbd>⌘D</kbd></button>
      <button class="act" data-act="sketch-after"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 1.6"><rect x="2" y="4" width="12" height="8" rx="1.5"/></svg>Sketch after</button>
      <button class="act" data-act="sketch-in"${kids.length || isBox ? "" : " disabled"}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5"/><rect x="5" y="7" width="6" height="4" rx="1" stroke-dasharray="1.6 1.2"/></svg>Sketch inside</button>
      <button class="act danger" data-act="del"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>Delete <kbd>⌫</kbd></button>
    </div>
    <button class="btn-s" data-act="comment" style="width:100%;margin-top:8px">Comment on this element for the agent…</button></div>
    ${threads.length ? `<div class="sec"><h3>Comments</h3>${threads.map((t) => `<button class="thread-item" style="padding:6px 0;border:0" data-thread="${esc(t.id)}"><div class="top"><span class="who ${t.by}"></span>${esc(t.id)} · ${t.status}</div><div class="txt">${esc(t.messages.at(-1)?.text)}</div></button>`).join("")}</div>` : ""}
    ${elOps.length ? `<div class="sec"><h3>Unsent edits here</h3>${elOps.map(([o, i]) => { const [w, d] = describe(o); return `<div class="change"><span class="what">${w}</span><button class="undo" data-undo="${i}">✕</button><span class="detail">${esc(d)}</span></div>`; }).join("")}</div>` : ""}
    <div class="sec"><h3>Custom CSS</h3><div class="row"><input class="mono" data-raw-prop placeholder="property" style="width:40%;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--raise)"><input class="mono" data-raw-val placeholder="value" style="flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--raise)"></div><p class="hint" style="margin-top:6px">Off-scale values are flagged to the agent. Prefer the token chips above.</p></div>`;
}

function auditPanel() {
  const { issues, used } = S.audit;
  const f = [...S.frames.values()].find((x) => x.ready);
  const u = (m, fmt) => [...(m?.entries() ?? [])].sort((a, b) => (typeof a[0] === "number" ? a[0] - b[0] : 0)).map(([k, e]) => fmt(k, e)).join("");
  const sum = used ? `<div class="sec audit-sum">
    <div><div class="lbl">Type sizes in use</div><div class="used">${u(used.text, (k, e) => `<span class="tok${e.off ? " off" : ""}" title="${e.n} element(s)${e.off ? ", not on the scale" : ""}">${k}</span>`)}</div></div>
    <div><div class="lbl">Colors in use</div><div class="used">${u(used.color, (k, e) => `<span class="sw${e.off ? " off" : ""}" style="background:${esc(k)}" title="${esc(k)} · ${e.n} use(s)${e.off ? " · not a token" : ""}"></span>`)}</div></div>
    <div><div class="lbl">Spacing in use</div><div class="used">${u(used.space, (k, e) => `<span class="tok${e.off ? " off" : ""}" title="${e.n} use(s)">${k}</span>`)}</div></div>
    <div><div class="lbl">Radii in use</div><div class="used">${u(used.radius, (k, e) => `<span class="tok${e.off ? " off" : ""}" title="${e.n} use(s)">${k}</span>`)}</div></div>
  </div>` : "";
  const groups = new Map();
  for (const i of issues) { const k = i.screen ?? "Source files"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const order = { error: 0, warn: 1, info: 2 };
  const list = [...groups].map(([k, arr]) => `<div class="issue-group">${esc(S.project.screens.find((s) => s.id === k)?.name ?? k)}</div>` + arr.sort((a, b) => order[a.sev] - order[b.sev]).map((i) => `<button class="issue" ${i.screen ? `data-issue-screen="${esc(i.screen)}" data-issue-id="${esc(i.id ?? "")}"` : ""}><span class="sev ${i.sev}"></span><span><span class="m">${esc(i.msg)}</span><br><span class="w">${esc(i.id ?? i.where ?? "")}</span></span></button>`).join("")).join("");
  return sum + (issues.length ? list : `<div class="sec"><p class="hint">${f ? "Everything on screen is on the scale, readable and tappable." : "Loading…"}</p></div>`)
    + `<div class="sec"><p class="hint">Checks every rendered element: type, color, spacing and radius against tokens.css; WCAG AA contrast; 44pt tap targets on phones; duplicate ids. Source lint (banned patterns, copy) comes from <span class="mono">canvas.mjs lint</span>.</p></div>`;
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

// ---------------------------------------------------------------------------------------------
// panel & chrome events

function bindChrome() {
  for (const b of $$(".modes button")) b.onclick = () => setMode(b.dataset.mode);
  for (const b of $$(".tabs button")) b.onclick = () => { S.tab = b.dataset.tab; if (S.tab === "audit") runAudit(); renderTabs(); renderPanel(); };
  $("#audit-chip").onclick = () => { S.tab = "audit"; runAudit(); renderTabs(); renderPanel(); };
  $("#zoom-in").onclick = () => { const c = $("#canvas").getBoundingClientRect(); zoomAt(S.view.k * 1.25, c.width / 2, c.height / 2); };
  $("#zoom-out").onclick = () => { const c = $("#canvas").getBoundingClientRect(); zoomAt(S.view.k / 1.25, c.width / 2, c.height / 2); };
  $("#zoom-label").onclick = () => fit();
  $("#send").onclick = openSend;
  $("#screen-list").onclick = (e) => { const b = e.target.closest("[data-fly]"); if (b) flyToScreen(b.dataset.fly); };
  $("#change-list").onclick = (e) => { const b = e.target.closest("[data-undo]"); if (b) undoOp(Number(b.dataset.undo)); };
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#popover, .pin")) closePopover(); });

  const panel = $("#panel");
  panel.addEventListener("click", (e) => {
    const t = e.target.closest("button, [data-swatch]");
    if (!t) return;
    const f = selFrame(), el = selEl();
    if (t.dataset.sel) return select({ screen: S.sel.screen, id: t.dataset.sel });
    if (t.dataset.undo) return undoOp(Number(t.dataset.undo));
    if (t.dataset.thread) { const th = S.threads.find((x) => x.id === t.dataset.thread); if (th) { flyToElement(th.screen, th.target); setTimeout(() => openThread(th.id), 600); } return; }
    if (t.dataset.draftOpen !== undefined) { const d = S.drafts[Number(t.dataset.draftOpen)]; flyToElement(d.screen, d.target); setTimeout(() => openThread(undefined, t.dataset.draftOpen), 600); return; }
    if (t.dataset.issueScreen) {
      const id = t.dataset.issueId || null;
      S.audit.highlight = id ? { screen: t.dataset.issueScreen, id } : null;
      if (id) { S.sel = { screen: t.dataset.issueScreen, id }; flyToElement(t.dataset.issueScreen, id); } else flyToScreen(t.dataset.issueScreen);
      drawAll(); renderScreens();
      setTimeout(() => { S.audit.highlight = null; drawAll(); }, 3000);
      return;
    }
    if (!el) return;
    if (t.dataset.style) {
      const prop = t.dataset.style;
      const value = t.dataset.token ? `var(--${t.dataset.token})` : t.dataset.raw;
      const before = el.style.getPropertyValue(prop) || f.win.getComputedStyle(el).getPropertyValue(prop);
      addOp({ op: "style", screen: S.sel.screen, id: S.sel.id, prop, value, token: t.dataset.token ?? (t.dataset.raw === "transparent" ? "none" : undefined), before });
      return;
    }
    if (t.dataset.auto) { addOp({ op: "resize", screen: S.sel.screen, id: S.sel.id, [t.dataset.auto]: null, before: {} }); return; }
    const act = t.dataset.act;
    if (act === "up") moveBy(-1);
    else if (act === "down") moveBy(1);
    else if (act === "dup") duplicate();
    else if (act === "del") remove();
    else if (act === "sketch-after" || act === "sketch-in") sketch(act === "sketch-in");
    else if (act === "comment") {
      const r = el.getBoundingClientRect();
      draftComment(f, S.sel.id, 0.95, 0.1, toWindow(f, r.right, r.top));
    }
  });
  panel.addEventListener("input", (e) => {
    if (e.target.dataset.copy !== undefined) {
      const el = selEl();
      if (!el) return;
      const before = S.ops.find((o) => o.op === "text" && o.id === S.sel.id && o.screen === S.sel.screen)?.before ?? el.textContent;
      el.textContent = e.target.value;
      addOp({ op: "text", screen: S.sel.screen, id: S.sel.id, value: e.target.value, before }, { applied: true });
      // keep the caret: re-render only the overlay & lists
    }
  });
  panel.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.showResolved !== undefined) { S.showResolved = t.checked; renderPanel(); drawAll(); return; }
    const el = selEl();
    if (!el) return;
    if (t.dataset.size) {
      const v = parseInt(t.value, 10);
      if (v > 0) addOp({ op: "resize", screen: S.sel.screen, id: S.sel.id, [t.dataset.size]: v, before: {} });
    }
    if (t.matches("[data-raw-val]")) {
      const prop = $("[data-raw-prop]", panel).value.trim();
      if (prop && t.value.trim()) addOp({ op: "style", screen: S.sel.screen, id: S.sel.id, prop, value: t.value.trim(), before: getComputedStyle(el).getPropertyValue(prop) });
    }
  });
}

// The text input re-renders the panel through addOp → render(). Keep typing smooth by restoring focus.
const _renderPanel = renderPanel;
renderPanel = function () {
  const a = document.activeElement;
  const copy = a?.dataset?.copy !== undefined ? { start: a.selectionStart, end: a.selectionEnd } : null;
  _renderPanel();
  if (copy) { const t = $("[data-copy]"); if (t) { t.focus(); t.setSelectionRange(copy.start, copy.end); } }
};

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
  if (!el || !idParentEl(el)) return;
  const nid = uniqueId(f, S.sel.id);
  const suffix = nid.slice(S.sel.id.length);
  addOp({ op: "duplicate", screen: f.s.id, id: S.sel.id, suffix });
  select({ screen: f.s.id, id: nid });
}

function remove() {
  const f = selFrame(), el = selEl();
  if (!el || !idParentEl(el)) return toast("The screen root can't be deleted.");
  const parent = idParentEl(el).dataset.id;
  addOp({ op: "remove", screen: f.s.id, id: S.sel.id, label: el.textContent.trim().replace(/\s+/g, " ").slice(0, 60) });
  select({ screen: f.s.id, id: parent });
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
    select({ screen: f.s.id, id: newId });
  };
  $("[data-ok]", p).onclick = ok;
  $("[data-x]", p).onclick = closePopover;
  $("textarea", p).onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ok(); } if (e.key === "Escape") closePopover(); };
}

function openSend() {
  const nE = S.ops.length, nC = S.drafts.length, nR = S.replies.length;
  const b = $("#send").getBoundingClientRect();
  const p = popover(`<h4><span>Send to the agent</span></h4>
    <p class="hint" style="margin-bottom:8px">${nE} edit${nE === 1 ? "" : "s"}${nC ? `, ${nC} comment${nC === 1 ? "" : "s"}` : ""}${nR ? `, ${nR} repl${nR === 1 ? "y" : "ies"}` : ""}. The agent applies them to the source, keeps the design system consistent, and the canvas reloads.</p>
    <textarea placeholder="Anything overall? (optional) e.g. “calmer, less color”"></textarea>
    <div class="foot"><span class="muted">⌘↩</span><button class="btn-s" data-x>Cancel</button><button class="btn-s go" data-ok>Send</button></div>`, { x: b.left - 330, y: b.bottom + 10 });
  const go = async () => {
    const note = $("textarea", p).value.trim();
    const payload = {
      base: S.version, note,
      ops: S.ops.map(({ applied, ...o }) => o),
      comments: [...S.drafts.map((d) => ({ screen: d.screen, target: d.target, x: d.x, y: d.y, text: d.text })), ...S.replies],
    };
    const r = await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) { toast((await r.json().catch(() => ({}))).error ?? "Send failed"); return; }
    S.sentOps = [...S.sentOps, ...S.ops]; S.ops = []; S.drafts = []; S.replies = [];
    S.phase = "sent";
    closePopover();
    await loadProject();
    render(); drawAll();
  };
  $("[data-ok]", p).onclick = go;
  $("[data-x]", p).onclick = closePopover;
  $("textarea", p).onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go(); if (e.key === "Escape") closePopover(); };
}

function onKey(e) {
  const t = e.target;
  const typing = t.closest?.("input, textarea, [contenteditable]") || (editing && editing.el.contains(t));
  if (editing && (t === editing.el || editing.el.contains(t))) {
    if (e.key === "Escape") { e.preventDefault(); endEdit(false); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); editing.el.blur(); }
    return;
  }
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") {
    if ($("#popover").classList.contains("on")) return closePopover();
    const el = selEl();
    const p = el && idParentEl(el);
    select(p ? { screen: S.sel.screen, id: p.dataset.id } : null);
    return;
  }
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (S.ops.length) undoOp(S.ops.length - 1); return; }
  if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
  if (mod) return;
  if (e.key === "v" || e.key === "V") return setMode("select");
  if (e.key === "c" || e.key === "C") return setMode("comment");
  if (e.key === "p" || e.key === "P") return setMode("preview");
  if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) return fit();
  if (e.key === "@" || (e.shiftKey && e.code === "Digit2")) { if (S.sel) flyToElement(S.sel.screen, S.sel.id); return; }
  if (e.key === "=" || e.key === "+") { const c = $("#canvas").getBoundingClientRect(); return zoomAt(S.view.k * 1.25, c.width / 2, c.height / 2); }
  if (e.key === "-") { const c = $("#canvas").getBoundingClientRect(); return zoomAt(S.view.k / 1.25, c.width / 2, c.height / 2); }
  if (!S.sel) return;
  if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); remove(); }
  else if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); moveBy(-1); }
  else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); moveBy(1); }
  else if (e.key === "Enter") {
    e.preventDefault();
    const f = selFrame(), el = selEl();
    if (!el) return;
    const kids = idChildrenEl(el);
    if (e.shiftKey) { const p = idParentEl(el); if (p) select({ screen: S.sel.screen, id: p.dataset.id }); }
    else if (kids.length) select({ screen: S.sel.screen, id: kids[0].dataset.id });
    else if (editableText(el)) startEdit(f, el);
  } else if (e.key === "Tab") {
    e.preventDefault();
    const el = selEl(), p = el && idParentEl(el);
    if (!p) return;
    const sibs = idChildrenEl(p), i = sibs.indexOf(el);
    const n = sibs[(i + (e.shiftKey ? -1 : 1) + sibs.length) % sibs.length];
    select({ screen: S.sel.screen, id: n.dataset.id });
  }
}

boot();
