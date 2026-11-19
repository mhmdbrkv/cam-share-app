#!/usr/bin/env node
"use strict";
/*
 * CamShare Recording Engine POC: analyzer.
 *   node poc/recording-engine/analyze.js "<run folder>"
 *
 * Requires ffmpeg AND ffprobe (looks at --ffmpeg-dir=, FFMPEG_DIR, PATH, then the
 * winget Links folder). If either is missing it STOPS with exit code 3. There is no
 * weaker fallback by design.
 *
 * Never modifies the run's original files: results go to <run>/analysis-<timestamp>/.
 * Every metric is reported as MEASURED with its value, or NOT MEASURED with the reason.
 * A criterion is PASS only when its metric was actually measured and met the threshold.
 */
const fs = require("fs"),
  path = require("path"),
  { spawn, spawnSync } = require("child_process");

const args = process.argv.slice(2);
const runDir = args.find((a) => !a.startsWith("--"));
const optDir = (args.find((a) => a.startsWith("--ffmpeg-dir=")) || "").slice(13);
if (!runDir || !fs.existsSync(runDir)) {
  console.error("usage: node analyze.js <run folder> [--ffmpeg-dir=DIR]");
  process.exit(64);
}

/* ---------- barcode (must match barcode.js) ---------- */
const BITS = 20,
  CHECK = 4,
  CELLS = 2 + BITS + CHECK;
function check(v) {
  let c = 0;
  for (let i = 0; i < BITS; i += 4) c ^= (v >>> i) & 0xf;
  return c;
}

/* ---------- privacy canaries (must match Canary in barcode.js) ---------- */
const C_SIZE = 12,
  C_STEP = 64,
  C_OFF = 16;
const C_EXCL = [
  [0, 0, 992, 100],
  [36, 856, 328, 188],
];
const overlaps = (x, y, s, r) => x < r[0] + r[2] && x + s > r[0] && y < r[1] + r[3] && y + s > r[1];
function canaryPositions(W, H) {
  const out = [];
  for (let y = C_OFF; y + C_SIZE <= H; y += C_STEP)
    for (let x = C_OFF; x + C_SIZE <= W; x += C_STEP) if (!C_EXCL.some((r) => overlaps(x, y, C_SIZE, r))) out.push([x, y]);
  return out;
}
function canaryOk(f, W, x, y) {
  const q = (cx, cy) => (f[cy * W + cx] + f[cy * W + cx + 1] + f[(cy + 1) * W + cx] + f[(cy + 1) * W + cx + 1]) / 4;
  return q(x + 2, y + 2) > 150 && q(x + 8, y + 8) > 150 && q(x + 8, y + 2) < 100 && q(x + 2, y + 8) < 100;
}

/* ---------- layout contract (see recorder.js / pattern.js) ---------- */
const L = {
  comp: { x: 0, y: 0, cell: 32 },
  screen: { x: 0, y: 64, cell: 32 },
  flash: { x: 896, y: 0, w: 96, h: 96 },
  cam: { x: 0, y: 0, cell: 48, w: 1280, h: 720 },
  stampBottom: 130,
};

/* ---------- thresholds (approved Phase 1 criteria) ---------- */
const T = {
  minMeanFps: 29.0,
  maxGapMsShare: { ms: 50, share: 0.99 },
  maxGapForegroundMs: 200,
  maxMissingShare: 0.01,
  maxDupShare: 0.01,
  minScreenFresh: 0.95,
  minCamPresent: 1.0,
  minCamFresh: 0.95,
  maxGeomErrPx: 2,
  maxAvOffsetMs: 40,
  maxAvDriftMs: 20,
  maxDurationErrS: 1,
  minFrameShare: 0.99,
  minBarcodeDecode: 0.99, // below this, barcode-derived metrics are NOT MEASURED
};

