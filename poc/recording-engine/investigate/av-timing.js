#!/usr/bin/env node
"use strict";
/*
 * A/V investigation (read-only on an existing run; no capture, no recording).
 *   node poc/recording-engine/investigate/av-timing.js "<run folder>"
 *
 * Joins, for every recorded video frame, its file pts (ffprobe) with its renderer draw time
 * (frames.jsonl, via the compositor barcode decoded from the file), and for every A/V marker the
 * renderer draw time t, the AudioContext.currentTime read at beep(), the flash pts and the
 * tone-onset pts in the file. Decomposes
 *   offset = onsetPts - flashPts
 *          = [onsetPts - audioTime]  (A: audio file timeline vs AudioContext clock)
 *          - [flashPts - t/1000]     (V: video file timeline vs renderer clock)
 *          + [audioTime - t/1000]    (X: AudioContext clock vs renderer clock at beep())
 * Constants of A, V, X have arbitrary origins; their SPREADS and the residuals are what matter.
 */
const fs = require("fs"),
  path = require("path"),
  { spawn, spawnSync } = require("child_process");
const runDir = process.argv[2];
const ff = (n) => path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", n + ".exe");
const readJsonl = (f) => fs.readFileSync(path.join(runDir, f), "utf8").split("\n").filter(Boolean).map(JSON.parse);
const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
const file = summary.result.result.file;
const frames = new Map(readJsonl("frames.jsonl").map((f) => [f[0], f]));
const markers = readJsonl("events.jsonl").filter((e) => e.kind === "r:marker");
const adir = fs.readdirSync(runDir).filter((d) => d.startsWith("analysis-")).sort().pop();
const analysis = JSON.parse(fs.readFileSync(path.join(runDir, adir, "analysis.json"), "utf8"));

const BITS = 20, CHECK = 4, CELLS = 26, W = 832, H = 32;
const check = (v) => { let c = 0; for (let i = 0; i < BITS; i += 4) c ^= (v >>> i) & 0xf; return c; };
function read(f) {
  const lv = [];
  for (let i = 0; i < CELLS; i++) { let s = 0, n = 0; for (let y = 8; y <= 24; y++) for (let x = i * 32 + 8; x <= i * 32 + 24; x++) { s += f[y * W + x]; n++; } lv.push(s / n); }
  if (!(lv[0] - lv[1] > 60)) return null;
  const thr = (lv[0] + lv[1]) / 2; let v = 0; for (let i = 0; i < BITS; i++) if (lv[2 + i] > thr) v |= 1 << i;
  let c = 0; for (let i = 0; i < CHECK; i++) if (lv[22 + i] > thr) c |= 1 << i; return c === check(v) ? v : null;
}
const stats = (a) => { const s = [...a].sort((x, y) => x - y); const m = a.reduce((p, x) => p + x, 0) / a.length; return { n: a.length, mean: +m.toFixed(3), min: +s[0].toFixed(3), p50: +s[Math.floor(s.length / 2)].toFixed(3), max: +s[s.length - 1].toFixed(3), spread: +(s[s.length - 1] - s[0]).toFixed(3) }; };
function fit(xs, ys) { const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n; let nu = 0, de = 0; for (let i = 0; i < n; i++) { nu += (xs[i] - mx) * (ys[i] - my); de += (xs[i] - mx) ** 2; } const b = nu / de; return { slope: b, intercept: my - b * mx }; }

const pts = JSON.parse(spawnSync(ff("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "json", file], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout).packets.map((p) => Number(p.pts_time)).sort((a, b) => a - b);
const comps = [];
const p = spawn(ff("ffmpeg"), ["-v", "error", "-i", file, "-vf", "crop=832:32:0:0", "-enc_time_base", "demux", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
let buf = Buffer.alloc(W * H), fill = 0;
p.stdout.on("data", (ch) => { let o = 0; while (o < ch.length) { const n = Math.min(W * H - fill, ch.length - o); ch.copy(buf, fill, o, o + n); fill += n; o += n; if (fill === W * H) { comps.push(read(buf)); fill = 0; } } });
p.on("close", () => {
  // video: file pts vs renderer draw time for every frame
  const xs = [], ys = [];
  comps.forEach((c, i) => { const f = c !== null && frames.get(c); if (f) { xs.push(f[1] / 1000); ys.push(pts[i]); } });
  const vf = fit(xs, ys);
  const vres = xs.map((x, i) => (ys[i] - (vf.intercept + vf.slope * x)) * 1000);
  // markers
  const flashes = analysis.metrics.content.value.flashes; // {i, pts, comp}
  const offs = analysis.metrics.av.value.offsetsMs;
  const rows = [];
  markers.forEach((m, k) => {
    const fl = flashes.find((f) => f.comp === m.c);
    if (!fl || offs[k] === undefined) return;
    const onset = fl.pts + offs[k] / 1000;
    rows.push({ n: m.n, offsetMs: offs[k], A: (onset - m.audioTime) * 1000, V: (fl.pts - m.t / 1000) * 1000, X: (m.audioTime - m.t / 1000) * 1000, flashPtsMinusFit: (fl.pts - (vf.intercept + vf.slope * m.t / 1000)) * 1000 });
  });
  const af = fit(markers.slice(0, rows.length).map((m) => m.audioTime), rows.map((r, k) => flashes.find((f) => f.comp === markers[k].c).pts + r.offsetMs / 1000));
  const xf = fit(markers.map((m) => m.t / 1000), markers.map((m) => m.audioTime));
  const result = {
    MEASURED: {
      videoFramesJoined: xs.length,
      videoPtsVsDrawTime: { slope: +vf.slope.toFixed(6), residualMs: stats(vres) },
      markers: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(2) : v]))),
      A_onsetPtsMinusAudioTime_ms: stats(rows.map((r) => r.A)),
      V_flashPtsMinusDrawTime_ms: stats(rows.map((r) => r.V)),
      X_audioTimeMinusDrawTime_ms: stats(rows.map((r) => r.X)),
      flashFrameResidualVsVideoFit_ms: stats(rows.map((r) => r.flashPtsMinusFit)),
      audioOnsetPtsVsAudioTime_slope: +af.slope.toFixed(6),
      audioTimeVsRendererTime_slope: +xf.slope.toFixed(6),
      audioReady: summary.audioReady,
    },
  };
  console.log(JSON.stringify(result, null, 2));
});
