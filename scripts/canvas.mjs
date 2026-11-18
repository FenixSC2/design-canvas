#!/usr/bin/env node
// design-canvas CLI. Run with:  node <skill>/scripts/canvas.mjs <command> <design-dir> [options]
//
//   init    <dir> [--name N] [--device D]   scaffold design.json, tokens.css, components.css and one screen
//   serve   <dir> [--port N]                start the canvas (foreground; run it in the background), print its URL.
//                                           Reuses a canvas already serving this dir; skips ports serving another.
//   wait    <dir> [--timeout S]             block until the user presses Send (or asks for variants / a test), then show it
//   show    <dir>                           print the pending changeset with line numbers and a to-do list
//   apply   <dir>                           apply text/remove/move/duplicate/attribute edits, picked variants and the
//                                           user's answer to a proposal; prints what is left for you
//   done    <dir> [--summary S]             lint, then release the design to the GUI (it reloads). Refuses on lint errors.
//   lint    <dir>                           static checks: tokens, ids, banned patterns, motion, states, sketches, copy
//   reply   <dir> <thread> <text> [--resolve]   answer a comment thread (the user sees it on the pin)
//   ask     <dir> <screen> <data-id|-> <text>   pin a question of yours on an element for the user
//   comments <dir> [--all]                  list comment threads (open ones by default)
//   variants <dir>                          check variants.json and list the open sets
//   propose <dir> start                     copy the design into proposal/ for you to edit
//   propose <dir> --title T --summary S [--request R] [--question "Q|option|option"]...
//                                           publish proposal/ as a proposal the user accepts or rejects on the canvas
//   propose <dir> --withdraw                drop the proposal
//   compare <dir> [screen...] [--image screen=file.png]... [--simulator] [--url base]
//                                           screenshot the build and the mocks, diff them, show the result on the canvas
//   components <dir>                        the component catalog: classes, instances, screens
//   spec    <dir> [screen]                  component tree per screen: ids, tags, classes, ⟨native component⟩, motion, copy
//   status  <dir>                           server, pending changeset, proposal, variants, comparisons, comments

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEVICES, MOTION, paths, readJson, writeJson, loadProject, readComments, writeComments, readState, readVariants, versionOf,
  parseTokens, lintProject, formatChangeset, applyMechanical, MECHANICAL, specOf, indexIds, componentCatalog, platformOf,
} from "./lib.mjs";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, dirArg, ...rest] = process.argv.slice(2);
const VALUELESS = new Set(["--resolve", "--all", "--simulator", "--withdraw"]);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] ?? "" : undefined; };
const opts = (name) => rest.flatMap((a, i) => (a === `--${name}` && rest[i + 1] !== undefined ? [rest[i + 1]] : []));
const flag = (name) => rest.includes(`--${name}`);
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--") && !VALUELESS.has(rest[i - 1])));
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const now = () => new Date().toISOString();

if (!cmd || cmd === "help" || cmd === "--help") {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  console.log(src.slice(0, src.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
if (!dirArg) die(`usage: canvas.mjs ${cmd} <design-dir>`);
const P = paths(dirArg);

// ---------------------------------------------------------------------------------------------

async function init() {
  if (fs.existsSync(P.design)) die(`${P.design} already exists.`);
  const device = opt("device") ?? "desktop";
  if (!DEVICES[device]) die(`Unknown device ${device}. One of: ${Object.keys(DEVICES).join(", ")}`);
  const name = opt("name") ?? path.basename(path.dirname(P.dir));
  fs.mkdirSync(path.join(P.dir, "screens"), { recursive: true });
  writeJson(P.design, {
    name, summary: "", defaultDevice: device, fonts: [],
    breakpoints: platformOf(device) === "web" ? [834, 390] : undefined,
    screens: [{ id: "home", name: "Home", file: "screens/home.html", device }],
  });
  const tpl = path.join(SKILL, "templates");
  for (const f of ["tokens.css", "components.css"]) fs.copyFileSync(path.join(tpl, f), path.join(P.dir, f));
  fs.copyFileSync(path.join(tpl, "screen.html"), path.join(P.dir, "screens", "home.html"));
  writeComments(dirArg, { threads: [] });
  fs.writeFileSync(path.join(P.dir, ".gitignore"), ".canvas/\nchangeset*.json\n");
  console.log(`Created ${P.dir}: design.json, tokens.css, components.css, screens/home.html.
Replace the template tokens with this project's design system before drawing screens.`);
}

// ---------------------------------------------------------------------------------------------
// Server

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".gif": "image/gif" };

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(600) });
    if (!r.ok) return "other";
    const j = await r.json();
    return j.app === "design-canvas" ? j.dir : "other";
  } catch { return null; }
}

