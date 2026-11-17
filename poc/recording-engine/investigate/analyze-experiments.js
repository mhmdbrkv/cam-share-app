#!/usr/bin/env node
"use strict";
/*
 * Analyzer for investigate/offline-experiments.js outputs (synthetic files only).
 *   node poc/recording-engine/investigate/analyze-experiments.js "<XP_OUT folder>"
 * Writes <XP_OUT>/experiments-results.json and prints a summary.
 *
 * FPS: output fps and gaps from file timestamps; drawn-but-missing frames from the frame barcode;
 *      draw rate and rAF tick rate from the page log; CPU per process type (whole-machine %).
 * A/V: video timeline is fitted to renderer draw time (pts = cV + t). For each marker:
 *      fileOffset   = toneOnsetPts - flashPts                     (what the earlier analyzer measured)
 *      D (worklet)  = toneOnsetPts - (cV + tRecv)                 audio stamping delay vs the moment
 *                     the worklet rendered the tone (tRecv = main-thread receipt, >= render time)
 *      D (legacy)   = toneOnsetPts - (cV + tFlashDraw)            same reference for the old marker
 *      drawLag      = tFlashDraw - tRecv                          instrumentation part (worklet)
 *   If the pipeline stamps audio at render time, D ~ 0 and fileOffset ~ -drawLag.
 */
const fs = require("fs"),
  path = require("path"),
  { spawn, spawnSync } = require("child_process");
const OUT = process.argv[2];
const tool = (n) => path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", n + ".exe");
const FFMPEG = tool("ffmpeg"),
  FFPROBE = tool("ffprobe");
if (!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE)) {
  console.error("STOP: ffmpeg/ffprobe missing");
  process.exit(3);
}
const BITS = 20, CHECK = 4, CELLS = 26, CW = 992, CH = 96;
const check = (v) => { let c = 0; for (let i = 0; i < BITS; i += 4) c ^= (v >>> i) & 0xf; return c; };
function readComp(f) {
  const lv = [];
  for (let i = 0; i < CELLS; i++) { let s = 0, n = 0; for (let y = 8; y <= 24; y++) for (let x = i * 32 + 8; x <= i * 32 + 24; x++) { s += f[y * CW + x]; n++; } lv.push(s / n); }
  if (!(lv[0] - lv[1] > 60)) return null;
  const thr = (lv[0] + lv[1]) / 2; let v = 0; for (let i = 0; i < BITS; i++) if (lv[2 + i] > thr) v |= 1 << i;
  let c = 0; for (let i = 0; i < CHECK; i++) if (lv[22 + i] > thr) c |= 1 << i; return c === check(v) ? v : null;
}
const flashLum = (f) => { let s = 0, n = 0; for (let y = 24; y < 72; y++) for (let x = 920; x < 968; x++) { s += f[y * CW + x]; n++; } return s / n; };
const st = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = a.reduce((p, x) => p + x, 0) / a.length; return { n: a.length, mean: +m.toFixed(2), min: +s[0].toFixed(2), p50: +s[Math.floor(s.length / 2)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
function fit(xs, ys) { const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n; let nu = 0, de = 0; for (let i = 0; i < n; i++) { nu += (xs[i] - mx) * (ys[i] - my); de += (xs[i] - mx) ** 2; } const b = nu / de; return { slope: b, a: my - b * mx }; }

function decodeVideo(file) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-v", "error", "-i", file, "-map", "0:v:0", "-vf", `crop=${CW}:${CH}:0:0`, "-enc_time_base", "demux", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    const size = CW * CH; let buf = Buffer.alloc(size), fill = 0; const comps = [], flashes = [];
    p.stdout.on("data", (ch) => { let o = 0; while (o < ch.length) { const n = Math.min(size - fill, ch.length - o); ch.copy(buf, fill, o, o + n); fill += n; o += n; if (fill === size) { comps.push(readComp(buf)); flashes.push(flashLum(buf)); fill = 0; } } });
    p.on("close", () => resolve({ comps, flashes }));
  });
}
function decodeAudioOnsets(file, startTime) {
  return new Promise((resolve) => {
    const SR = 48000, thr = 0.05 * 32768;
    const p = spawn(FFMPEG, ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(SR), "-f", "s16le", "pipe:1"]);
    let idx = 0, silent = SR, carry = null; const on = [];
    p.stdout.on("data", (chunk) => { const b = carry ? Buffer.concat([carry, chunk]) : chunk; const n = Math.floor(b.length / 2); for (let i = 0; i < n; i++) { if (Math.abs(b.readInt16LE(i * 2)) > thr) { if (silent >= SR / 2) on.push(startTime + idx / SR); silent = 0; } else silent++; idx++; } carry = b.length % 2 ? b.subarray(b.length - 1) : null; });
    p.on("close", () => resolve(on));
  });
}