function findTool(name) {
  const exe = name + (process.platform === "win32" ? ".exe" : "");
  const dirs = [optDir, process.env.FFMPEG_DIR, ...(process.env.PATH || "").split(path.delimiter)];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
  for (const d of dirs.filter(Boolean)) {
    const p = path.join(d, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const FFMPEG = findTool("ffmpeg"),
  FFPROBE = findTool("ffprobe");
if (!FFMPEG || !FFPROBE) {
  console.error(
    `STOP: required tool missing: ${!FFMPEG ? "ffmpeg " : ""}${!FFPROBE ? "ffprobe" : ""}. No fallback validation is performed.`,
  );
  process.exit(3);
}

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
const readJsonl = (f) => {
  const p = path.join(runDir, f);
  if (!fs.existsSync(p)) return null;
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};
const run = readJson("run.json");
const summary = readJson("summary.json");
const events = readJsonl("events.jsonl") || [];
const frames = readJsonl("frames.jsonl") || [];
const metrics = readJsonl("metrics.jsonl") || [];
const rstats = readJsonl("renderer-stats.jsonl") || [];
const patMetrics = readJsonl("pattern-metrics.jsonl") || [];

const measured = (value, unit, note) => ({ status: "MEASURED", value, unit, note });
const notMeasured = (reason) => ({ status: "NOT MEASURED", reason });
const R = { metrics: {}, criteria: [], notes: [] };
const crit = (id, desc, threshold, m, ok) => {
  R.criteria.push({
    id,
    desc,
    threshold,
    measured: m.status === "MEASURED" ? m.value : null,
    unit: m.unit,
    result: m.status !== "MEASURED" ? "NOT MEASURED" : ok ? "PASS" : "FAIL",
    reason: m.status !== "MEASURED" ? m.reason : m.note,
  });
};
const q = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
function slope(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs),
    my = mean(ys);
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : null;
}

async function main() {
  const t0 = Date.now();
  const file = summary.result && summary.result.result && summary.result.result.file;
  R.run = {
    runId: run.runId,
    scenario: summary.scenario,
    reason: summary.reason,
    minutes: summary.minutes,
    file,
    sourceCommit: run.source.commit,
    sourceDrift: Object.entries(run.sourceCheck).filter(([, c]) => !c.match).map(([f]) => f),
    versions: { electron: run.versions.electron, chrome: run.versions.chrome, node: run.versions.node },
    display: run.primaryDisplay,
    displayCount: run.displayCount,
    backgroundThrottling: summary.backgroundThrottling,
    errors: summary.errors,
    ffmpeg: spawnSync(FFMPEG, ["-version"], { encoding: "utf8" }).stdout.split("\n")[0],
  };
  if (!file || !fs.existsSync(file)) {
    R.notes.push("No recording file was produced; all file-derived metrics are NOT MEASURED.");
    return finishReport();
  }
  R.run.fileBytes = fs.statSync(file).size;
  R.run.recorderResult = summary.result.result;

  /* ---------- wall-clock expectations ---------- */
  const mrStartWall = summary.mrStart && summary.mrStart.renderer && summary.mrStart.renderer.wall;
  const mrStopWall = summary.mrStop && summary.mrStop.renderer && summary.mrStop.renderer.wall;
  const wallS = mrStartWall && mrStopWall ? (mrStopWall - mrStartWall) / 1000 : null;

  /* ---------- container / streams ---------- */
  const probe = JSON.parse(
    spawnSync(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
    }).stdout || "{}",
  );
  const vs = (probe.streams || []).find((s) => s.codec_type === "video");
  const as = (probe.streams || []).find((s) => s.codec_type === "audio");
  R.metrics.container = measured(
    {
      format: probe.format && probe.format.format_name,
      metadataDurationS: probe.format && Number(probe.format.duration),
      video: vs && { codec: vs.codec_name, profile: vs.profile, width: vs.width, height: vs.height, pix_fmt: vs.pix_fmt, r_frame_rate: vs.r_frame_rate, avg_frame_rate: vs.avg_frame_rate, start_time: Number(vs.start_time) },
      audio: as && { codec: as.codec_name, sample_rate: as.sample_rate, channels: as.channels, start_time: Number(as.start_time) },
      mime: summary.recStarted && summary.recStarted.mime,
    },
    "",
    "ffprobe",
  );

  /* ---------- packet timing ---------- */
  const pk = (sel) =>
    (
      JSON.parse(
        spawnSync(FFPROBE, ["-v", "error", "-select_streams", sel, "-show_entries", "packet=pts_time,flags,size", "-of", "json", file], {
          encoding: "utf8",
          maxBuffer: 1 << 30,
        }).stdout || "{}",
      ).packets || []
    )
      .map((p) => ({ pts: Number(p.pts_time), key: (p.flags || "").includes("K"), size: Number(p.size) }))
      .filter((p) => Number.isFinite(p.pts));
  const vpkFileOrder = pk("v:0");
  let nonIncreasing = 0;
  for (let i = 1; i < vpkFileOrder.length; i++) if (vpkFileOrder[i].pts <= vpkFileOrder[i - 1].pts) nonIncreasing++;
  R.metrics.ptsMonotonic = measured({ videoPacketsNonIncreasingInFileOrder: nonIncreasing }, "packets", "ffprobe packet pts in file order");
  const vpk = [...vpkFileOrder].sort((a, b) => a.pts - b.pts);
  const apk = as ? pk("a:0").sort((a, b) => a.pts - b.pts) : [];
  const vpts = vpk.map((p) => p.pts);
  let timing = null;
  if (vpts.length > 10) {
    const span = vpts[vpts.length - 1] - vpts[0];
    const gaps = [];
    for (let i = 1; i < vpts.length; i++) gaps.push((vpts[i] - vpts[i - 1]) * 1000);
    const after2 = vpts.filter((p) => p >= vpts[0] + 2);
    const fpsAfter2 = after2.length > 1 ? (after2.length - 1) / (after2[after2.length - 1] - after2[0]) : null;
    timing = {
      frames: vpts.length,
      firstPts: vpts[0],
      lastPts: vpts[vpts.length - 1],
      spanS: span,
      meanFpsAll: (vpts.length - 1) / span,
      meanFpsAfter2s: fpsAfter2,
      gapP50: q(gaps, 0.5),
      gapP95: q(gaps, 0.95),
      gapP99: q(gaps, 0.99),
      gapMax: Math.max(...gaps),
      shareGapsLe50: gaps.filter((g) => g <= 50.0001).length / gaps.length,
      gapsOver50: gaps.filter((g) => g > 50.0001).length,
      gapsOver100: gaps.filter((g) => g > 100).length,
      gapsOver200: gaps.filter((g) => g > 200).length,
      gapsOver500: gaps.filter((g) => g > 500).length,
      keyframes: vpk.filter((p) => p.key).length,
      videoKbps: (vpk.reduce((s, p) => s + p.size, 0) * 8) / span / 1000,
      audioPackets: apk.length,
      audioSpanS: apk.length ? apk[apk.length - 1].pts - apk[0].pts : null,
      gapHistogramMs: hist(gaps, [20, 30, 34, 40, 50, 67, 100, 200, 500]),
    };
    R.metrics.timing = measured(timing, "", "ffprobe packet timestamps");
  } else R.metrics.timing = notMeasured("fewer than 10 video packets");

  /* ---------- full decode check ----------
   * Fix after run 20261117-021546-smoke: ffmpeg's null muxer defaults to a 1/60 output timebase
   * (r_frame_rate 60/1), so frames < 16.7 ms apart produce "non monotonically increasing dts to
   * muxer" lines. Those are output-side rounding warnings, not decoding errors. Genuine errors are
   * taken from a decode that keeps the demuxer timebase; the warnings are counted separately.
   */
  const MUXER_WARN = /non monotonically increasing dts to muxer/;
  const dec = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-enc_time_base", "demux", "-fps_mode", "passthrough", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const decLines = (dec.stderr || "").split("\n").filter((l) => l.trim());
  const decErrors = decLines.filter((l) => !MUXER_WARN.test(l));
  const dflt = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const dfltLines = (dflt.stderr || "").split("\n").filter((l) => l.trim());
  R.metrics.decode = measured(
    {
      exitCode: dec.status,
      genuineErrorLines: decErrors.length,
      genuineSample: decErrors.slice(0, 5),
      muxerTimestampWarnings_defaultTimebase: dfltLines.filter((l) => MUXER_WARN.test(l)).length,
      otherLines_defaultTimebase: dfltLines.filter((l) => !MUXER_WARN.test(l)).length,
    },
    "",
    "ffmpeg -v error decode to null (demux timebase); default-timebase run for warnings",
  );

  /* ---------- seek test ---------- */
  const seeks = [];
  const dur = timing ? timing.spanS : null;
  if (dur)
    for (const f of [0.25, 0.5, 0.75]) {
      const ss = (dur * f).toFixed(3);
      const t = Date.now();
      const r = spawnSync(FFMPEG, ["-v", "error", "-ss", ss, "-i", file, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" });
      seeks.push({ at: Number(ss), ok: r.status === 0 && !(r.stderr || "").trim(), ms: Date.now() - t, stderr: (r.stderr || "").trim().slice(0, 200) });
    }
  R.metrics.seek = seeks.length ? measured(seeks, "", "ffmpeg -ss input seek, 1 frame decode") : notMeasured("no timing");

  /* ---------- frame content (barcodes, flash, PiP geometry, handle) ---------- */
  const W = vs && vs.width,
    H = vs && vs.height;
  const frameMap = new Map(frames.map((f) => [f[0], f]));
  const content = await analyzeContent(file, W, H, frameMap, vpts);
  R.metrics.content = content;

  /* ---------- audio markers ---------- */
  R.metrics.av = as ? await analyzeAv(file, as, content, vpts) : notMeasured("no audio stream");

  /* ---------- audio presence from the start (fix after run 20261117-021546-smoke) ---------- */
  if (as && timing && R.metrics.av.status === "MEASURED") {
    const aGaps = [];
    for (let i = 1; i < apk.length; i++) aGaps.push((apk[i].pts - apk[i - 1].pts) * 1000);
    const decodedS = R.metrics.av.value.audioSamples / 48000;
    R.metrics.audioPresence = measured(
      {
        audioPackets: apk.length,
        firstAudioPts: apk.length ? apk[0].pts : null,
        firstVideoPts: timing.firstPts,
        audioStartsAfterVideoMs: apk.length ? (apk[0].pts - timing.firstPts) * 1000 : null,
        audioDecodedS: decodedS,
        videoSpanS: timing.spanS,
        coverage: decodedS / (timing.spanS + (timing.gapP50 || 0) / 1000),
        maxAudioPacketGapMs: aGaps.length ? Math.max(...aGaps) : null,
      },
      "",
      "ffprobe audio packets + decoded sample count",
    );
  } else R.metrics.audioPresence = notMeasured(as ? "audio/timing not measured" : "no audio stream");

  /* ---------- recording start delay ---------- */
  const called = summary.mrStartCalled && summary.mrStartCalled.renderer;
  const onstart = summary.mrStart && summary.mrStart.renderer;
  const cv = content.status === "MEASURED" ? content.value : null;
  const firstLog = cv && cv.firstComp !== undefined && cv.firstComp !== null ? frameMap.get(cv.firstComp) : null;
  if (called && firstLog)
    R.metrics.startDelay = measured(
      {
        firstFileFrameDrawnAfterStartCallMs: firstLog[1] - called.t,
        onstartAfterStartCallMs: onstart ? onstart.t - called.t : null,
        firstFileFrameComp: cv.firstComp,
        compAtStartCall: called.c,
        framesDrawnBeforeFirstFileFrame: cv.firstComp - called.c - 1,
      },
      "ms",
      "renderer performance.now(): first compositor frame found in the file vs the mr.start() call",
    );
  else R.metrics.startDelay = notMeasured(called ? "first file frame not identified (barcode)" : "mr.start() call time not logged (pre-fix run)");

  /* ---------- duration accuracy ---------- */
  if (timing) {
    const mediaS = timing.spanS + (timing.gapP50 || 0) / 1000;
    const stopT = summary.mrStop && summary.mrStop.renderer && summary.mrStop.renderer.t;
    R.metrics.duration = measured(
      {
        metadataS: R.metrics.container.value.metadataDurationS,
        mediaVideoS: mediaS,
        metadataMinusMediaS: R.metrics.container.value.metadataDurationS - mediaS,
        recorderWallS_startCallToStop: called && stopT ? (stopT - called.t) / 1000 : null,
        recorderWallS_onstartToOnstop: wallS,
        durationWrittenMs: summary.result && summary.result.result && summary.result.result.durationWrittenMs,
      },
      "s",
      "metadata Duration vs video packet span (+1 median frame) vs renderer wall clock",
    );
  } else R.metrics.duration = notMeasured("no timing");

  /* ---------- resources ---------- */
  R.metrics.resources = analyzeResources(mrStartWall, mrStopWall);
  R.metrics.renderer = analyzeRenderer(mrStartWall, mrStopWall);
  R.metrics.gpu = analyzeGpu(mrStartWall, mrStopWall);

  /* ---------- contact sheet: only when every frame passed the privacy check ----------
   * If any frame failed, no image is extracted, so foreign content is never duplicated
   * into the analysis folder.
   */
  // Image extraction requires BOTH: every frame passed AND the capture target was verified
  // (window-capture runs). Offline encoder self-tests (summary.selftest, synthetic canvas, no
  // capture) have no capture target; for them only the per-frame check applies.
  const privOk = content.status === "MEASURED" && content.value.privacy.framesFailed === 0 && content.value.privacy.framesChecked === vpts.length;
  const targetOk =
    summary.captureMode === "window" &&
    !!(summary.captureSelection && summary.captureSelection.ok === true && summary.captureVerification && summary.captureVerification.ok === true);
  const imagesAllowed = privOk && (targetOk || summary.selftest === true);
  R.privacyGate = { framesOk: privOk, targetOk, selftest: summary.selftest === true, imagesAllowed };
  if (!imagesAllowed)
    R.contactSheet = `not generated: ${!privOk ? "the per-frame privacy check did not pass for every frame" : "the capture target was not verified"}`;
  else if (dur) {
    const outPng = path.join(outDirAnalysis(), "contact-sheet.png");
    const every = Math.max(1, dur / 13);
    const r = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-vf", `fps=1/${every.toFixed(3)},scale=480:-2,tile=4x3`, "-frames:v", "1", "-y", outPng], { encoding: "utf8" });
    R.contactSheet = r.status === 0 ? outPng : { error: (r.stderr || "").slice(0, 300) };
  }

  /* ---------- criteria ---------- */
  evaluate(timing, content, wallS, decErrors, seeks, W, H);
  R.analysisSeconds = (Date.now() - t0) / 1000;
  finishReport();
}

// Run-level privacy verdict. FAIL if even one frame failed (P.frames not PASS) or, for real runs,
// the capture target was not verified (P.target not PASS). Drives the analyzer's exit code.
function privacyVerdict() {
  const get = (id) => (R.criteria.find((c) => c.id === id) || {}).result;
  const frames = get("P.frames");
  const target = get("P.target");
  const pass = frames === "PASS" && (target === "PASS" || summary.selftest === true);
  return { pass, frames: frames || "NOT EVALUATED", target: target || "NOT EVALUATED" };
}

function hist(values, edges) {
  const h = {};
  let prev = 0;
  for (const e of edges) {
    h[`${prev}-${e}`] = values.filter((v) => v > prev && v <= e).length;
    prev = e;
  }
  h[`>${prev}`] = values.filter((v) => v > prev).length;
  h["<=0"] = values.filter((v) => v <= 0).length;
  return h;
}

function lumBox(f, W, H, cx, cy, half) {
  let s = 0,
    n = 0;
  const y0 = Math.max(0, Math.round(cy - half)),
    y1 = Math.min(H - 1, Math.round(cy + half));
  const x0 = Math.max(0, Math.round(cx - half)),
    x1 = Math.min(W - 1, Math.round(cx + half));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    s += f[y * W + x];
    n++;
  }
  return n ? s / n : NaN;
}
function readBarcode(f, W, H, x0, y0, cellX, cellY) {
  const half = Math.max(0, Math.floor(Math.min(cellX, cellY) * 0.25));
  const lv = [];
  for (let i = 0; i < CELLS; i++) lv.push(lumBox(f, W, H, x0 + (i + 0.5) * cellX, y0 + 0.5 * cellY, half));
  const white = lv[0],
    black = lv[1];
  if (!(white - black > 60)) return null;
  const thr = (white + black) / 2;
  let v = 0;
  for (let i = 0; i < BITS; i++) if (lv[2 + i] > thr) v |= 1 << i;
  let c = 0;
  for (let i = 0; i < CHECK; i++) if (lv[2 + BITS + i] > thr) c |= 1 << i;
  return c === check(v) ? v : null;
}
function peakCol(f, W, H, xc, ya, yb) {
  let best = -1,
    bx = null;
  for (let x = Math.round(xc) - 6; x <= Math.round(xc) + 6; x++) {
    if (x < 0 || x >= W) continue;
    let s = 0,
      n = 0;
    for (let y = Math.round(ya); y <= Math.round(yb); y += 2) {
      s += f[y * W + x];
      n++;
    }
    if (n && s / n > best) {
      best = s / n;
      bx = x;
    }
  }
  return { x: bx, lum: best };
}
function peakRow(f, W, H, yc, xa, xb) {
  let best = -1,
    by = null;
  for (let y = Math.round(yc) - 6; y <= Math.round(yc) + 6; y++) {
    if (y < 0 || y >= H) continue;
    let s = 0,
      n = 0;
    for (let x = Math.round(xa); x <= Math.round(xb); x += 2) {
      s += f[y * W + x];
      n++;
    }
    if (n && s / n > best) {
      best = s / n;
      by = y;
    }
  }
  return { y: by, lum: best };
}

function analyzeContent(file, W, H, frameMap, vpts) {
  return new Promise((resolve) => {
    if (!W || !H) return resolve(notMeasured("no video stream"));
    const size = W * H;
    const p = spawn(FFMPEG, ["-v", "error", "-i", file, "-map", "0:v:0", "-enc_time_base", "demux", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    let frame = Buffer.allocUnsafe(size),
      fill = 0,
      idx = 0,
      stderr = "";
    const comp = [],
      scr = [],
      cam = [],
      flash = [],
      geom = [],
      handle = [];
    let camExpected = 0,
      camDecoded = 0,
      camSkippedOverlap = 0;
    // Privacy: EVERY decoded frame is checked. A frame passes only if every canary outside the
    // PiP rect (+4 px for the border) is intact AND the test-window barcode decodes. A frame whose
    // PiP rect cannot be identified is checked against all canaries (strict: it fails if the PiP
    // hides any). Never sampled.
    const canaries = canaryPositions(W, H);
    const priv = { framesChecked: 0, framesFailed: 0, framesBarcodeMissing: 0, framesUnidentifiedPip: 0, canaryFailuresTotal: 0, maxCanaryFailuresInFrame: 0, failedRuns: [], canariesPerFrame: canaries.length };
    let runStart = null;
    const onFrame = (f, i) => {
      const c = readBarcode(f, W, H, L.comp.x, L.comp.y, L.comp.cell, L.comp.cell);
      comp.push(c);
      {
        const lg = c !== null ? frameMap.get(c) : undefined;
        const rc = lg ? lg[3] : null;
        if (c === null || lg === undefined) priv.framesUnidentifiedPip++;
        const ex = rc ? [rc[0] - 4, rc[1] - 4, rc[2] + 8, rc[3] + 8] : null;
        let failed = 0;
        for (const [x, y] of canaries) {
          if (ex && overlaps(x, y, C_SIZE, ex)) continue;
          if (!canaryOk(f, W, x, y)) failed++;
        }
        const pipOverCode = rc && rc[1] < L.screen.y + L.screen.cell + 4 && rc[0] < L.screen.x + CELLS * L.screen.cell;
        const codeOk = pipOverCode || readBarcode(f, W, H, L.screen.x, L.screen.y, L.screen.cell, L.screen.cell) !== null;
        priv.framesChecked++;
        priv.canaryFailuresTotal += failed;
        if (failed > priv.maxCanaryFailuresInFrame) priv.maxCanaryFailuresInFrame = failed;
        if (!codeOk) priv.framesBarcodeMissing++;
        const bad = failed > 0 || !codeOk;
        if (bad) {
          priv.framesFailed++;
          if (!priv.failedComps) priv.failedComps = [];
          if (priv.failedComps.length < 100) priv.failedComps.push(c); // compositor frame numbers (null = unreadable)
          if (runStart === null) runStart = i;
        } else if (runStart !== null) {
          priv.failedRuns.push([runStart, i - 1]);
          runStart = null;
        }
      }
      const fl = lumBox(f, W, H, L.flash.x + L.flash.w / 2, L.flash.y + L.flash.h / 2, 24);
      flash.push(fl);
      const log = c !== null ? frameMap.get(c) : undefined;
      const rect = log ? log[3] : null;
      const overScreenCode = rect && rect[1] < L.screen.y + L.screen.cell + 4 && rect[0] < L.screen.x + CELLS * L.screen.cell;
      scr.push(overScreenCode ? undefined : readBarcode(f, W, H, L.screen.x, L.screen.y, L.screen.cell, L.screen.cell));
      if (rect) {
        const [rx, ry, rw, rh] = rect;
        if (ry < L.stampBottom) {
          camSkippedOverlap++;
          cam.push(undefined);
        } else {
          camExpected++;
          const sx = rw / L.cam.w,
            sy = rh / L.cam.h;
          const k = readBarcode(f, W, H, rx + L.cam.x * sx, ry + L.cam.y * sy, L.cam.cell * sx, L.cam.cell * sy);
          if (k !== null) camDecoded++;
          cam.push(k);
          // resize handle must never be drawn while recording (gray patch underneath)
          handle.push(lumBox(f, W, H, rx + rw - 10.5, ry + rh - 10.5, 5));
          if (i % 15 === 0) {
            const left = peakCol(f, W, H, rx, ry + rh * 0.4, ry + rh * 0.6);
            const right = peakCol(f, W, H, rx + rw, ry + rh * 0.4, ry + rh * 0.6);
            const bottom = peakRow(f, W, H, ry + rh, rx + rw * 0.1, rx + rw * 0.6);
            geom.push({
              i,
              left: left.x === null ? null : left.x - rx,
              right: right.x === null ? null : right.x - (rx + rw),
              bottom: bottom.y === null ? null : bottom.y - (ry + rh),
              lum: [left.lum, right.lum, bottom.lum].map((v) => Math.round(v)),
            });
          }
        }
      } else cam.push(null);
    };
    p.stdout.on("data", (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(size - fill, chunk.length - off);
        chunk.copy(frame, fill, off, off + n);
        fill += n;
        off += n;
        if (fill === size) {
          onFrame(frame, idx++);
          fill = 0;
        }
      }
    });
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", () => {
      const out = { decodedFrames: idx, packetFrames: vpts.length, frameCountMatch: idx === vpts.length, ffmpegStderr: stderr.trim().slice(0, 500) };
      if (runStart !== null) priv.failedRuns.push([runStart, idx - 1]);
      priv.failedRunsPts = priv.failedRuns.slice(0, 20).map(([a, b]) => [vpts[a], vpts[b]]);
      out.privacy = priv;
      // compositor sequence
      const compOk = comp.filter((v) => v !== null);
      out.compDecodeShare = compOk.length / Math.max(1, comp.length);
      let missing = 0,
        dups = 0,
        backwards = 0,
        pairs = 0;
      for (let i = 1; i < comp.length; i++) {
        if (comp[i] === null || comp[i - 1] === null) continue;
        pairs++;
        const d = comp[i] - comp[i - 1];
        if (d === 0) dups++;
        else if (d > 1) missing += d - 1;
        else if (d < 0) backwards++;
      }
      const firstC = compOk[0],
        lastC = compOk[compOk.length - 1];
      out.firstComp = comp[0];
      out.comp = { first: firstC, last: lastC, drawnInSpan: lastC - firstC + 1, pairs, missing, duplicates: dups, backwards, missingShare: missing / Math.max(1, lastC - firstC), dupShare: dups / Math.max(1, pairs) };
      // screen freshness
      let sPairs = 0,
        sFresh = 0,
        sDecoded = 0,
        sTotal = 0;
      for (let i = 0; i < scr.length; i++) {
        if (scr[i] === undefined) continue;
        sTotal++;
        if (scr[i] !== null) sDecoded++;
        if (i > 0 && scr[i] !== null && scr[i - 1] !== null && scr[i - 1] !== undefined) {
          sPairs++;
          if (scr[i] > scr[i - 1]) sFresh++;
        }
      }
      out.screen = { decodeShare: sDecoded / Math.max(1, sTotal), pairs: sPairs, freshShare: sFresh / Math.max(1, sPairs) };
      // camera
      let kPairs = 0,
        kFresh = 0,
        kBack = 0;
      for (let i = 1; i < cam.length; i++) {
        if (cam[i] == null || cam[i - 1] == null) continue;
        kPairs++;
        if (cam[i] > cam[i - 1]) kFresh++;
        if (cam[i] < cam[i - 1]) kBack++;
      }
      const framesWithRect = cam.filter((v) => v !== null).length;
      out.camera = {
        framesWithPipLogged: framesWithRect,
        framesWithoutPip: cam.filter((v) => v === null).length,
        expected: camExpected,
        decoded: camDecoded,
        presentShare: camExpected ? camDecoded / camExpected : null,
        skippedOverlapWithStamps: camSkippedOverlap,
        pairs: kPairs,
        freshShare: kPairs ? kFresh / kPairs : null,
        backwards: kBack,
      };
      const hv = handle.filter((v) => Number.isFinite(v));
      out.handle = { samples: hv.length, maxLum: hv.length ? Math.max(...hv) : null, framesOver200: hv.filter((v) => v > 200).length };
      const ge = geom.flatMap((g) => [g.left, g.right, g.bottom]).filter((v) => v !== null);
      const borderLumMin = geom.length ? Math.min(...geom.flatMap((g) => g.lum)) : null;
      out.geometry = { samples: geom.length, maxAbsErrPx: ge.length ? Math.max(...ge.map(Math.abs)) : null, meanAbsErrPx: ge.length ? mean(ge.map(Math.abs)) : null, minBorderLum: borderLumMin };
      // flash events (rising edges)
      const fl = [];
      for (let i = 0; i < flash.length; i++) if (flash[i] > 128 && (i === 0 || !(flash[i - 1] > 128))) fl.push({ i, pts: vpts[i], comp: comp[i] });
      out.flashes = fl;
      resolve(measured(out, "", "ffmpeg gray decode + barcode reading"));
    });
  });
}

function analyzeAv(file, as, content, vpts) {
  return new Promise((resolve) => {
    if (content.status !== "MEASURED") return resolve(notMeasured("frame content not measured"));
    if (!content.value.frameCountMatch) return resolve(notMeasured("decoded frame count != packet count, video marker times unreliable"));
    const SR = 48000;
    const p = spawn(FFMPEG, ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(SR), "-f", "s16le", "pipe:1"]);
    let idx = 0,
      silent = SR,
      carry = null,
      peak = 0;
    const onsets = [];
    const thr = 0.05 * 32768;
    p.stdout.on("data", (chunk) => {
      let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const n = Math.floor(buf.length / 2);
      for (let i = 0; i < n; i++) {
        const s = Math.abs(buf.readInt16LE(i * 2));
        if (s > peak) peak = s;
        if (s > thr) {
          if (silent >= SR / 2) onsets.push(idx);
          silent = 0;
        } else silent++;
        idx++;
      }
      carry = buf.length % 2 ? buf.subarray(buf.length - 1) : null;
    });
    p.on("close", () => {
      const aStart = Number(as.start_time) || 0;
      const aOn = onsets.map((s) => aStart + s / SR);
      const pairs = [];
      for (const f of content.value.flashes) {
        let best = null;
        for (const a of aOn) if (best === null || Math.abs(a - f.pts) < Math.abs(best - f.pts)) best = a;
        if (best !== null && Math.abs(best - f.pts) < 0.5) pairs.push({ videoPts: f.pts, audioPts: best, offsetMs: (best - f.pts) * 1000 });
      }
      const offs = pairs.map((x) => x.offsetMs);
      resolve(
        measured(
          {
            audioSamples: idx,
            audioStartTime: aStart,
            peak,
            videoFlashes: content.value.flashes.length,
            audioOnsets: aOn.length,
            matched: pairs.length,
            offsetsMs: offs.map((o) => r2(o, 1)),
            meanOffsetMs: offs.length ? mean(offs) : null,
            maxAbsOffsetMs: offs.length ? Math.max(...offs.map(Math.abs)) : null,
            driftMs: offs.length > 1 ? offs[offs.length - 1] - offs[0] : null,
            note: "positive offset = audio later than video",
          },
          "ms",
          "flash frame pts vs 1 kHz tone onset",
        ),
      );
    });
  });
}