const makeServer = () => http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e?.stack ?? e)); }));

async function serve() {
  loadProject(dirArg); // fail early
  let port = Number(opt("port") ?? 5299);
  for (let tries = 0; tries < 30; tries++, port++) {
    const served = await probe(port);
    if (served === null) break;
    if (served !== "other" && fs.realpathSync(served) === fs.realpathSync(P.dir)) {
      console.log(`Canvas already running for this design: http://localhost:${port}/`);
      return;
    }
  }
  const server = makeServer();
  server.listen(port, "127.0.0.1", () => {
    fs.mkdirSync(P.internal, { recursive: true });
    writeJson(path.join(P.internal, "server.json"), { port, pid: process.pid, startedAt: now() });
    console.log(`Canvas for ${P.dir}\n  http://localhost:${port}/`);
  });
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendFile(res, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "not found", "text/plain");
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
}

const within = (base, rel) => { const f = path.resolve(base, "." + path.sep + rel); return (f.startsWith(base + path.sep) || f === base) && !rel.split("/").some((s) => s.startsWith(".")) ? f : null; };

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** Writes only from the canvas itself: blocks other sites (CSRF) and DNS-rebinding hosts. */
function trusted(req) {
  const host = req.headers.host ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}` || origin === `http://${host.replace(/^127\.0\.0\.1/, "localhost")}` || origin === `http://${host.replace(/^localhost/, "127.0.0.1")}`;
}

function newest(dir, name) {
  let t = 0;
  try { for (const d of fs.readdirSync(dir)) { const f = path.join(dir, d, name); if (fs.existsSync(f)) t = Math.max(t, fs.statSync(f).mtimeMs); } } catch { /* none */ }
  return t || null;
}

function statusOf() {
  const st = readState(dirArg);
  return {
    app: "design-canvas", dir: P.dir, version: versionOf(dirArg),
    phase: fs.existsSync(P.applying) ? "applying" : fs.existsSync(P.changeset) ? "sent" : "editing",
    done: st.done ?? null,
    compareAt: newest(P.compare, "report.json"),
    proposal: fs.existsSync(P.proposalMeta),
  };
}

function compareReports() {
  const out = [];
  try { for (const d of fs.readdirSync(P.compare)) { const r = readJson(path.join(P.compare, d, "report.json")); if (r) out.push(r); } } catch { /* none */ }
  return out;
}

function fontsOf(project) { return (project.fonts ?? []).map((u) => `<link rel="stylesheet" href="${u}">`).join("\n"); }

function documentFor({ project, s, frag, platform, device, base = "/design/", extraCss = "" }) {
  const dev = DEVICES[device] ?? DEVICES.desktop;
  const kit = platform === "web" ? "" : `<link rel="stylesheet" href="/kit/${platform}.css">`;
  return `<!doctype html>
<html lang="en" data-device="${device}" data-platform="${platform}" data-screen="${s.id}"${dev.autoHeight ? " data-auto-height" : ""}>
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${s.name ?? s.id}</title>
${fontsOf(project)}
<link rel="stylesheet" href="/kit/base.css">
${kit}
<link rel="stylesheet" href="/kit/motion.css">
<link rel="stylesheet" href="${base}tokens.css">
<link rel="stylesheet" href="${base}components.css">
<link rel="stylesheet" href="/kit/runtime.css">
${extraCss ? `<style data-dc-variant>\n${extraCss}\n</style>` : ""}
</head>
<body>
${frag}
</body>
</html>`;
}

