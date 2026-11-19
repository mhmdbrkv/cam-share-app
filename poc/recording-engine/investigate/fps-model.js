#!/usr/bin/env node
"use strict";
/*
 * FPS investigation (read-only; no capture, no recording).
 *   node poc/recording-engine/investigate/fps-model.js "<run folder>"
 * Part 1 (MEASURED): draw-interval distribution from the run's frames.jsonl (renderer
 *   performance.now() at every recorded compositor draw) and rAF tick rate from renderer-stats.
 * Part 2 (CALCULATED): simulation of the app's loop (src/renderer.js@6c3bf48 L207-216: draw when
 *   now - last >= 1000/30 - 2, last = now) versus alternative schedulers, at 60/120/144/165 Hz,
 *   with vsync-quantized rAF timestamps and an optional missed-vsync rate taken from the run.
 */
const fs = require("fs"),
  path = require("path");
const runDir = process.argv[2];
const readJsonl = (f) => fs.readFileSync(path.join(runDir, f), "utf8").split("\n").filter(Boolean).map(JSON.parse);

/* ---------- Part 1: measured ---------- */
const frames = readJsonl("frames.jsonl");
const iv = [];
for (let i = 1; i < frames.length; i++) iv.push(frames[i][1] - frames[i - 1][1]);
const bucket = (x) => (x < 30 ? "<30" : x < 33 ? "30-33 (~4 ticks@144=27.8? no)" : x < 36.5 ? "~34.7 (5 ticks@144)" : x < 43 ? "~41.7 (6 ticks@144)" : x < 50 ? "~48.6 (7 ticks)" : ">=50");
const hist = {};
for (const x of iv) hist[bucket(x)] = (hist[bucket(x)] || 0) + 1;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sorted = [...iv].sort((a, b) => a - b);
const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
const rs = readJsonl("renderer-stats.jsonl").filter((r) => r.rec === "recording");
const raf = rs.map((r) => r.raf);
const draws = rs.map((r) => r.draws);
const measured = {
  drawsLogged: frames.length,
  drawIntervalMs: { mean: +mean(iv).toFixed(3), p05: q(0.05), p50: q(0.5), p95: q(0.95), max: Math.max(...iv), min: Math.min(...iv) },
  impliedDrawFps: +(1000 / mean(iv)).toFixed(3),
  intervalBuckets: hist,
  rafTicksPerSec: { mean: +mean(raf).toFixed(2), min: Math.min(...raf), max: Math.max(...raf) },
  drawsPerSec: { mean: +mean(draws).toFixed(2), min: Math.min(...draws), max: Math.max(...draws) },
};
// missed-vsync estimate: share of draw intervals longer than 5 ticks at 144 Hz
const tick144 = 1000 / 144;
measured.longIntervalShare = +(iv.filter((x) => x > 5.5 * tick144).length / iv.length).toFixed(4);

/* ---------- Part 2: calculated ---------- */
function simulate(hz, scheduler, { seconds = 600, missRate = 0, seed = 7 } = {}) {
  const T = 1000 / hz;
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const target = 1000 / 30;
  let last = -1e9,
    next = 0,
    n = 0;
  const out = [];
  for (let k = 0; k * T < seconds * 1000; k++) {
    if (missRate && rnd() < missRate) continue; // a vsync whose rAF callback did not run
    const now = k * T;
    if (scheduler === "app") {
      // src/renderer.js: if (now - lastFrameTime >= frameInterval - 2) { lastFrameTime = now; draw }
      if (now - last >= target - 2) {
        last = now;
        out.push(now);
      }
    } else if (scheduler === "deadline") {
      // fixed 30 Hz deadlines; draw on the first vsync at/after (deadline - T/2); keep the phase
      if (n === 0) next = now;
      if (now >= next - T / 2) {
        out.push(now);
        next += target;
        if (now - next > target) next = now + target; // resync after a long stall, no burst
        n++;
      }
    }
  }
  const d = [];
  for (let i = 1; i < out.length; i++) d.push(out[i] - out[i - 1]);
  const fps = (out.length - 1) / ((out[out.length - 1] - out[0]) / 1000);
  const uniq = [...new Set(d.map((x) => x.toFixed(2)))].slice(0, 4);
  return { fps: +fps.toFixed(3), intervalsMs: uniq };
}
const rates = [60, 75, 90, 100, 120, 144, 165, 240];
const calc = {};
for (const hz of rates) {
  calc[hz] = {
    appLoop: simulate(hz, "app"),
    appLoopWithMeasuredMisses: simulate(hz, "app", { missRate: Math.max(0, 1 - measured.rafTicksPerSec.mean / 144) }),
    deadlineScheduler: simulate(hz, "deadline"),
    deadlineWithMeasuredMisses: simulate(hz, "deadline", { missRate: Math.max(0, 1 - measured.rafTicksPerSec.mean / 144) }),
    closedForm_appLoopFps: +(1000 / (Math.ceil((1000 / 30 - 2) / (1000 / hz)) * (1000 / hz))).toFixed(3),
  };
}
console.log(JSON.stringify({ MEASURED: measured, CALCULATED: calc }, null, 2));
