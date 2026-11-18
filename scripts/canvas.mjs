#!/usr/bin/env node
// design-canvas CLI. Run with:  node <skill>/scripts/canvas.mjs <command> <design-dir> [options]
//
//   init    <dir> [--name N] [--device D]   scaffold design.json, tokens.css, components.css and one screen
//   serve   <dir> [--port N]                start the canvas (foreground; run it in the background), print its URL.
//                                           Reuses a canvas already serving this dir; skips ports serving another.
//   wait    <dir> [--timeout S]             block until the user presses Send, then show the changeset (exit 2 on timeout)
//   show    <dir>                           print the pending changeset with line numbers and a to-do list
//   apply   <dir>                           apply text/remove/move/duplicate edits to the screen files; the GUI
//                                           shows "agent working" until `done`. Prints what is left for you.
//   done    <dir> [--summary S]             lint, then release the design to the GUI (it reloads). Refuses on lint errors.
//   lint    <dir>                           static checks: tokens, data-ids, banned patterns, sketches, copy
//   reply   <dir> <thread> <text> [--resolve]   answer a comment thread (the user sees it on the pin)
//   ask     <dir> <screen> <data-id|-> <text>   pin a question of yours on an element for the user
//   comments <dir> [--all]                  list comment threads (open ones by default)
//   spec    <dir> [screen]                  component tree per screen: ids, tags, classes, ⟨native component⟩, copy
//   status  <dir>                           server, pending changeset and open comments at a glance

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  DEVICES, paths, readJson, writeJson, loadProject, readComments, writeComments, readState, versionOf,
  parseTokens, lintProject, formatChangeset, applyMechanical, MECHANICAL, specOf,
} from "./lib.mjs";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, dirArg, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] ?? "" : undefined; };
const flag = (name) => rest.includes(`--${name}`);
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--") && !["--resolve", "--all"].includes(rest[i - 1])));
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const now = () => new Date().toISOString();

if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
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
    screens: [{ id: "home", name: "Home", file: "screens/home.html", device }],
  });
  const tpl = path.join(SKILL, "templates");
  for (const f of ["tokens.css", "components.css"]) fs.copyFileSync(path.join(tpl, f), path.join(P.dir, f));
  fs.copyFileSync(path.join(tpl, "screen.html"), path.join(P.dir, "screens", "home.html"));
  writeComments(dirArg, { threads: [] });
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
  const server = http.createServer((req, res) => handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e?.stack ?? e)); }));
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
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, "not found", "text/plain");
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
}