function catalogDocument(project, platform) {
  const cat = componentCatalog(dirArg)[platform] ?? [];
  const device = platform === "ios" ? "iphone" : platform === "android" ? "android" : "desktop";
  const STATES = ["hover", "focus", "pressed", "disabled"];
  const cell = (c, state, i) => {
    let h = c.html.replace(/data-id="([^"]+)"/g, (_, id) => `data-id="cat.${c.cls}.${state}.${i}.${id.split(".").at(-1)}"`);
    h = h.replace(/^<([a-zA-Z][\w-]*)/, (m) => `${m} data-cat-class="${c.cls}"${state === "default" ? "" : ` data-dc-state="${state}"`}${state === "disabled" ? ' disabled aria-disabled="true"' : ""}`);
    h = h.replace(/\sdata-goto="[^"]*"/g, "");
    return `<figure class="dc-cell"><div class="dc-stage">${h}</div><figcaption>${state}</figcaption></figure>`;
  };
  const sections = cat.map((c, i) => `
  <section class="dc-comp" data-id="cat.${c.cls}">
    <header><h2>.${c.cls}${c.base ? ` <span>modifier of .${c.base}</span>` : ""}</h2><p>${c.count} use${c.count === 1 ? "" : "s"} · ${c.screens.join(", ")}</p></header>
    <div class="dc-cells">${[cell(c, "default", i), ...(c.interactive ? STATES.map((st) => cell(c, st, i)) : [])].join("")}</div>
  </section>`).join("");
  const frag = `<main class="dc-catalog" data-id="cat" data-platform-catalog="${platform}">${sections || '<p class="dc-empty">No shared components on these screens yet.</p>'}</main>`;
  // Rendered with the platform's kit and fonts, but as a growing page rather than a phone viewport.
  return documentFor({ project, s: { id: `__components-${platform}`, name: "Components" }, frag, platform, device: "desktop" }).replace(`data-device="desktop"`, `data-device="desktop" data-catalog="${device}"`);
}

function spliceVariant(frag, set, option) {
  const node = indexIds(frag).ids.get(set.target);
  if (!node) return frag;
  return frag.slice(0, node.start) + option.html + frag.slice(node.end);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/" || p === "/index.html") return sendFile(res, path.join(SKILL, "gui", "index.html"));
  if (p.startsWith("/gui/")) return sendFile(res, within(path.join(SKILL, "gui"), p.slice(5)));
  if (p.startsWith("/kit/")) return sendFile(res, within(path.join(SKILL, "kit"), p.slice(5)));
  if (p.startsWith("/design/")) return sendFile(res, within(P.dir, p.slice(8)));
  if (p.startsWith("/proposal-files/")) return sendFile(res, within(P.proposal, p.slice(16)));
  if (p.startsWith("/compare/")) return sendFile(res, within(P.compare, p.slice(9)));

  if (p === "/api/status") return send(res, 200, statusOf());

  if (p === "/api/project") {
    const project = loadProject(dirArg);
    const tokens = fs.existsSync(P.tokens) ? parseTokens(fs.readFileSync(P.tokens, "utf8")) : [];
    const cat = componentCatalog(dirArg);
    return send(res, 200, {
      project, tokens, devices: DEVICES, motion: MOTION, comments: readComments(dirArg), status: statusOf(), lint: lintProject(dirArg),
      variants: readVariants(dirArg).sets.filter((s) => s.status !== "resolved"),
      proposal: readJson(P.proposalMeta),
      proposalScreens: fs.existsSync(P.proposalMeta) ? (readJson(path.join(P.proposal, "design.json"))?.screens ?? []).map((s) => ({ ...s, device: s.device ?? project.defaultDevice ?? "desktop" })) : [],
      compare: compareReports(),
      catalog: Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, v.map((c) => ({ cls: c.cls, base: c.base, count: c.count, screens: c.screens, interactive: c.interactive }))])),
    });
  }

  const cm = p.match(/^\/screen\/__components-(web|ios|android)$/);
  if (cm) return send(res, 200, catalogDocument(loadProject(dirArg), cm[1]), "text/html; charset=utf-8");

  const sm = p.match(/^\/screen\/([^/]+)$/);
  if (sm) {
    const fromProposal = url.searchParams.get("proposal") === "1" && fs.existsSync(P.proposalMeta);
    const root = fromProposal ? P.proposal : P.dir;
    const project = fromProposal ? readJson(path.join(P.proposal, "design.json")) ?? loadProject(dirArg) : loadProject(dirArg);
    for (const s of project.screens) { s.device ??= project.defaultDevice ?? "desktop"; s.file ??= `screens/${s.id}.html`; }
    const s = project.screens.find((x) => x.id === sm[1]);
    if (!s) return send(res, 404, "no such screen", "text/plain");
    const f = within(root, s.file);
    let frag = f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : `<p style="padding:24px">Missing file ${s.file}</p>`;
    let extraCss = "";
    const v = url.searchParams.get("variant");
    if (v) {
      const [setId, optId] = v.split("/");
      const set = readVariants(dirArg).sets.find((x) => x.id === setId);
      const o = set?.options?.find((x) => x.id === optId);
      if (set && o) { frag = spliceVariant(frag, set, o); extraCss = o.css ?? ""; }
    }
    return send(res, 200, documentFor({ project, s, frag, platform: platformOf(s.device), device: s.device, base: fromProposal ? "/proposal-files/" : "/design/", extraCss }), "text/html; charset=utf-8");
  }

  if (p === "/api/send" && req.method === "POST") {
    if (!trusted(req)) return send(res, 403, { error: "Not from the canvas." });
    if (fs.existsSync(P.changeset) || fs.existsSync(P.applying)) return send(res, 409, { error: "The agent hasn't finished the last send yet." });
    const b = await body(req);
    const c = readComments(dirArg);
    let next = c.threads.reduce((m, t) => Math.max(m, Number(String(t.id).replace(/\D/g, "")) || 0), 0) + 1;
    const out = [];
    for (const cm of b.comments ?? []) {
      if (cm.thread) {
        const t = c.threads.find((x) => x.id === cm.thread);
        if (!t) continue;
        if (cm.text) t.messages.push({ by: "user", text: cm.text, at: now() });
        if (cm.resolve) t.status = "resolved";
        out.push({ thread: t.id, screen: t.screen, target: t.target, text: cm.text ?? "", reply: !!cm.text, resolve: !!cm.resolve, question: t.messages[0]?.text });
      } else {
        const id = `c${next++}`;
        c.threads.push({ id, screen: cm.screen, target: cm.target ?? null, x: cm.x ?? 0.5, y: cm.y ?? 0.5, status: "open", by: "user", messages: [{ by: "user", text: cm.text, at: now() }] });
        out.push({ thread: id, screen: cm.screen, target: cm.target ?? null, text: cm.text });
      }
    }
    writeComments(dirArg, c);
    let rid = Date.now() % 100000;
    const requests = (b.requests ?? []).map((r) => ({ ...r, rid: `r${rid++}` }));
    let proposal;
    if (b.proposal) {
      const meta = readJson(P.proposalMeta) ?? {};
      proposal = { ...b.proposal, title: meta.title, systemChanged: !!meta.changed?.system };
    }
    writeJson(P.changeset, { sentAt: now(), base: b.base, note: b.note || undefined, ops: b.ops ?? [], comments: out, requests, proposal, variants: b.variants });
    return send(res, 200, { ok: true });
  }

  send(res, 404, "not found", "text/plain");
}

