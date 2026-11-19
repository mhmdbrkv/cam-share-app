#!/usr/bin/env node
"use strict";
/*
 * PiP tracker + per-frame privacy gate for app-harness recordings (synthetic window capture).
 *   node poc/recording-engine/investigate/pip-track.js <recording.webm> [samplesPerSecond=2]
 *
 * For each sampled frame (decoded to grayscale in memory, never written to disk):
 *   - detects the PiP's white 3 px border rectangle;
 *   - privacy gate: every privacy canary of the synthetic window OUTSIDE the detected PiP rect
 *     (+8 px) must be intact. With no PiP detected, every canary must be intact.
 * Prints numbers only (no images). Frames whose gate fails must never be viewed.
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"),
  path = require("path");
const [file, spsArg] = process.argv.slice(2);
const SPS = Number(spsArg || 2);
const tool = (n) => path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", n + ".exe");
const W = 1920,
  H = 1080;

// privacy canaries: must match Canary in ../barcode.js
const C_SIZE = 12, C_STEP = 64, C_OFF = 16;
const C_EXCL = [[0, 0, 992, 100], [36, 856, 328, 188]];
const overlaps = (x, y, s, r) => x < r[0] + r[2] && x + s > r[0] && y < r[1] + r[3] && y + s > r[1];
const canaries = [];
for (let y = C_OFF; y + C_SIZE <= H; y += C_STEP) for (let x = C_OFF; x + C_SIZE <= W; x += C_STEP) if (!C_EXCL.some((r) => overlaps(x, y, C_SIZE, r))) canaries.push([x, y]);
function canaryOk(f, x, y) {
  const q = (cx, cy) => (f[cy * W + cx] + f[cy * W + cx + 1] + f[(cy + 1) * W + cx] + f[(cy + 1) * W + cx + 1]) / 4;
  return q(x + 2, y + 2) > 150 && q(x + 8, y + 8) > 150 && q(x + 8, y + 2) < 100 && q(x + 2, y + 8) < 100;
}

// PiP border detection: long horizontal white runs (canaries are only 6 px wide), grouped by span.
function detectPip(f) {
  const runs = [];
  for (let y = 100; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (f[y * W + x] >= 215) {
        const x0 = x;
        while (x < W && f[y * W + x] >= 215) x++;
        if (x - x0 >= 80) runs.push({ y, x0, x1: x - 1 });
      } else x++;
    }
  }
  const groups = new Map();
  for (const r of runs) {
    const k = `${Math.round(r.x0 / 4)}|${Math.round(r.x1 / 4)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let best = null;
  for (const g of groups.values()) {
    const top = Math.min(...g.map((r) => r.y)),
      bottom = Math.max(...g.map((r) => r.y));
    if (bottom - top < 40) continue;
    const { x0, x1 } = g[0];
    let edge = 0;
    for (let y = top; y <= bottom; y++) if (f[y * W + Math.min(W - 1, x0 + 1)] >= 200 && f[y * W + Math.max(0, x1 - 1)] >= 200) edge++;
    if (edge / (bottom - top + 1) < 0.8) continue;
    const area = (x1 - x0) * (bottom - top);
    if (!best || area > best.area) best = { x: x0 + 1, y: top + 1, w: x1 - x0 - 2, h: bottom - top - 2, area };
  }
  return best && { x: best.x, y: best.y, w: best.w, h: best.h };
}

const p = spawn(tool("ffmpeg"), ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", `fps=${SPS},scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
const size = W * H;
let buf = Buffer.alloc(size),
  fill = 0,
  idx = 0;
const rows = [];
p.stdout.on("data", (ch) => {
  let o = 0;
  while (o < ch.length) {
    const n = Math.min(size - fill, ch.length - o);
    ch.copy(buf, fill, o, o + n);
    fill += n;
    o += n;
    if (fill === size) {
      const pip = detectPip(buf);
      const ex = pip ? [pip.x - 8, pip.y - 8, pip.w + 16, pip.h + 16] : null;
      let checked = 0,
        failed = 0;
      for (const [x, y] of canaries) {
        if (ex && overlaps(x, y, C_SIZE, ex)) continue;
        checked++;
        if (!canaryOk(buf, x, y)) failed++;
      }
      rows.push({ t: +(idx / SPS).toFixed(2), pip, canariesChecked: checked, canariesFailed: failed, privacyOk: failed === 0 && checked > 100 });
      fill = 0;
      idx++;
    }
  }
});
p.on("close", () => {
  const rect = (r) => (r ? `${r.x},${r.y} ${r.w}x${r.h}` : "none");
  let segs = [];
  for (const r of rows) {
    const key = r.pip ? rect({ x: Math.round(r.pip.x / 6) * 6, y: Math.round(r.pip.y / 6) * 6, w: Math.round(r.pip.w / 6) * 6, h: Math.round(r.pip.h / 6) * 6 }) : "none";
    const last = segs[segs.length - 1];
    if (last && last.key === key) {
      last.to = r.t;
      last.n++;
      if (!r.privacyOk) last.privacyFail++;
    } else segs.push({ key, from: r.t, to: r.t, n: 1, privacyFail: r.privacyOk ? 0 : 1, sample: r.pip });
  }
  const out = {
    file: path.basename(file),
    samplesPerSecond: SPS,
    samples: rows.length,
    privacyFailSamples: rows.filter((r) => !r.privacyOk).length,
    segments: segs.map((s) => ({ from: s.from, to: s.to, samples: s.n, pip: s.key, privacyFail: s.privacyFail })),
  };
  fs.writeFileSync(file.replace(/\.(webm|mp4)$/i, "") + ".pip-track.json", JSON.stringify({ ...out, rows }, null, 1));
  console.log(JSON.stringify(out, null, 1));
});