const within = (base, rel) => { const f = path.resolve(base, "." + path.sep + rel); return f.startsWith(base + path.sep) || f === base ? f : null; };

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function statusOf() {
  const st = readState(dirArg);
  return {
    app: "design-canvas", dir: P.dir, version: versionOf(dirArg),
    phase: fs.existsSync(P.applying) ? "applying" : fs.existsSync(P.changeset) ? "sent" : "editing",
    done: st.done ?? null,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/" || p === "/index.html") return sendFile(res, path.join(SKILL, "gui", "index.html"));
  if (p.startsWith("/gui/")) { const f = within(path.join(SKILL, "gui"), p.slice(5)); return f ? sendFile(res, f) : send(res, 403, "no"); }
  if (p.startsWith("/kit/")) { const f = within(path.join(SKILL, "kit"), p.slice(5)); return f ? sendFile(res, f) : send(res, 403, "no"); }
  if (p.startsWith("/design/")) { const f = within(P.dir, p.slice(8)); return f && !p.includes("/.") ? sendFile(res, f) : send(res, 403, "no"); }

  if (p === "/api/status") return send(res, 200, statusOf());

  if (p === "/api/project") {
    const project = loadProject(dirArg);
    const tokens = fs.existsSync(P.tokens) ? parseTokens(fs.readFileSync(P.tokens, "utf8")) : [];
    return send(res, 200, { project, tokens, devices: DEVICES, comments: readComments(dirArg), status: statusOf(), lint: lintProject(dirArg) });
  }

  const sm = p.match(/^\/screen\/([^/]+)$/);
  if (sm) {
    const project = loadProject(dirArg);
    const s = project.screens.find((x) => x.id === sm[1]);
    if (!s) return send(res, 404, "no such screen", "text/plain");
    const f = within(P.dir, s.file);
    const frag = f && fs.existsSync(f) ? fs.readFileSync(f, "utf8") : `<p style="padding:24px">Missing file ${s.file}</p>`;
    const dev = DEVICES[s.device] ?? DEVICES.desktop;
    const platform = s.device === "iphone" ? "ios" : s.device === "android" ? "android" : "web";
    const fonts = (project.fonts ?? []).map((u) => `<link rel="stylesheet" href="${u}">`).join("\n");
    const kit = platform === "web" ? "" : `<link rel="stylesheet" href="/kit/${platform}.css">`;
    const html = `<!doctype html>
<html lang="en" data-device="${s.device}" data-platform="${platform}" data-screen="${s.id}"${dev.autoHeight ? " data-auto-height" : ""} style="--device-w:${dev.width}px;--device-h:${dev.height}px">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${s.name ?? s.id}</title>
${fonts}
<link rel="stylesheet" href="/kit/base.css">
${kit}
<link rel="stylesheet" href="/design/tokens.css">
<link rel="stylesheet" href="/design/components.css">
<link rel="stylesheet" href="/kit/runtime.css">
</head>
<body>
${frag}
</body>
</html>`;
    return send(res, 200, html, "text/html; charset=utf-8");
  }

  if (p === "/api/send" && req.method === "POST") {
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
    writeJson(P.changeset, { sentAt: now(), base: b.base, note: b.note || undefined, ops: b.ops ?? [], comments: out });
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

function apply() {
  if (!fs.existsSync(P.changeset) && !fs.existsSync(P.applying)) die("Nothing to apply.");
  if (fs.existsSync(P.changeset)) fs.renameSync(P.changeset, P.applying);
  const cs = readJson(P.applying);
  const project = loadProject(dirArg);
  const appliedIdx = new Set(cs.appliedOps ?? []);
  const report = [];
  cs.ops.forEach((op, i) => {
    if (appliedIdx.has(i) || !MECHANICAL.has(op.op)) return;
    const s = project.screens.find((x) => x.id === op.screen);
    if (!s) return report.push(`  ✗ #${i + 1} ${op.op} ${op.id}: unknown screen ${op.screen}`);
    const f = path.join(P.dir, s.file);
    const r = applyMechanical(fs.readFileSync(f, "utf8"), op);
    if (r.ok) { fs.writeFileSync(f, r.html); appliedIdx.add(i); report.push(`  ✓ #${i + 1} ${op.op} ${op.id}`); }
    else report.push(`  ✗ #${i + 1} ${op.op} ${op.id}: ${r.why}. Do it by hand.`);
  });
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

function spec() {
  console.log(specOf(dirArg, positional[0]));
}

async function status() {
  const sj = readJson(path.join(P.internal, "server.json"));
  const live = sj ? await probe(sj.port) : null;
  console.log(live && live !== "other" ? `Canvas: http://localhost:${sj.port}/` : "Canvas: not running");
  const cs = pending();
  console.log(cs ? `Pending: ${cs.ops.length} edit(s), ${cs.comments.length} comment(s)${fs.existsSync(P.applying) ? " (applying)" : ""}` : "Pending: nothing");
  const c = readComments(dirArg);
  const open = c.threads.filter((t) => t.status === "open");
  console.log(`Comments: ${open.length} open (${open.filter((t) => t.messages.at(-1)?.by === "user").length} waiting on you)`);
}

// ---------------------------------------------------------------------------------------------
// Dispatch last, so every const above is initialized.
const commands = { init, serve, wait, show, apply, done, lint, reply, ask, comments, spec, status };
if (!commands[cmd]) die(`Unknown command "${cmd}". Run with --help.`);
await commands[cmd]();