// ---------------------------------------------------------------------------------------------
// Agent loop

const pending = () => readJson(P.changeset) ?? readJson(P.applying);

async function wait() {
  const timeout = Number(opt("timeout") ?? 3600) * 1000;
  const t0 = Date.now();
  while (!fs.existsSync(P.changeset)) {
    if (Date.now() - t0 > timeout) die("Timed out waiting for the user to send.", 2);
    await new Promise((r) => setTimeout(r, 700));
  }
  await new Promise((r) => setTimeout(r, 150));
  show();
}

function show() {
  const cs = pending();
  if (!cs) return console.log("Nothing pending. The user hasn't sent anything since the last `done`.");
  console.log(formatChangeset(dirArg, cs, { applied: cs.appliedOps ? new Set(cs.ops.filter((_, i) => cs.appliedOps.includes(i))) : undefined }));
}

/** Copy what the user accepted from proposal/ into the design, then drop the proposal. */
function applyProposal(pr) {
  const meta = readJson(P.proposalMeta);
  if (!meta) return ["  ✗ proposal: proposal/ is gone; nothing to copy"];
  const report = [];
  if (pr.decision !== "rejected") {
    const cur = loadProject(dirArg), prop = readJson(path.join(P.proposal, "design.json"));
    const accepted = new Set(pr.accepted ?? []);
    if (pr.system && meta.changed?.system) {
      for (const f of ["tokens.css", "components.css"]) if (fs.existsSync(path.join(P.proposal, f))) fs.copyFileSync(path.join(P.proposal, f), path.join(P.dir, f));
      for (const k of Object.keys(prop)) if (k !== "screens") cur[k] = prop[k];
      report.push("  ✓ proposal: tokens, components and project settings");
    }
    const propIds = new Set(prop.screens.map((s) => s.id));
    for (const id of accepted) {
      const ps = prop.screens.find((s) => s.id === id);
      if (ps) {
        ps.file ??= `screens/${id}.html`;
        fs.mkdirSync(path.dirname(path.join(P.dir, ps.file)), { recursive: true });
        fs.copyFileSync(path.join(P.proposal, ps.file), path.join(P.dir, ps.file));
        const i = cur.screens.findIndex((s) => s.id === id);
        if (i >= 0) cur.screens[i] = ps;
        else { const at = prop.screens.findIndex((s) => s.id === id); cur.screens.splice(Math.min(at, cur.screens.length), 0, ps); }
        report.push(`  ✓ proposal: ${id}${i >= 0 ? "" : " (new screen)"}`);
      } else if (!propIds.has(id)) {
        cur.screens = cur.screens.filter((s) => s.id !== id);
        report.push(`  ✓ proposal: removed ${id}`);
      }
    }
    writeJson(P.design, cur);
  }
  fs.rmSync(P.proposal, { recursive: true, force: true });
  if (pr.decision === "rejected") report.push("  ✓ proposal: rejected and discarded");
  return report;
}

