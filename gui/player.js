// Prototype player: click through the screens at real size, with the screen transitions and
// entrance motion they're designed with. Two stacked iframes; the next screen loads behind the
// current one and arrives with its data-transition (push, sheet, fade, none).

import { S, $, esc, applyAllOps, ICONS_STATUS } from "./app.js";

let P = null;

const css = (doc, name, fallback) => doc?.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue(name).trim() || fallback;

export function openPlayer(startId) {
  const screens = S.project.screens;
  const start = screens.find((s) => s.id === startId) ?? screens.find((s) => !s.of) ?? screens[0];
  if (!start) return;
  const root = $("#player");
  root.innerHTML = `
    <div class="pl-bar">
      <button class="btn-s" data-pl="back" title="Back (←)">←</button>
      <span class="pl-title"></span>
      <span class="pl-flex"></span>
      <label class="pl-opt"><input type="checkbox" data-pl="slow"> Slow motion ×4</label>
      <label class="pl-opt"><input type="checkbox" data-pl="reduce"> Reduce motion</label>
      <button class="btn-s" data-pl="restart" title="Replay this screen (R)">Replay</button>
      <button class="btn-s" data-pl="close" title="Close (Esc)">Close</button>
    </div>
    <div class="pl-stage"><div class="pl-device"><div class="pl-screen"><iframe class="pl-a"></iframe><iframe class="pl-b"></iframe></div></div></div>
    <p class="pl-hint">Click anything that links to another screen. Transitions and entrance motion play as designed.</p>`;
  root.classList.add("on");
  P = { stack: [], cur: $(".pl-a", root), next: $(".pl-b", root), slow: false, reduce: false, busy: false };
  root.querySelector("[data-pl=close]").onclick = closePlayer;
  root.querySelector("[data-pl=back]").onclick = back;
  root.querySelector("[data-pl=restart]").onclick = () => show(P.stack.at(-1), "none", false, true);
  root.querySelector("[data-pl=slow]").onchange = (e) => { P.slow = e.target.checked; };
  root.querySelector("[data-pl=reduce]").onchange = (e) => { P.reduce = e.target.checked; for (const f of [P.cur, P.next]) f.contentDocument?.documentElement.classList.toggle("dc-reduce-motion", P.reduce); };
  show(start.id, "none");
}

export function closePlayer() {
  $("#player").classList.remove("on");
  $("#player").innerHTML = "";
  P = null;
}

export const playerOpen = () => !!P;

export function playerKey(e) {
  if (!P) return false;
  if (e.key === "Escape") { closePlayer(); return true; }
  if (e.key === "ArrowLeft" || e.key === "Backspace") { back(); return true; }
  if (e.key === "r" || e.key === "R") { show(P.stack.at(-1), "none", false, true); return true; }
  return true;
}

function sizeFor(s) {
  const dev = S.devices[s.device] ?? S.devices.desktop;
  const stage = $(".pl-stage").getBoundingClientRect();
  const h = dev.autoHeight ? Math.min(dev.height, stage.height - 40) : dev.height;
  const k = Math.min(1, (stage.width - 40) / dev.width, (stage.height - 40) / (h + (dev.phone && !dev.autoHeight ? 26 : 0)));
  return { dev, w: dev.width, h, k };
}

function frameDevice(s) {
  const { dev, w, h, k } = sizeFor(s);
  const d = $(".pl-device");
  d.className = `pl-device device device-${s.device}`;
  d.style.transform = `scale(${k})`;
  const scr = $(".pl-screen");
  scr.style.width = w + "px"; scr.style.height = h + "px";
  for (const f of [P.cur, P.next]) { f.style.width = w + "px"; f.style.height = h + "px"; }
  d.querySelectorAll(".pl-deco").forEach((x) => x.remove());
  if (s.device === "iphone") scr.insertAdjacentHTML("beforeend", `<div class="pl-deco island"></div><div class="pl-deco statusbar${s.statusBar === "light" ? " light" : ""}"><span>9:41</span>${ICONS_STATUS}</div><div class="pl-deco home-indicator${s.statusBar === "light" ? " light" : ""}"></div>`);
  return dev;
}