function inRec(rows, a, b) {
  return rows.filter((r) => (!a || r.wall >= a) && (!b || r.wall <= b));
}
function analyzeResources(a, b) {
  const rows = inRec(metrics, a, b);
  if (!rows.length) return notMeasured("no metrics samples during recording");
  const cores = run.logicalCpus;
  const per = rows.map((r) => {
    const byType = {};
    let cpu = 0,
      ws = 0,
      priv = 0;
    for (const p of r.procs) {
      cpu += p.cpu;
      ws += p.wsKB;
      priv += p.privKB || 0;
      const k = p.pid === summary.recorderPid ? "Tab(recorder)" : p.type;
      byType[k] = (byType[k] || 0) + p.cpu;
    }
    return { wall: r.wall, cpu, ws: ws / 1024, priv: priv / 1024, byType, sys: r.sysCpuPct };
  });
  const types = [...new Set(per.flatMap((p) => Object.keys(p.byType)))];
  const byTypeMean = Object.fromEntries(types.map((t) => [t, r2(mean(per.map((p) => p.byType[t] || 0)), 1)]));
  const xs = per.map((p) => (p.wall - per[0].wall) / 60000);
  const patRows = inRec(patMetrics, a, b);
  // Fix after run 20261117-021546-smoke: Electron's percentCPUUsage is a share of the WHOLE
  // machine (measured: a 1-core busy loop reads 6.2 % on 16 logical CPUs), not of one core.
  const cpus = per.map((p) => p.cpu);
  return measured(
    {
      samples: per.length,
      note: "Electron percentCPUUsage = % of the whole machine (all logical CPUs). coreEquivalents = pct/100 x logical CPUs.",
      logicalCpus: cores,
      recorderAppCpuPctOfMachine: { mean: r2(mean(cpus), 2), p95: r2(q(cpus, 0.95), 2), max: r2(Math.max(...cpus), 2) },
      recorderAppCoreEquivalents: { mean: r2((mean(cpus) / 100) * cores, 2), max: r2((Math.max(...cpus) / 100) * cores, 2) },
      cpuByProcessTypeMeanPctOfMachine: byTypeMean,
      cpuTrendPctOfMachinePer10Min: r2((slope(xs, cpus) || 0) * 10, 2),
      systemCpuPct: { mean: r2(mean(per.map((p) => p.sys).filter((v) => v !== null)), 1), max: r2(Math.max(...per.map((p) => p.sys).filter((v) => v !== null)), 1) },
      workingSetMB: { first: r2(per[0].ws, 0), last: r2(per[per.length - 1].ws, 0), max: r2(Math.max(...per.map((p) => p.ws)), 0), slopeMBperMin: r2(slope(xs, per.map((p) => p.ws)), 2) },
      privateMB: { first: r2(per[0].priv, 0), last: r2(per[per.length - 1].priv, 0), max: r2(Math.max(...per.map((p) => p.priv)), 0) },
      patternAppCpuPctOfMachineMean: patRows.length ? r2(mean(patRows.map((r) => r.procs.reduce((s, p) => s + p.cpu, 0))), 2) : null,
      patternAppWorkingSetMBMean: patRows.length ? r2(mean(patRows.map((r) => r.procs.reduce((s, p) => s + p.wsKB, 0) / 1024)), 0) : null,
      io: summary.io,
    },
    "",
    "app.getAppMetrics() 1 Hz + os.cpus()",
  );
}
function analyzeRenderer(a, b) {
  const rows = inRec(rstats, a, b);
  if (!rows.length) return notMeasured("no renderer stats during recording");
  const col = (k) => rows.map((r) => r[k]).filter((v) => typeof v === "number");
  const stat = (k) => {
    const v = col(k);
    return v.length ? { mean: r2(mean(v), 2), min: Math.min(...v), max: Math.max(...v) } : null;
  };
  const inb = rows.map((r) => r.inbound).filter((x) => x && typeof x.fps === "number");
  return measured(
    {
      samples: rows.length,
      drawsPerSec: stat("draws"),
      rafDrawsPerSec: stat("rafDraws"),
      intervalDrawsPerSec: stat("intervalDraws"),
      rafTicksPerSec: stat("raf"),
      intervalTicksPerSec: stat("intervalTicks"),
      screenVideoFramesPerSec_rVFC: stat("svFrames"),
      cameraVideoFramesPerSec_rVFC: stat("cvFrames"),
      chunkWriteMsMax: Math.max(...col("chunkMsMax")),
      maxPendingBytes: Math.max(...col("maxPending")),
      heapMB: stat("heapMB"),
      visibility: [...new Set(rows.map((r) => r.vis))],
      focusShare: rows.filter((r) => r.focus).length / rows.length,
      camLiveShare: rows.filter((r) => r.camLive).length / rows.length,
      trackStats: rows[rows.length - 1].trackStats,
      inbound: inb.length ? { fpsMean: r2(mean(inb.map((x) => x.fps)), 1), fpsMin: Math.min(...inb.map((x) => x.fps)), size: `${inb[inb.length - 1].w}x${inb[inb.length - 1].h}`, framesDropped: inb[inb.length - 1].framesDropped, freezeCount: inb[inb.length - 1].freezeCount } : null,
    },
    "",
    "recorder renderer counters, 1 Hz",
  );
}
function analyzeGpu(a, b) {
  const p = path.join(runDir, "gpu.csv");
  if (!fs.existsSync(p)) return notMeasured("gpu.csv missing (typeperf did not run)");
  const text = fs.readFileSync(p, "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 3) return notMeasured("gpu.csv has no samples");
  const parse = (l) => l.split('","').map((s) => s.replace(/^"|"$/g, ""));
  const head = parse(lines[0]);
  const pids = new Set();
  for (const r of metrics) for (const pr of r.procs) pids.add(pr.pid);
  // Fix after run 20261117-021546-smoke: measure the synthetic test screen (pattern app) separately
  const patPids = new Set();
  for (const r of patMetrics) for (const pr of r.procs) patPids.add(pr.pid);
  const cols = head.slice(1).map((h, i) => {
    const m = /pid_(\d+)_luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_\d+_eng_(\d+)_engtype_([^)]*)\)/.exec(h);
    return m ? { i: i + 1, pid: Number(m[1]), luid: m[2], eng: m[3], type: m[4] || "unknown" } : null;
  });
  const mine = cols.filter((c) => c && pids.has(c.pid));
  if (!mine.length) return notMeasured("no GPU engine counters found for the recorder's processes");
  function fold(src, dst) {
    const byType = {};
    for (const [k, val] of Object.entries(src)) {
      const [luid, type] = k.split("|");
      const tk = `${luid} ${type}`;
      byType[tk] = Math.max(byType[tk] || 0, val);
    }
    for (const [k, val] of Object.entries(byType)) (dst[k] = dst[k] || []).push(val);
  }
  const series = {};
  const sysSeries = {};
  const patSeries = {};
  for (const l of lines.slice(1)) {
    const v = parse(l);
    const t = Date.parse(v[0]);
    if (a && b && Number.isFinite(t) && (t < a || t > b)) continue;
    const acc = {},
      sysAcc = {},
      patAcc = {};
    for (const c of cols) {
      if (!c) continue;
      const val = Number(v[c.i]);
      if (!Number.isFinite(val)) continue;
      const key = `${c.luid}|${c.type}|${c.eng}`;
      sysAcc[key] = (sysAcc[key] || 0) + val;
      if (pids.has(c.pid)) acc[key] = (acc[key] || 0) + val;
      if (patPids.has(c.pid)) patAcc[key] = (patAcc[key] || 0) + val;
    }
    fold(patAcc, patSeries);
    fold(acc, series);
    fold(sysAcc, sysSeries);
  }
  const sum = (s) =>
    Object.fromEntries(
      Object.entries(s)
        .filter(([, v]) => Math.max(...v) > 0)
        .map(([k, v]) => [k, { mean: r2(mean(v), 1), max: r2(Math.max(...v), 1), samples: v.length }]),
    );
  const encCols = cols.filter((c) => c && /VideoEncode/i.test(c.type));
  return measured(
    {
      recorderProcesses: sum(series),
      patternProcesses: sum(patSeries),
      allProcesses: sum(sysSeries),
      videoEncodeInstances: encCols.map((c) => ({ pid: c.pid, luid: c.luid, recorder: pids.has(c.pid), pattern: patPids.has(c.pid) })),
      note: "per adapter LUID and engine type; max over engines of that type; only engines with non-zero use listed; typeperf instances fixed at its start (3 s after recording start)",
      // GPU status: before/after recording (window-capture runs) or after-start (run 20261117-022724)
      gpuStatusRecorder: summary.gpu || (summary.gpuAfterStart && { afterStart: summary.gpuAfterStart }) || null,
      gpuStatusPattern: summary.patternGpu || (summary.patternGpuAfterStart && { afterStart: summary.patternGpuAfterStart }) || null,
    },
    "%",
    "typeperf GPU Engine Utilization Percentage, 1 Hz",
  );
}

