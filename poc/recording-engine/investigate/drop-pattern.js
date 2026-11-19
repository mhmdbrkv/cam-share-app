#!/usr/bin/env node
"use strict";
// Where do drawn-but-missing frames fall? (read-only, synthetic experiment files)
//   node poc/recording-engine/investigate/drop-pattern.js "<XP_OUT>" <variant>
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const [OUT, v] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(OUT, v, "meta.json"), "utf8"));
const ff = path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe");
const BITS = 20, CHECK = 4, CELLS = 26, W = 832, H = 32;
const check = (x) => { let c = 0; for (let i = 0; i < BITS; i += 4) c ^= (x >>> i) & 0xf; return c; };
function read(f) { const lv = []; for (let i = 0; i < CELLS; i++) { let s = 0, n = 0; for (let y = 8; y <= 24; y++) for (let x = i * 32 + 8; x <= i * 32 + 24; x++) { s += f[y * W + x]; n++; } lv.push(s / n); }
  if (!(lv[0] - lv[1] > 60)) return null; const thr = (lv[0] + lv[1]) / 2; let val = 0; for (let i = 0; i < BITS; i++) if (lv[2 + i] > thr) val |= 1 << i; let c = 0; for (let i = 0; i < CHECK; i++) if (lv[22 + i] > thr) c |= 1 << i; return c === check(val) ? val : null; }
const p = spawn(ff, ["-v", "error", "-i", meta.file, "-map", "0:v:0", "-vf", "crop=832:32:0:0", "-enc_time_base", "demux", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
let buf = Buffer.alloc(W * H), fill = 0; const comps = [];
p.stdout.on("data", (ch) => { let o = 0; while (o < ch.length) { const n = Math.min(W * H - fill, ch.length - o); ch.copy(buf, fill, o, o + n); fill += n; o += n; if (fill === W * H) { comps.push(read(buf)); fill = 0; } } });
p.on("close", () => {
  const present = new Set(comps.filter((c) => c !== null));
  const first = Math.min(...present), last = Math.max(...present);
  const t = new Map(meta.frames.map((f) => [f[0], f[1]]));
  const missing = []; for (let c = first; c <= last; c++) if (!present.has(c)) missing.push(c);
  const gapBefore = (c) => t.get(c) - t.get(c - 1);
  const gapAfterPrevKept = (c) => { let k = c - 1; while (k >= first && !present.has(k)) k--; return t.get(c) - t.get(k); };
  const hist = (arr) => { const h = {}; for (const x of arr) { const b = x < 28.5 ? "<28.5" : x < 31 ? "28.5-31" : x < 33.3 ? "31-33.3" : x < 36 ? "33.3-36" : ">=36"; h[b] = (h[b] || 0) + 1; } return h; };
  const keptAfter = []; for (let c = first + 1; c <= last; c++) if (present.has(c)) keptAfter.push(gapAfterPrevKept(c));
  const allGaps = []; for (let c = first + 1; c <= last; c++) allGaps.push(gapBefore(c));
  const secs = missing.map((c) => Math.floor((t.get(c) - meta.startCalledT) / 1000));
  const perSec = {}; for (const s of secs) perSec[s] = (perSec[s] || 0) + 1;
  const markerSecs = (meta.markers || []).map((m) => Math.floor(((m.tFlashDraw || m.tRecv) - meta.startCalledT) / 1000));
  console.log(JSON.stringify({ variant: v, drawnInRange: last - first + 1, missing: missing.length,
    drawGapBeforeMissingFrame: hist(missing.map(gapBefore)), drawGapBeforeAllFrames: hist(allGaps),
    missingPerSecondOfRecording: perSec, markerSeconds: markerSecs.slice(0, 8), longestRunMissing: (() => { let best = 0, run = 0; for (let c = first; c <= last; c++) { if (!present.has(c)) { run++; best = Math.max(best, run); } else run = 0; } return best; })() }));
});