function load(iframe, id) {
  return new Promise((resolve) => {
    iframe.onload = () => {
      const doc = iframe.contentDocument;
      doc.documentElement.classList.toggle("dc-reduce-motion", P.reduce);
      applyAllOps(doc, id);
      doc.addEventListener("click", (e) => {
        const g = e.target.closest("[data-goto]");
        if (e.target.closest("a[href], button, [data-goto]")) e.preventDefault();
        if (g && iframe === P.cur) navigate(g.dataset.goto, g.dataset.transition);
      }, true);
      doc.addEventListener("keydown", (e) => { if (playerKey(e)) e.preventDefault(); });
      if (P.slow) for (const a of doc.getAnimations()) a.playbackRate = 0.25;
      // Let web fonts arrive (briefly) so the screen doesn't slide in with fallback type.
      Promise.race([doc.fonts?.ready ?? Promise.resolve(), new Promise((r) => setTimeout(r, 250))]).then(() => setTimeout(() => resolve(doc), 16));
    };
    iframe.src = `/screen/${encodeURIComponent(id)}?v=${S.version}-${Date.now()}`;
  });
}

function navigate(id, transition) {
  if (!S.project.screens.some((s) => s.id === id) || P.busy) return;
  const from = S.project.screens.find((s) => s.id === P.stack.at(-1));
  const to = S.project.screens.find((s) => s.id === id);
  const phone = S.devices[to.device]?.phone;
  const tr = transition ?? (from && from.device !== to.device ? "fade" : phone ? "push" : "fade");
  show(id, tr);
}

function back() {
  if (!P || P.stack.length < 2 || P.busy) return;
  const leaving = P.stack.pop();
  const prev = P.stack.pop();
  show(prev, P.lastTransition?.[leaving] ?? "push", true);
}

async function show(id, transition, reverse = false, replay = false) {
  if (!id) return;
  P.busy = true;
  const s = S.project.screens.find((x) => x.id === id);
  const sameDevice = P.stack.length && S.project.screens.find((x) => x.id === P.stack.at(-1))?.device === s.device;
  const cur = P.cur, next = P.next;
  next.style.visibility = "hidden";
  const doc = await load(next, id);
  if (!sameDevice || replay) { frameDevice(s); transition = "none"; }
  $(".pl-title").innerHTML = `<b>${esc(s.name ?? s.id)}</b>${s.state ? ` <span class="muted">· ${esc(s.state)}</span>` : ""}`;
  $("[data-pl=back]").disabled = P.stack.length < (replay ? 2 : 1);
  if (!replay) { P.stack.push(id); P.lastTransition ??= {}; if (!reverse) P.lastTransition[id] = transition; }

  // Timing from the design's own tokens, so the player shows what the build should do.
  const raw = css(doc, "--duration-slow", "440ms");
  const base = raw.endsWith("ms") ? parseFloat(raw) : raw.endsWith("s") ? parseFloat(raw) * 1000 : 440;
  const dur = (base || 440) * (P.slow ? 4 : 1) * (P.reduce ? 0.5 : 1);
  const ease = css(doc, "--ease-out", "cubic-bezier(0.22, 1, 0.36, 1)");
  const t = P.reduce && transition !== "none" ? "fade" : transition;
  next.style.visibility = "visible";
  next.style.zIndex = reverse ? 1 : 2; cur.style.zIndex = reverse ? 2 : 1;
  const o = { duration: dur, easing: ease, fill: "both" };
  const anims = [];
  if (t === "push") {
    anims.push(next.animate(reverse ? [{ transform: "translateX(-30%)", filter: "brightness(0.8)" }, { transform: "none", filter: "none" }] : [{ transform: "translateX(100%)" }, { transform: "none" }], o));
    anims.push(cur.animate(reverse ? [{ transform: "none" }, { transform: "translateX(100%)" }] : [{ transform: "none", filter: "none" }, { transform: "translateX(-30%)", filter: "brightness(0.8)" }], o));
  } else if (t === "sheet") {
    anims.push(next.animate(reverse ? [{ transform: "scale(0.94)", filter: "brightness(0.7)" }, { transform: "none", filter: "none" }] : [{ transform: "translateY(100%)" }, { transform: "none" }], o));
    anims.push(cur.animate(reverse ? [{ transform: "none" }, { transform: "translateY(100%)" }] : [{ transform: "none", filter: "none" }, { transform: "scale(0.94)", filter: "brightness(0.7)" }], o));
  } else if (t === "fade") {
    anims.push(next.animate([{ opacity: 0 }, { opacity: 1 }], { ...o, duration: dur * 0.6 }));
  }
  // Chrome holds animations on an iframe pending until its first paint; start them now instead.
  const t0 = document.timeline.currentTime;
  for (const a of anims) a.startTime = t0;
  await Promise.all(anims.map((a) => a.finished.catch(() => {})));
  for (const a of anims) a.cancel();
  cur.style.visibility = "hidden";
  cur.removeAttribute("src");
  P.cur = next; P.next = cur;
  P.busy = false;
}