function evaluate(timing, content, wallS, decErrors, seeks, W, H) {
  const C = content.status === "MEASURED" ? content.value : null;
  const ready = summary.ready || {};
  const expected = ready.canvas || null;
  const m = (cond, v, unit, note) => (cond ? measured(v, unit, note) : notMeasured(note || "input missing"));
  const compReliable = C && C.compDecodeShare >= T.minBarcodeDecode;

  // Privacy (window capture)
  const sel = summary.captureSelection,
    ver = summary.captureVerification;
  crit("P.target", "Capture target: explicitly selected test window, verified before recording", "window capture, id + HWND + nonce title match, pixel verification ok", m(sel !== undefined, sel && ver ? `selection ${sel.ok ? "ok" : "REJECTED"}; pixels ${ver.ok ? "ok" : "FAILED"}; mode ${summary.captureMode}` : "no capture-target records (pre-window-capture run)", "", sel && ver ? `source ${sel.sourceId}; ${ver.canaries || "?"} canaries x ${ver.samples ? ver.samples.length : 0} frames` : "missing"), sel && ver && sel.ok && ver.ok && summary.captureMode === "window");
  const P = C && C.privacy;
  crit("P.frames", "Every frame shows only the synthetic test window (all canaries + barcode)", "0 failed of all frames", m(P && P.framesChecked > 0, P && `${P.framesFailed} failed / ${P.framesChecked} checked`, "", P ? `${P.canariesPerFrame} canaries per frame; barcode missing in ${P.framesBarcodeMissing}; PiP unidentified in ${P.framesUnidentifiedPip}; failed runs (pts) ${JSON.stringify(P.failedRunsPts)}` : ""), P && P.framesChecked === (timing ? timing.frames : -1) && P.framesFailed === 0);

  // O1
  crit("O1.res", "Output resolution equals the 1080p canvas (no upscale, aspect kept)", `${expected ? expected.join("x") : "?"} from a ${ready.screen ? ready.screen.width + "x" + ready.screen.height : "?"} screen`, m(W && expected, `${W}x${H}`, "", "ffprobe vs canvas size"), expected && W === expected[0] && H === expected[1] && H <= 1080);
  crit("O1.fps", "Mean output frame rate (excluding first 2 s)", `>= ${T.minMeanFps} fps`, m(timing, timing && r2(timing.meanFpsAfter2s, 2), "fps", "packet timestamps"), timing && timing.meanFpsAfter2s >= T.minMeanFps);
  crit("O1.gaps", "Share of frame gaps <= 50 ms", `>= ${T.maxGapMsShare.share * 100} %`, m(timing, timing && r2(timing.shareGapsLe50 * 100, 2), "%", "packet timestamps"), timing && timing.shareGapsLe50 >= T.maxGapMsShare.share);
  crit("O1.maxgap", "Largest frame gap (foreground)", `<= ${T.maxGapForegroundMs} ms`, m(timing, timing && r2(timing.gapMax, 1), "ms", "packet timestamps"), timing && timing.gapMax <= T.maxGapForegroundMs);
  crit("O1.missing", "Compositor frames drawn but missing from the file", `<= ${T.maxMissingShare * 100} %`, m(compReliable, C && r2(C.comp.missingShare * 100, 2), "%", compReliable ? `${C.comp.missing} of ${C.comp.drawnInSpan} drawn` : `compositor barcode decoded in ${C ? r2(C.compDecodeShare * 100, 1) : 0} % of frames`), compReliable && C.comp.missingShare <= T.maxMissingShare);
  crit("O1.dups", "Duplicated output frames (same compositor frame twice)", `<= ${T.maxDupShare * 100} %`, m(compReliable, C && r2(C.comp.dupShare * 100, 2), "%", "compositor barcode"), compReliable && C.comp.dupShare <= T.maxDupShare);
  const scrOk = C && C.screen.decodeShare >= T.minBarcodeDecode;
  crit("O1.screenFresh", "Output frames showing new screen content", `>= ${T.minScreenFresh * 100} %`, m(scrOk, C && r2(C.screen.freshShare * 100, 2), "%", scrOk ? "screen barcode" : `screen barcode decoded in ${C ? r2(C.screen.decodeShare * 100, 1) : 0} % of frames`), scrOk && C.screen.freshShare >= T.minScreenFresh);

  // O2
  const camOk = C && C.camera.expected > 0;
  crit("O2.present", "Camera visible (barcode decoded) in frames while connected", `${T.minCamPresent * 100} %`, m(camOk, C && C.camera.presentShare !== null && r2(C.camera.presentShare * 100, 2), "%", camOk ? `${C.camera.decoded}/${C.camera.expected}` : "no frames with a logged PiP rect"), camOk && C.camera.presentShare >= T.minCamPresent);
  crit("O2.fresh", "Camera freshness (new camera frame between output frames)", `>= ${T.minCamFresh * 100} %`, m(camOk && C.camera.pairs > 0, C && C.camera.freshShare !== null && r2(C.camera.freshShare * 100, 2), "%", "camera barcode"), camOk && C.camera.freshShare >= T.minCamFresh);
  crit("O2.geom", "PiP border position vs logged rect (left/right/bottom)", `<= ${T.maxGeomErrPx} px`, m(C && C.geometry.samples > 0 && C.geometry.maxAbsErrPx !== null, C && C.geometry.maxAbsErrPx, "px", C ? `${C.geometry.samples} sampled frames; min border luminance ${C.geometry.minBorderLum}` : ""), C && C.geometry.maxAbsErrPx <= T.maxGeomErrPx);
  crit("O2.handle", "Resize handle never visible in the output", "0 frames", m(C && C.handle.samples > 0, C && C.handle.framesOver200, "frames", C ? `${C.handle.samples} frames checked, max luminance ${r2(C.handle.maxLum, 0)}` : ""), C && C.handle.framesOver200 === 0);

  // File integrity (O5 criteria, indicative on a short run)
  const dm = R.metrics.decode.value;
  crit("F.decode", "Full decode: genuine decoding errors", "0 error lines", measured(decErrors.length, "lines", `ffmpeg -v error, demux timebase. Separately: ${dm.muxerTimestampWarnings_defaultTimebase} muxer timestamp warnings at ffmpeg's default 1/60 output timebase (output-side rounding, not file errors)`), decErrors.length === 0);
  const pm = R.metrics.ptsMonotonic.value.videoPacketsNonIncreasingInFileOrder;
  crit("F.pts", "Video timestamps strictly increasing in the file", "0 packets", measured(pm, "packets", "ffprobe, file order"), pm === 0);
  crit("F.seek", "Seek at 25/50/75 %", "3/3 ok", m(seeks.length === 3, seeks.filter((s) => s.ok).length + "/3", "", "ffmpeg -ss"), seeks.length === 3 && seeks.every((s) => s.ok));
  const du = R.metrics.duration.status === "MEASURED" ? R.metrics.duration.value : null;
  crit("F.metaDur", "Duration in file metadata vs actual video length", `±${T.maxDurationErrS} s`, m(du && Number.isFinite(du.metadataS), du && r2(du.metadataMinusMediaS, 3), "s", du ? `metadata ${r2(du.metadataS, 3)} s, video ${r2(du.mediaVideoS, 3)} s` : "missing"), du && Math.abs(du.metadataMinusMediaS) <= T.maxDurationErrS);
  const recWall = du && du.recorderWallS_startCallToStop;
  crit("F.spanDur", "Actual video length vs time between mr.start() and onstop", `±${T.maxDurationErrS} s`, m(du && recWall, du && recWall && r2(du.mediaVideoS - recWall, 3), "s", du && recWall ? `video ${r2(du.mediaVideoS, 3)} s, recorder ${r2(recWall, 3)} s` : "mr.start() call time not logged"), du && recWall && Math.abs(du.mediaVideoS - recWall) <= T.maxDurationErrS);
  crit("F.frames", "Frame count vs 30 fps x actual video length", `>= ${T.minFrameShare * 100} %`, m(timing && du, timing && du && r2((timing.frames / (30 * du.mediaVideoS)) * 100, 2), "%", timing && du ? `${timing.frames} frames / ${r2(30 * du.mediaVideoS, 0)} expected` : "missing"), timing && du && timing.frames / (30 * du.mediaVideoS) >= T.minFrameShare);

  // Recording start + audio presence. PROVISIONAL thresholds: not part of the approved
  // Phase 1 criteria; added after run 20261117-021546-smoke and labelled as provisional.
  const sd = R.metrics.startDelay;
  crit("S.delay", "Recording start delay: first frame in file drawn after mr.start() call (PROVISIONAL threshold)", "<= 500 ms", m(sd.status === "MEASURED", sd.status === "MEASURED" && r2(sd.value.firstFileFrameDrawnAfterStartCallMs, 1), "ms", sd.status === "MEASURED" ? `onstart fired ${r2(sd.value.onstartAfterStartCallMs, 1)} ms after start(); ${sd.value.framesDrawnBeforeFirstFileFrame} frames drawn before the first recorded one` : sd.reason), sd.status === "MEASURED" && sd.value.firstFileFrameDrawnAfterStartCallMs <= 500);
  const ap = R.metrics.audioPresence;
  crit("S.audioStart", "Audio present from the start: first audio pts minus first video pts (PROVISIONAL)", "<= 100 ms", m(ap.status === "MEASURED", ap.status === "MEASURED" && r2(ap.value.audioStartsAfterVideoMs, 1), "ms", ap.reason), ap.status === "MEASURED" && ap.value.audioStartsAfterVideoMs <= 100);
  crit("S.audioCover", "Audio covers the whole video: decoded audio / video length (PROVISIONAL)", ">= 99 %", m(ap.status === "MEASURED", ap.status === "MEASURED" && r2(ap.value.coverage * 100, 2), "%", ap.status === "MEASURED" ? `${r2(ap.value.audioDecodedS, 2)} s audio, max packet gap ${r2(ap.value.maxAudioPacketGapMs, 1)} ms` : ap.reason), ap.status === "MEASURED" && ap.value.coverage >= 0.99);

  // A/V
  const av = R.metrics.av;
  const avOk = av.status === "MEASURED" && av.value.matched > 0;
  const expMarkers = wallS ? Math.max(0, Math.floor((wallS - 5) / 10) + 1) : null;
  crit("AV.markers", "A/V markers found in both video and audio", `${expMarkers} expected`, m(av.status === "MEASURED", av.status === "MEASURED" && `${av.value.matched} matched (${av.value.videoFlashes} flashes, ${av.value.audioOnsets} tones)`, "", av.reason), avOk && av.value.matched === expMarkers && av.value.videoFlashes === expMarkers);
  crit("AV.offset", "Max |audio - video| offset", `<= ${T.maxAvOffsetMs} ms`, m(avOk, avOk && r2(av.value.maxAbsOffsetMs, 1), "ms", avOk ? `mean ${r2(av.value.meanOffsetMs, 1)} ms (positive = audio late)` : av.reason || "no matched markers"), avOk && av.value.maxAbsOffsetMs <= T.maxAvOffsetMs);
  crit("AV.drift", "Offset drift first->last marker", `<= ${T.maxAvDriftMs} ms`, m(avOk && av.value.matched > 1, avOk && r2(av.value.driftMs, 1), "ms", "markers"), avOk && Math.abs(av.value.driftMs) <= T.maxAvDriftMs);

  // Resources: REPORT-ONLY targets from the Phase 1 plan (the spec forbids stopping on load).
  const rs = R.metrics.resources;
  crit("R.cpu", "Recorder app CPU, whole machine, mean (REPORT-ONLY target)", "<= 15 % of machine", m(rs.status === "MEASURED", rs.status === "MEASURED" && rs.value.recorderAppCpuPctOfMachine.mean, "% of machine", rs.status === "MEASURED" ? `~${rs.value.recorderAppCoreEquivalents.mean} cores of ${rs.value.logicalCpus}; test-screen app ${rs.value.patternAppCpuPctOfMachineMean} % of machine` : rs.reason), rs.status === "MEASURED" && rs.value.recorderAppCpuPctOfMachine.mean <= 15);
  const gp = R.metrics.gpu;
  const g3d = gp.status === "MEASURED" ? Object.entries(gp.value.recorderProcesses).filter(([k]) => / 3D$/.test(k)).map(([, v]) => v.mean) : [];
  crit("R.gpu3d", "Recorder app GPU 3D engine, mean (REPORT-ONLY target)", "<= 30 %", m(g3d.length > 0, g3d.length && Math.max(...g3d), "%", gp.status === "MEASURED" ? "typeperf, recorder PIDs only" : gp.reason), g3d.length > 0 && Math.max(...g3d) <= 30);
  crit("R.mem", "Memory growth over the recording (O5 criterion)", "<= 50 MB from minute 5", notMeasured("run shorter than 10 minutes; growth over 2 minutes is reported in analysis.json only"), false);

  if (summary.captureMode === "window")
    R.notes.push(
      "Capture mode: WINDOW capture of the synthetic test window. This validates the recording engine (compositor, MediaRecorder, storage, A/V) with a window source. It does NOT validate full-display (screen) capture behaviour, cost or quality.",
    );
  else R.notes.push("Capture mode: full-display capture (pre-window-capture run). No per-run capture-target verification records exist.");
  R.notes.push(
    "Privacy check limits: canaries are 12x12 px every 64 px. Any opaque foreign region larger than about 76x76 px covers at least one canary and fails the frame; smaller foreign content between canaries is not guaranteed to be detected by this check.",
  );
  R.notes.push(
    "Smoke scope: O1/O2 thresholds are applied to a 2-minute foreground run and are indicative only. O3 (PiP changes), O4 (background) and O5 (30 minutes) are not in scope for this run.",
  );
}