function apply() {
  if (!fs.existsSync(P.changeset) && !fs.existsSync(P.applying)) die("Nothing to apply.");
  if (fs.existsSync(P.changeset)) fs.renameSync(P.changeset, P.applying);
  const cs = readJson(P.applying);
  const report = [];
  if (cs.proposal && !cs.proposalApplied) { report.push(...applyProposal(cs.proposal)); cs.proposalApplied = true; }
  const project = loadProject(dirArg);
  const appliedIdx = new Set(cs.appliedOps ?? []);
  const vfile = readVariants(dirArg);
  cs.ops.forEach((op, i) => {
    if (appliedIdx.has(i) || !MECHANICAL.has(op.op)) return;
    const s = project.screens.find((x) => x.id === op.screen);
    if (!s) return report.push(`  ✗ #${i + 1} ${op.op} ${op.id}: unknown screen ${op.screen}`);
    const f = path.join(P.dir, s.file);
    const r = applyMechanical(fs.readFileSync(f, "utf8"), op);
    if (!r.ok) return report.push(`  ✗ #${i + 1} ${op.op} ${op.id}: ${r.why}. Do it by hand.`);
    fs.writeFileSync(f, r.html);
    appliedIdx.add(i);
    report.push(`  ✓ #${i + 1} ${op.op} ${op.id}`);
    if (op.op === "pick-variant") {
      if (op.css?.trim()) fs.appendFileSync(P.components, `\n/* variant ${op.set}/${op.option} for ${op.id}: fold into the component rules, then delete this marker */\n${op.css.trim()}\n/* end variant ${op.set}/${op.option} */\n`);
      const set = vfile.sets.find((x) => x.id === op.set);
      if (set) { set.status = "resolved"; set.picked = op.option; }
    }
  });
  for (const v of cs.variants ?? []) {
    const set = vfile.sets.find((x) => x.id === v.set);
    if (set && set.status !== "resolved") { set.status = "resolved"; set.picked = null; report.push(`  ✓ variants ${v.set}: none picked${v.note ? ` ("${v.note}")` : ""}`); }
  }
  if (vfile.sets.length) writeJson(P.variants, { sets: vfile.sets });
  cs.appliedOps = [...appliedIdx];
  writeJson(P.applying, cs);
  if (report.length) console.log("Applied to source:\n" + report.join("\n") + "\n");
  console.log(formatChangeset(dirArg, cs, { applied: new Set(cs.ops.filter((_, i) => appliedIdx.has(i))) }));
}

function printLint(r) {
  for (const [k, list] of [["error", r.errors], ["warn", r.warnings], ["info", r.info]])
    for (const x of list) console.log(`${k.padEnd(5)}  ${x.where}  ${x.msg}`);
  console.log(`${r.errors.length} error(s), ${r.warnings.length} warning(s), ${r.info.length} info`);
}

function lint() {
  const r = lintProject(dirArg);
  printLint(r);
  process.exit(r.errors.length ? 1 : 0);
}

function done() {
  const r = lintProject(dirArg);
  if (r.errors.length) { printLint(r); die("\nFix the errors, then run done again."); }
  const cs = pending();
  if (cs) {
    fs.mkdirSync(P.history, { recursive: true });
    writeJson(path.join(P.history, `${Date.now()}.json`), cs);
  }
  for (const f of [P.changeset, P.applying]) fs.rmSync(f, { force: true });
  const st = readState(dirArg);
  writeJson(P.state, { version: (st.version ?? 0) + 1, done: { at: now(), summary: opt("summary") ?? "" } });
  if (r.warnings.length) printLint(r);
  console.log("Released to the canvas. It reloads with your changes.");
}

function reply() {
  const [thread, text] = positional;
  if (!thread || !text) die('usage: reply <dir> <thread> "text" [--resolve]');
  const c = readComments(dirArg);
  const t = c.threads.find((x) => x.id === thread);
  if (!t) die(`No thread ${thread}. Threads: ${c.threads.map((x) => x.id).join(", ")}`);
  t.messages.push({ by: "agent", text, at: now() });
  if (flag("resolve")) t.status = "resolved";
  writeComments(dirArg, c);
  console.log(`Replied on ${thread}${flag("resolve") ? " and resolved it" : ""}.`);
}

