// Screenshots and image diffs with no dependencies: headless Chrome over the DevTools protocol
// (Node's built-in WebSocket), a small PNG codec on node:zlib, and a region-finding diff.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------------------------
// Chrome

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const p of mac) if (fs.existsSync(p)) return p;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    try { const p = execFileSync("which", [bin], { encoding: "utf8" }).trim(); if (p) return p; } catch { /* next */ }
  }
  return null;
}

export async function launchBrowser() {
  const bin = findChrome();
  if (!bin) throw new Error("No Chrome, Chromium, Edge or Brave found. Install one or set CHROME_PATH.");
  if (typeof WebSocket === "undefined") throw new Error("This needs Node 22+ (built-in WebSocket).");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "design-canvas-chrome-"));
  const proc = spawn(bin, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error("Chrome didn't start within 15s")), 15000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on("exit", (c) => { clearTimeout(t); reject(new Error(`Chrome exited (${c}): ${buf.slice(-400)}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map(), listeners = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id;
    waiting.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  const once = (method, sessionId, ms = 20000) => new Promise((resolve) => {
    const t = setTimeout(() => { listeners.splice(listeners.indexOf(fn), 1); resolve(null); }, ms);
    const fn = (m) => { if (m.method === method && m.sessionId === sessionId) { clearTimeout(t); listeners.splice(listeners.indexOf(fn), 1); resolve(m.params); } };
    listeners.push(fn);
  });

  async function capture(url, { width, height, fullPage = false, still = true, settle = 400, collectIds = false }) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s("Page.enable");
    await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const loaded = once("Page.loadEventFired", sessionId);
    await s("Page.navigate", { url });
    await loaded;
    const ev = async (expression) => (await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
    if (still) await ev("document.documentElement.classList.add('dc-still')");
    await ev(`(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => new Promise(r => setTimeout(r, ${settle})))`);
    let h = height;
    if (fullPage) {
      h = Math.max(height, Math.min(12000, Math.ceil(await ev("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)"))));
      await s("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: false });
      await ev("new Promise(r => setTimeout(r, 150))");
    }
    // Builds carry the mock's ids as data-id or data-testid; collect both, plus whether each is a leaf.
    const ids = collectIds ? await ev(`[...document.querySelectorAll('[data-id],[data-testid]')].map(el => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return { id: el.dataset.id || el.dataset.testid, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, leaf: !el.querySelector('[data-id],[data-testid]'),
      st: { "font-size": c.fontSize, "font-weight": c.fontWeight, "color": c.color, "background-color": c.backgroundColor, "border-radius": c.borderTopLeftRadius, "padding": c.paddingTop + " " + c.paddingRight, "gap": c.rowGap } }; }).filter(r => r.w > 0 && r.h > 0)`) : null;
    const shot = await s("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height: h, scale: 1 } });
    await send("Target.closeTarget", { targetId });
    return { png: Buffer.from(shot.data, "base64"), height: h, ids };
  }

  async function close() {
    try { ws.close(); } catch { /* gone */ }
    proc.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* busy */ }
  }
  return { capture, close };
}

// ---------------------------------------------------------------------------------------------
// iOS Simulator

export function simulatorScreenshot({ link, wait = 1500 } = {}) {
  const tmp = path.join(os.tmpdir(), `design-canvas-sim-${Date.now()}.png`);
  try {
    if (link) { execFileSync("xcrun", ["simctl", "openurl", "booted", link], { stdio: "pipe" }); execFileSync("sleep", [String(wait / 1000)]); }
    execFileSync("xcrun", ["simctl", "io", "booted", "screenshot", "--type=png", tmp], { stdio: "pipe" });
  } catch (e) {
    throw new Error(`Simulator screenshot failed (is a simulator booted with the app running?): ${String(e.stderr ?? e.message).trim().split("\n").at(-1)}`);
  }
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return buf;
}

// ---------------------------------------------------------------------------------------------
// PNG

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString("ascii", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`Unsupported PNG (bit depth ${depth}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch, out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, i = x * ch;
      if (type === 6) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = cur[i + 3]; }
      else if (type === 2) { out[o] = cur[i]; out[o + 1] = cur[i + 1]; out[o + 2] = cur[i + 2]; out[o + 3] = 255; }
      else if (type === 3) { const p = cur[i] * 3; out[o] = palette[p]; out[o + 1] = palette[p + 1]; out[o + 2] = palette[p + 2]; out[o + 3] = trns && cur[i] < trns.length ? trns[cur[i]] : 255; }
      else if (type === 0) { out[o] = out[o + 1] = out[o + 2] = cur[i]; out[o + 3] = 255; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[i]; out[o + 3] = cur[i + 1]; }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

export function encodePNG({ width, height, data }) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const chunk = (kind, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const kb = Buffer.concat([Buffer.from(kind, "ascii"), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(kb));
    return Buffer.concat([len, kb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Area-average resize: right for downscaling a @3x simulator shot to points. */
export function resize(img, w, h) {
  const out = new Uint8Array(w * h * 4), sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx)), y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < img.width; xx++) { const o = (yy * img.width + xx) * 4; r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; a += img.data[o + 3]; n++; }
    const o = (y * w + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------------------------
// Diff: per-pixel delta, then a coarse cell grid flood-filled into regions a person can look at.

export function diffImages(mock, build, { mask = [], cell = 12, threshold = 40 } = {}) {
  const w = Math.min(mock.width, build.width), h = Math.min(mock.height, build.height);
  const out = new Uint8Array(w * h * 4);
  const masked = (x, y) => mask.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
  const cw = Math.ceil(w / cell), chh = Math.ceil(h / cell), counts = new Uint32Array(cw * chh);
  let diff = 0, total = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (y * mock.width + x) * 4, b = (y * build.width + x) * 4, o = (y * w + x) * 4;
    const gray = (mock.data[a] * 0.3 + mock.data[a + 1] * 0.59 + mock.data[a + 2] * 0.11) * 0.35 + 165;
    out[o] = out[o + 1] = out[o + 2] = gray; out[o + 3] = 255;
    if (masked(x, y)) { out[o + 3] = 90; continue; }
    total++;
    const d = Math.max(Math.abs(mock.data[a] - build.data[b]), Math.abs(mock.data[a + 1] - build.data[b + 1]), Math.abs(mock.data[a + 2] - build.data[b + 2]));
    if (d > threshold) { diff++; counts[Math.floor(y / cell) * cw + Math.floor(x / cell)]++; out[o] = 235; out[o + 1] = 40; out[o + 2] = 140; }
  }
  // cells with more than 6% differing pixels, grouped into connected regions
  const hot = new Uint8Array(cw * chh), seen = new Uint8Array(cw * chh), regions = [];
  for (let i = 0; i < counts.length; i++) hot[i] = counts[i] > cell * cell * 0.06 ? 1 : 0;
  for (let i = 0; i < hot.length; i++) {
    if (!hot[i] || seen[i]) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, px = 0;
    const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), cx = j % cw, cy = (j / cw) | 0;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy); px += counts[j];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = cx + dx, ny = cy + dy, k = ny * cw + nx;
        if (nx >= 0 && ny >= 0 && nx < cw && ny < chh && hot[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    regions.push({ x: x0 * cell, y: y0 * cell, w: Math.min(w, (x1 + 1) * cell) - x0 * cell, h: Math.min(h, (y1 + 1) * cell) - y0 * cell, pixels: px });
  }
  regions.sort((a, b) => b.pixels - a.pixels);
  return { mismatch: total ? diff / total : 0, width: w, height: h, heightDelta: build.height - mock.height, widthDelta: build.width - mock.width, regions, image: { width: w, height: h, data: out } };
}

/** The smallest mock elements that contain each region's center: what to look at in the source. */
export function idsForRegion(region, rects) {
  const cx = region.x + region.w / 2, cy = region.y + region.h / 2;
  return rects.filter((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h).sort((a, b) => a.w * a.h - b.w * b.h).slice(0, 2).map((r) => r.id);
}

/** Share of differing pixels between a mock element and the same element in the build, each in its own box. */
function cropDiff(a, ra, b, rb, threshold = 40) {
  const w = Math.floor(Math.min(ra.w, rb.w)), h = Math.floor(Math.min(ra.h, rb.h));
  if (w < 2 || h < 2) return 0;
  let diff = 0, n = 0;
  const step = w * h > 40000 ? 2 : 1;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const ax = Math.floor(ra.x) + x, ay = Math.floor(ra.y) + y, bx = Math.floor(rb.x) + x, by = Math.floor(rb.y) + y;
    if (ax >= a.width || ay >= a.height || bx >= b.width || by >= b.height) continue;
    const i = (ay * a.width + ax) * 4, j = (by * b.width + bx) * 4;
    n++;
    if (Math.max(Math.abs(a.data[i] - b.data[j]), Math.abs(a.data[i + 1] - b.data[j + 1]), Math.abs(a.data[i + 2] - b.data[j + 2])) > threshold) diff++;
  }
  return n ? diff / n : 0;
}

/**
 * Element-matched comparison: when the build exposes the mock's ids, compare element by element so
 * a shift near the top doesn't make everything below "different". Reports what a person would fix:
 * missing elements, changed sizes, and elements that look different inside their own box.
 */
export function compareElements(mockImg, mockIds, buildImg, buildIds) {
  const byId = new Map(buildIds.map((r) => [r.id, r]));
  const out = [];
  let matched = 0, looked = 0, lookDiff = 0;
  for (const m of mockIds) {
    const b = byId.get(m.id);
    const rect = { x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.w), h: Math.round(m.h) };
    if (!b) { out.push({ id: m.id, kind: "missing", detail: "not in the build", ...rect, score: 1 + m.w * m.h / 1e5 }); continue; }
    matched++;
    const dw = Math.round(b.w - m.w), dh = Math.round(b.h - m.h);
    const brect = { bx: Math.round(b.x), by: Math.round(b.y), bw: Math.round(b.w), bh: Math.round(b.h) };
    // Style drift on web builds: the computed values that carry the design system.
    if (m.st && b.st) {
      const diffs = Object.keys(m.st).filter((k) => m.st[k] !== b.st[k] && !(k === "gap" && (m.st[k] === "normal" || b.st[k] === "normal")));
      if (diffs.length) out.push({ id: m.id, kind: "style", detail: diffs.map((k) => `${k} ${m.st[k]} → ${b.st[k]}`).join("; "), ...rect, ...brect, score: 0.6 + diffs.length * 0.1 });
    }
    // Height changes of containers cascade from their children: report width for them, both for leaves.
    if (Math.abs(dw) > 4 || (m.leaf && Math.abs(dh) > 4)) out.push({ id: m.id, kind: "size", detail: `${Math.round(m.w)}×${Math.round(m.h)} in the mock, ${Math.round(b.w)}×${Math.round(b.h)} built`, ...rect, ...brect, score: 0.5 + (Math.abs(dw) + Math.abs(dh)) / 400 });
    if (m.leaf) {
      const d = cropDiff(mockImg, m, buildImg, b);
      looked++; lookDiff += d;
      if (d > 0.08) out.push({ id: m.id, kind: "look", detail: `${Math.round(d * 100)}% of its pixels differ`, pct: d, ...rect, ...brect, score: d });
    }
  }
  const extra = buildIds.filter((b) => !mockIds.some((m) => m.id === b.id)).map((b) => b.id);
  // Only report the outermost missing element of a missing subtree.
  const missing = new Set(out.filter((x) => x.kind === "missing").map((x) => x.id));
  const filtered = out.filter((x) => x.kind !== "missing" || ![...missing].some((p) => p !== x.id && x.id.startsWith(p + ".")));
  filtered.sort((a, b) => b.score - a.score);
  return { elements: filtered, matched, total: mockIds.length, extra, mismatch: mockIds.length ? (missing.size + filtered.filter((x) => x.kind !== "missing").length * 0.5) / mockIds.length : 0, lookDiff: looked ? lookDiff / looked : 0 };
}