let _ad = null;
function outDirAnalysis() {
  if (_ad) return _ad;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  _ad = path.join(runDir, `analysis-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`);
  fs.mkdirSync(_ad, { recursive: false });
  return _ad;
}

function finishReport() {
  const dir = outDirAnalysis();
  R.privacy = privacyVerdict();
  fs.writeFileSync(path.join(dir, "analysis.json"), JSON.stringify(R, null, 2));
  const lines = [];
  lines.push(`# POC analysis: ${R.run.runId}`, "");
  lines.push(
    `**PRIVACY: ${R.privacy.pass ? "PASS" : "FAIL — the run is invalid"}** (P.frames ${R.privacy.frames}, P.target ${R.privacy.target}${summary.selftest ? ", offline self-test: no capture target" : ""}) · contact sheet: ${typeof R.contactSheet === "string" && R.contactSheet.startsWith("not generated") ? R.contactSheet : R.contactSheet ? "generated" : "not generated"}`,
    "",
  );
  // Exit code 4 = privacy failure (run invalid regardless of other results).
  if (!R.privacy.pass) process.exitCode = 4;
  lines.push(`Scenario: ${R.run.scenario} · end reason: ${R.run.reason} · Electron ${R.run.versions.electron} / Chromium ${R.run.versions.chrome}`);
  lines.push(`Source: ${R.run.sourceCommit}${R.run.sourceDrift.length ? ` · DRIFT in ${R.run.sourceDrift.join(", ")}` : " · no drift"}`);
  lines.push(`Tooling: ${R.run.ffmpeg}`, "");
  lines.push("| ID | Criterion | Threshold | Measured | Result | Notes |", "|---|---|---|---|---|---|");
  for (const c of R.criteria)
    lines.push(`| ${c.id} | ${c.desc} | ${c.threshold} | ${c.measured === null || c.measured === false ? "—" : c.measured}${c.unit && c.measured !== null && c.measured !== false ? " " + c.unit : ""} | **${c.result}** | ${c.reason || ""} |`);
  lines.push("", "## Notes", ...R.notes.map((n) => `- ${n}`), "", "Full metrics: analysis.json");
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nWritten to ${dir}`);
}

main().catch((e) => {
  console.error("Analyzer failed:", e);
  process.exit(1);
});