// ---- GPU attribution (typeperf GPU Engine, 1 Hz) ----

function loadGpu(name) {
  const p = path.join(OUT, `gpu-${name}.csv`); // one typeperf file per run
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 3) return null;
  const parse = (l) => l.split('","').map((s) => s.replace(/^"|"$/g, ""));
  const head = parse(lines[0]);
  const cols = head.slice(1).map((h, i) => {
    const m = /pid_(\d+)_luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_\d+_eng_(\d+)_engtype_([^)]*)\)/.exec(h);
    return m ? { i: i + 1, pid: Number(m[1]), luid: m[2], eng: m[3], type: m[4] || "unknown" } : null;
  });
  const rows = lines.slice(1).map(parse).map((v) => ({ t: Date.parse(v[0]), v }));
  const log = fs.readFileSync(path.join(OUT, "experiments.log.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const loadPids = new Set(log.filter((e) => e.kind === "load-start").map((e) => e.pid));
  return { cols, rows, log, loadPids };
}
function gpuForRun(name) {
  const GPU = loadGpu(name);
  if (!GPU) return null;
  const b = GPU.log.find((e) => e.kind === "begin" && e.name === name),
    e = GPU.log.find((x) => x.kind === "end" && x.name === name);
  if (!b || !e) return null;
  // experiment-process PIDs = those reported by this process's getAppMetrics during the run
  const metrics = fs.readFileSync(path.join(OUT, "metrics.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((r) => r.variant === name);
  const own = new Set(metrics.flatMap((r) => r.procs.map((p) => p.pid)));
  const acc = { own: [], all: [] };
  for (const r of GPU.rows) {
    if (!(r.t >= b.wall + 2000 && r.t <= e.wall)) continue; // skip the first 2 s of each run
    const per = { own: {}, all: {} };
    for (const c of GPU.cols) {
      if (!c || c.type !== "3D") continue;
      const val = Number(r.v[c.i]);
      if (!Number.isFinite(val)) continue;
      const k = `${c.luid}|${c.eng}`;
      per.all[k] = (per.all[k] || 0) + val;
      if (own.has(c.pid)) per.own[k] = (per.own[k] || 0) + val;
    }
    acc.own.push(Math.max(0, ...Object.values(per.own)));
    acc.all.push(Math.max(0, ...Object.values(per.all)));
  }
  return { samples: acc.own.length, experiment3dPct: st(acc.own), allProcesses3dPct: st(acc.all) };
}

(async () => {
  const metrics =fs.existsSync(path.join(OUT, "metrics.jsonl")) ? fs.readFileSync(path.join(OUT, "metrics.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
  const variants = fs.readdirSync(OUT).filter((d) => fs.existsSync(path.join(OUT, d, "meta.json")));
  const results = {};
  for (const v of variants) {
    const meta = JSON.parse(fs.readFileSync(path.join(OUT, v, "meta.json"), "utf8"));
    if (meta.unavailable) {
      results[v] = { condition: meta.variant.condition, unavailable: meta.unavailable };
      continue;
    }
    const probe = JSON.parse(spawnSync(FFPROBE, ["-v", "error", "-show_streams", "-of", "json", meta.file], { encoding: "utf8" }).stdout);
    const as = probe.streams.find((s) => s.codec_type === "audio");
    const pts = JSON.parse(spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "json", meta.file], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout).packets.map((p) => Number(p.pts_time)).sort((a, b) => a - b);
    if (pts.length < 10) {
      // e.g. MediaStreamTrackGenerator audio + canvas video: MediaRecorder wrote no video packets
      const ap = JSON.parse(spawnSync(FFPROBE, ["-v", "error", "-select_streams", "a:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "json", meta.file], { encoding: "utf8" }).stdout);
      results[v] = { condition: meta.variant.condition || v, audioMode: meta.variant.audioMode || "webaudio", noVideo: true, videoPackets: pts.length, audioPackets: Number(ap.streams && ap.streams[0] && ap.streams[0].nb_read_packets), drawsLogged: meta.draws, markersLogged: meta.markers.length };
      continue;
    }
    const { comps, flashes } = await decodeVideo(meta.file);
    const drawT = new Map(meta.frames.map((f) => [f[0], f[1]]));
    // timing
    const gaps = []; for (let i = 1; i < pts.length; i++) gaps.push((pts[i] - pts[i - 1]) * 1000);
    const after2 = pts.filter((p) => p >= pts[0] + 2);
    const fps = (after2.length - 1) / (after2[after2.length - 1] - after2[0]);
    const ok = comps.filter((c) => c !== null);
    let missing = 0, dups = 0; for (let i = 1; i < comps.length; i++) { if (comps[i] === null || comps[i - 1] === null) continue; const d = comps[i] - comps[i - 1]; if (d === 0) dups++; else if (d > 1) missing += d - 1; }
    const dIv = []; const fr = meta.frames.filter((f) => f[1] >= meta.startCalledT && f[1] <= meta.onstopT); for (let i = 1; i < fr.length; i++) dIv.push(fr[i][1] - fr[i - 1][1]);
    const recS = (meta.onstopT - meta.startCalledT) / 1000;
    const cpuRows = metrics.filter((r) => r.variant === v);
    const cpuByType = {};
    for (const r of cpuRows) for (const p of r.procs) cpuByType[p.type] = (cpuByType[p.type] || 0) + p.cpu / cpuRows.length;
    const R = {
      condition: meta.variant.condition || v,
      capture: meta.variant.capture || "rate30",
      audioMode: meta.variant.audioMode || "webaudio",
      mime: meta.mime,
      scheduler: meta.variant.scheduler,
      fileFrames: pts.length,
      outputFpsAfter2s: +fps.toFixed(3),
      gapMs: st(gaps),
      gapsOver50ms: gaps.filter((g) => g > 50).length,
      compDecodeShare: +(ok.length / comps.length).toFixed(4),
      drawnButMissing: missing,
      duplicates: dups,
      drawsPerSec: +(fr.length / recS).toFixed(3),
      drawIntervalMs: st(dIv),
      rafTicksPerSec: +(meta.rafTicks / ((meta.onstopT - (meta.frames[0] ? meta.frames[0][1] : meta.startCalledT)) / 1000)).toFixed(1),
      cpuPctOfMachineByType: Object.fromEntries(Object.entries(cpuByType).map(([k, x]) => [k, +x.toFixed(2)])),
      cpuPctOfMachineTotal: +Object.values(cpuByType).reduce((a, b) => a + b, 0).toFixed(2),
      gapShareLe50: +(gaps.filter((g) => g <= 50.0001).length / gaps.length).toFixed(4),
      drawIntervalsUnder20ms: dIv.filter((x) => x < 20).length,
      drawIntervalsOver50ms: dIv.filter((x) => x > 50).length,
      load: !!meta.variant.load,
    };
    // cold start (measured from this file + page log): first recorded frame, onstart, early hole
    {
      const firstComp = comps.find((c) => c !== null);
      const early = []; for (let i = 1; i < pts.length && pts[i] <= pts[0] + 3; i++) early.push((pts[i] - pts[i - 1]) * 1000);
      let earlyMissing = 0; for (let i = 1; i < comps.length && pts[i] <= pts[0] + 3; i++) { if (comps[i] !== null && comps[i - 1] !== null && comps[i] - comps[i - 1] > 1) earlyMissing += comps[i] - comps[i - 1] - 1; }
      R.startup = {
        firstFileFrameDrawnAfterStartCallMs: firstComp != null && drawT.has(firstComp) ? +(drawT.get(firstComp) - meta.startCalledT).toFixed(1) : null,
        onstartAfterStartCallMs: meta.onstartT ? +(meta.onstartT - meta.startCalledT).toFixed(1) : null,
        largestGapFirst3sMs: early.length ? +Math.max(...early).toFixed(1) : null,
        missingFramesFirst3s: earlyMissing,
        primeMs: meta.variant.primeMs === undefined ? null : meta.variant.primeMs,
        prewarm: meta.prewarm || null,
      };
      // "Wait for onstart" assessment: of the frames drawn AFTER onstart (and before onstop),
      // how many are missing from the file, and how long until frames flow steadily.
      if (meta.onstartT) {
        const present = new Set(comps.filter((c) => c !== null));
        const lastC = Math.max(...present);
        const after = meta.frames.filter((f) => f[1] >= meta.onstartT && f[0] <= lastC);
        const missingAfter = after.filter((f) => !present.has(f[0]));
        const lastMissingAfter = missingAfter.length ? missingAfter[missingAfter.length - 1][1] - meta.onstartT : null;
        R.startup.missingFramesDrawnAfterOnstart = missingAfter.length;
        R.startup.lastMissingFrameAfterOnstartMs = lastMissingAfter === null ? null : +lastMissingAfter.toFixed(1);
        const firstSteady = after.find((f) => present.has(f[0]));
        R.startup.firstRecordedFrameAfterOnstartMs = firstSteady ? +(firstSteady[1] - meta.onstartT).toFixed(1) : null;
      }
    }
    // GPU per run (XP_GPU=1 sessions): typeperf rows within this run's begin/end window
    R.gpu = gpuForRun(v);
    // video timeline fit: pts = a + slope * drawTime(s)
    const xs = [], ys = [];
    comps.forEach((c, i) => { if (c !== null && drawT.has(c)) { xs.push(drawT.get(c) / 1000); ys.push(pts[i]); } });
    const vf = fit(xs, ys);
    const vres = xs.map((x, i) => (ys[i] - (vf.a + vf.slope * x)) * 1000);
    R.videoPtsVsDrawTime = { slope: +vf.slope.toFixed(6), residualMs: st(vres) };
    if (meta.variant.marker && as) {
      const onsets = await decodeAudioOnsets(meta.file, Number(as.start_time) || 0);
      const toFile = (tMs) => vf.a + vf.slope * (tMs / 1000);
      const rows = [];
      for (const m of meta.markers) {
        if (m.cFlash == null) continue;
        const fi = comps.indexOf(m.cFlash);
        if (fi < 0) continue;
        const flashPts = pts[fi];
        // reference instant on the renderer clock: worklet = receipt of "tone rendered";
        // generator = nominal time asserted by the AudioData timestamp; legacy = flash draw
        const ref = meta.variant.marker === "worklet" ? m.tRecv : meta.variant.marker === "generator" ? m.tNom : m.tFlashDraw;
        const exp = toFile(ref);
        let best = null; for (const a of onsets) if (best === null || Math.abs(a - exp) < Math.abs(best - exp)) best = a;
        if (best === null || Math.abs(best - exp) > 0.5) continue;
        rows.push({
          n: m.n,
          fileOffsetMs: (best - flashPts) * 1000,
          D_ms: (best - exp) * 1000,
          drawLagMs: meta.variant.marker === "worklet" ? m.tFlashDraw - m.tRecv : meta.variant.marker === "generator" ? m.tFlashDraw - m.tNom : 0,
          writeLeadMs: meta.variant.marker === "generator" ? m.tNom - m.tWrite : null,
          flashLumOk: flashes[fi] > 128,
          ctxMinusOutputTsMs: m.outputTimestamp ? ((meta.variant.marker === "worklet" ? m.ctxTime : m.ctxTimeAtBeep) - m.outputTimestamp.contextTime) * 1000 : null,
        });
      }
      const dr = fit(rows.map((r, i) => i), rows.map((r) => r.D_ms));
      R.av = {
        marker: meta.variant.marker,
        audioMode: meta.audio.mode || "webaudio",
        tsMode: meta.audio.tsMode || null,
        latencyHint: meta.audio.latencyHint || null,
        baseLatencyMs: meta.audio.baseLatency != null ? meta.audio.baseLatency * 1000 : null,
        outputLatencyMs: meta.audio.outputLatency != null ? meta.audio.outputLatency * 1000 : null,
        writeLeadMs: st(rows.map((r) => r.writeLeadMs).filter((x) => x !== null)),
        workletLoad: meta.workletLoad || null,
        markersLogged: meta.markers.length,
        audioOnsets: onsets.length,
        matched: rows.length,
        fileOffsetMs: st(rows.map((r) => r.fileOffsetMs)),
        D_audioStampDelayMs: st(rows.map((r) => r.D_ms)),
        drawLagMs: st(rows.map((r) => r.drawLagMs)),
        D_trend_ms_per_marker_2s: rows.length > 2 ? +dr.slope.toFixed(3) : null,
        ctxTimeMinusOutputTimestampMs: st(rows.map((r) => r.ctxMinusOutputTsMs).filter((x) => x !== null)),
      };
    }
    results[v] = R;
  }
  // per-condition summary across repeats
  const byCond = {};
  for (const [name, r] of Object.entries(results)) {
    if (r.unavailable || r.noVideo || !r.condition) continue;
    (byCond[r.condition] = byCond[r.condition] || []).push({ name, ...r });
  }
  const summary = {};
  for (const [c, rs] of Object.entries(byCond)) {
    const vals = (f) => rs.map(f).filter((x) => typeof x === "number");
    summary[c] = {
      runs: rs.map((r) => r.name),
      outputFps: st(vals((r) => r.outputFpsAfter2s)),
      drawnButMissing: st(vals((r) => r.drawnButMissing)),
      gapsOver50ms: st(vals((r) => r.gapsOver50ms)),
      maxGapMs: st(vals((r) => r.gapMs && r.gapMs.max)),
      drawsPerSec: st(vals((r) => r.drawsPerSec)),
      cpuPctOfMachine: st(vals((r) => r.cpuPctOfMachineTotal)),
      gapShareLe50: st(vals((r) => r.gapShareLe50)),
      drawIntervalsUnder20ms: st(vals((r) => r.drawIntervalsUnder20ms)),
      drawIntervalsOver50ms: st(vals((r) => r.drawIntervalsOver50ms)),
      rafTicksPerSec: st(vals((r) => r.rafTicksPerSec)),
      experimentGpu3dPct: st(vals((r) => r.gpu && r.gpu.experiment3dPct && r.gpu.experiment3dPct.mean)),
      allProcessesGpu3dPct: st(vals((r) => r.gpu && r.gpu.allProcesses3dPct && r.gpu.allProcesses3dPct.mean)),
      startup: rs.map((r) => r.startup),
      D_audioStampDelayMs_mean: st(vals((r) => r.av && r.av.D_audioStampDelayMs && r.av.D_audioStampDelayMs.mean)),
      fileOffsetMs_mean: st(vals((r) => r.av && r.av.fileOffsetMs && r.av.fileOffsetMs.mean)),
    };
  }
  fs.writeFileSync(path.join(OUT, "experiments-results.json"), JSON.stringify({ results, summary }, null, 2));
  console.log(JSON.stringify({ summary, unavailable: Object.fromEntries(Object.entries(results).filter(([, r]) => r.unavailable).map(([k, r]) => [k, r.unavailable])), noVideo: Object.fromEntries(Object.entries(results).filter(([, r]) => r.noVideo).map(([k, r]) => [k, r])) }, null, 1));
})();