function ask() {
  const [screen, target, text] = positional;
  if (!screen || !target || !text) die('usage: ask <dir> <screen> <data-id|-> "question"');
  const project = loadProject(dirArg);
  if (!project.screens.some((s) => s.id === screen)) die(`No screen ${screen}`);
  const c = readComments(dirArg);
  const id = `c${c.threads.reduce((m, t) => Math.max(m, Number(String(t.id).replace(/\D/g, "")) || 0), 0) + 1}`;
  c.threads.push({ id, screen, target: target === "-" ? null : target, x: 0.92, y: 0.08, status: "open", by: "agent", messages: [{ by: "agent", text, at: now() }] });
  writeComments(dirArg, c);
  console.log(`Pinned ${id} on ${screen}${target === "-" ? "" : " › " + target}.`);
}

function comments() {
  const c = readComments(dirArg);
  const list = c.threads.filter((t) => flag("all") || t.status === "open");
  if (!list.length) return console.log("No open comments.");
  for (const t of list) {
    const turn = t.messages.at(-1)?.by === "user" ? "your turn" : "user's turn";
    console.log(`${t.id}  ${t.status}  ${t.screen}${t.target ? " › " + t.target : ""}  (${turn})`);
    for (const m of t.messages) console.log(`    ${m.by.padEnd(5)}  ${m.text}`);
  }
}

function variants() {
  const r = lintProject(dirArg);
  const errs = r.errors.filter((e) => e.where === "variants.json");
  for (const e of errs) console.log(`error  ${e.msg}`);
  const open = readVariants(dirArg).sets.filter((s) => s.status !== "resolved");
  if (!open.length) console.log("No open variant sets.");
  for (const s of open) {
    console.log(`${s.id}  ${s.screen} › ${s.target}${s.prompt ? `  "${s.prompt}"` : ""}`);
    for (const o of s.options ?? []) console.log(`    ${o.id}  ${o.label ?? ""}${o.rationale ? "  · " + o.rationale : ""}`);
  }
  process.exit(errs.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Proposals: you edit a full copy of the design; the user sees it as a diff on the canvas.

const sameFile = (a, b) => fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));

function propose() {
  if (flag("withdraw")) { fs.rmSync(P.proposal, { recursive: true, force: true }); return console.log("Proposal withdrawn."); }
  if (positional[0] === "start") {
    if (fs.existsSync(P.proposal)) die(`${P.proposal} already exists. Edit it, or run propose --withdraw to start over.`);
    const project = loadProject(dirArg);
    fs.mkdirSync(path.join(P.proposal, "screens"), { recursive: true });
    for (const f of ["design.json", "tokens.css", "components.css"]) if (fs.existsSync(path.join(P.dir, f))) fs.copyFileSync(path.join(P.dir, f), path.join(P.proposal, f));
    for (const s of project.screens) { fs.mkdirSync(path.dirname(path.join(P.proposal, s.file)), { recursive: true }); fs.copyFileSync(path.join(P.dir, s.file), path.join(P.proposal, s.file)); }
    return console.log(`Copied the design into ${P.proposal}. Edit the files there (add screens to its design.json), then:\n  propose ${dirArg} --title "…" --summary "…" [--question "Q|option|option"]`);
  }
  const title = opt("title"), summary = opt("summary");
  if (!title || !summary) die('usage: propose <dir> start | propose <dir> --title "…" --summary "…" [--request "…"] [--question "Q|opt|opt"]… | --withdraw');
  if (!fs.existsSync(path.join(P.proposal, "design.json"))) die("No proposal/ yet. Run `propose <dir> start` first.");
  if (fs.existsSync(P.changeset)) die("The user has sent edits you haven't applied. Apply them first, then propose.");
  const r = lintProject(P.proposal);
  if (r.errors.length) { printLint(r); die("\nThe proposal has lint errors."); }
  const cur = loadProject(dirArg), prop = loadProject(P.proposal);
  const curIds = new Set(cur.screens.map((s) => s.id)), propIds = new Set(prop.screens.map((s) => s.id));
  const changed = {
    screens: prop.screens.filter((s) => curIds.has(s.id) && !sameFile(path.join(P.dir, cur.screens.find((c) => c.id === s.id).file), path.join(P.proposal, s.file))).map((s) => s.id),
    added: prop.screens.filter((s) => !curIds.has(s.id)).map((s) => s.id),
    removed: cur.screens.filter((s) => !propIds.has(s.id)).map((s) => s.id),
    system: !sameFile(P.tokens, path.join(P.proposal, "tokens.css")) || !sameFile(P.components, path.join(P.proposal, "components.css")),
  };
  if (!changed.screens.length && !changed.added.length && !changed.removed.length && !changed.system && !opts("question").length) die("The proposal changes nothing yet.");
  const questions = opts("question").map((q, i) => { const [question, ...options] = q.split("|").map((x) => x.trim()); return { id: `q${i + 1}`, question, options }; });
  writeJson(P.proposalMeta, { title, summary, request: opt("request"), questions, changed, createdAt: now() });
  console.log(`Proposal "${title}" is on the canvas: ${[changed.screens.length && `${changed.screens.length} changed`, changed.added.length && `${changed.added.length} new`, changed.removed.length && `${changed.removed.length} removed`, changed.system && "tokens/components changed"].filter(Boolean).join(", ") || "questions only"}.`);
}

// ---------------------------------------------------------------------------------------------
// Compare the build with the mocks.

async function compare() {
  const { launchBrowser, simulatorScreenshot, decodePNG, encodePNG, resize, diffImages, idsForRegion, compareElements } = await import("./capture.mjs");
  const project = loadProject(dirArg);
  const build = project.build ?? {};
  const images = Object.fromEntries(opts("image").map((x) => { const i = x.indexOf("="); return [x.slice(0, i), path.resolve(x.slice(i + 1))]; }));
  // A URL (a dev server), or a folder relative to the design (a static build on disk).
  const rawUrl = opt("url") ?? build.web?.url;
  const webUrl = !rawUrl ? null : /^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : pathToFileURL(path.resolve(P.dir, rawUrl) + path.sep).href;
  const wanted = positional.length ? positional : project.screens.map((s) => s.id);
  const jobs = [];
  for (const id of wanted) {
    const s = project.screens.find((x) => x.id === id);
    if (!s) { console.log(`✗ ${id}: no such screen`); continue; }
    const pf = platformOf(s.device);
    if (images[id]) jobs.push({ s, kind: "image", src: images[id] });
    else if (pf === "web" && webUrl && build.web?.routes?.[id] !== undefined) jobs.push({ s, kind: "web", src: new URL(build.web.routes[id], webUrl).href });
    else if (pf === "ios" && flag("simulator")) jobs.push({ s, kind: "simulator", src: build.ios?.links?.[id] ?? null });
    else if (positional.length) console.log(`✗ ${id}: no build source. Map it in design.json "build" (web routes / ios links), or pass --image ${id}=shot.png${pf === "ios" ? " or --simulator" : ""}.`);
  }
  if (!jobs.length) die('Nothing to compare. Add a "build" block to design.json (see references/format.md), or pass --image screen=file.png.');

  // Serve the mocks from this process so compare works whether or not the canvas is open.
  const server = makeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  let simShown = false;
  try {
    for (const job of jobs) {
      const { s } = job, dev = DEVICES[s.device];
      const out = path.join(P.compare, s.id);
      fs.mkdirSync(out, { recursive: true });
      const mockShot = await browser.capture(`${base}/screen/${encodeURIComponent(s.id)}`, { width: dev.width, height: dev.height, fullPage: dev.autoHeight, collectIds: true });
      const mock = decodePNG(mockShot.png);
      let buildImg, buildIds = null;
      try {
        if (job.kind === "web") { const shot = await browser.capture(job.src, { width: dev.width, height: dev.height, fullPage: dev.autoHeight, still: false, settle: 1200, collectIds: true }); buildImg = decodePNG(shot.png); buildIds = shot.ids; }
        else if (job.kind === "image") buildImg = decodePNG(fs.readFileSync(job.src));
        else {
          if (!job.src && simShown) { console.log(`✗ ${s.id}: no deep link in build.ios.links, so it can't be opened in the simulator. Pass --image instead.`); continue; }
          buildImg = decodePNG(simulatorScreenshot({ link: job.src }));
          simShown = true;
        }
      } catch (e) { console.log(`✗ ${s.id}: ${e.message}`); continue; }
      // Device screenshots come at @2x/@3x: bring them to the mock's point size.
      if (buildImg.width !== dev.width) buildImg = resize(buildImg, dev.width, Math.round(buildImg.height * (dev.width / buildImg.width)));
      const mask = dev.phone && !dev.autoHeight ? [{ x: 0, y: 0, w: dev.width, h: s.device === "iphone" ? 54 : 36 }, { x: 0, y: dev.height - 34, w: dev.width, h: 34 }] : [];
      const d = diffImages(mock, buildImg, { mask });
      for (const r of d.regions) r.ids = idsForRegion(r, mockShot.ids ?? []);
      fs.writeFileSync(path.join(out, "mock.png"), encodePNG(mock));
      fs.writeFileSync(path.join(out, "build.png"), encodePNG(buildImg));
      fs.writeFileSync(path.join(out, "diff.png"), encodePNG(d.image));
      const source = job.kind === "web" ? job.src : job.kind === "simulator" ? `simulator${job.src ? " " + job.src : ""}` : path.basename(job.src);
      const report = { screen: s.id, at: now(), source, mode: "pixels", mismatch: +d.mismatch.toFixed(4), width: d.width, height: d.height, heightDelta: d.heightDelta, regions: d.regions.slice(0, 12) };
      // When the build carries the mock's ids, compare element by element instead of pixel by pixel.
      const mockIds = mockShot.ids ?? [];
      if (buildIds && buildIds.length >= Math.max(3, mockIds.length * 0.3)) {
        const e = compareElements(mock, mockIds, buildImg, buildIds);
        const flagged = new Set(e.elements.map((x) => x.id));
        Object.assign(report, { mode: "elements", mismatch: +(flagged.size / Math.max(1, e.total)).toFixed(4), pixelMismatch: report.mismatch, matched: e.matched, total: e.total, extra: e.extra.slice(0, 20), elements: e.elements.slice(0, 20), regions: [] });
      }
      writeJson(path.join(out, "report.json"), report);
      const delta = d.heightDelta ? `  · build is ${Math.abs(d.heightDelta)}px ${d.heightDelta > 0 ? "taller" : "shorter"}` : "";
      if (report.mode === "elements") {
        console.log(`${s.id}  ${report.total - new Set(report.elements.map((x) => x.id)).size}/${report.total} elements match  (${source})${delta}`);
        for (const x of report.elements.slice(0, 8)) console.log(`    ${x.kind.padEnd(8)} ${x.id}  ${x.detail}`);
        if (report.extra.length) console.log(`    extra    in the build only: ${report.extra.slice(0, 6).join(", ")}`);
      } else {
        console.log(`${s.id}  ${(d.mismatch * 100).toFixed(1)}% of pixels differ  (${source})${delta}`);
        for (const r of report.regions.slice(0, 5)) console.log(`    ${r.w}×${r.h} at ${r.x},${r.y}${r.ids.length ? "  ⟶ " + r.ids.join(", ") : ""}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\nImages in ${P.compare}. The canvas shows each comparison next to its mock.`);
}

function components() {
  const cat = componentCatalog(dirArg);
  for (const [pf, list] of Object.entries(cat)) {
    if (!list.length) continue;
    console.log(pf);
    for (const c of list) console.log(`  .${c.cls}${c.base ? ` (modifier of .${c.base})` : ""}${c.interactive ? "  [interactive]" : ""}  ${c.count} use(s) on ${c.screens.join(", ")}`);
  }
}

function spec() {
  console.log(specOf(dirArg, positional[0]));
}

async function status() {
  const sj = readJson(path.join(P.internal, "server.json"));
  const live = sj ? await probe(sj.port) : null;
  console.log(live && live !== "other" ? `Canvas: http://localhost:${sj.port}/` : "Canvas: not running");
  const cs = pending();
  console.log(cs ? `Pending: ${cs.ops.length} edit(s), ${cs.comments.length} comment(s), ${cs.requests?.length ?? 0} request(s)${fs.existsSync(P.applying) ? " (applying)" : ""}` : "Pending: nothing");
  const meta = readJson(P.proposalMeta);
  if (meta) console.log(`Proposal: "${meta.title}" waiting for the user`);
  const open = readVariants(dirArg).sets.filter((s) => s.status !== "resolved");
  if (open.length) console.log(`Variants: ${open.map((s) => s.id).join(", ")} waiting for the user`);
  const reps = compareReports();
  if (reps.length) console.log(`Compared: ${reps.map((r) => `${r.screen} ${(r.mismatch * 100).toFixed(1)}%`).join(", ")}`);
  const c = readComments(dirArg);
  const openT = c.threads.filter((t) => t.status === "open");
  console.log(`Comments: ${openT.length} open (${openT.filter((t) => t.messages.at(-1)?.by === "user").length} waiting on you)`);
}

// ---------------------------------------------------------------------------------------------
// Dispatch last, so every const above is initialized.
const commands = { init, serve, wait, show, apply, done, lint, reply, ask, comments, variants, propose, compare, components, spec, status };
if (!commands[cmd]) die(`Unknown command "${cmd}". Run with --help.`);
await commands[cmd]();
