#!/usr/bin/env node
"use strict";
/*
 * Timing-only analysis of real CamShare APP recordings (privacy-preserving).
 *   node poc/recording-engine/investigate/app-timing.js <file.webm|mp4> [...more files]
 *
 * Reads ONLY container metadata and packet timestamps (ffprobe), plus a decode-to-null integrity
 * check and seek checks. It never extracts, saves, prints or views frames or audio samples.
 * App recordings contain no measurement barcodes, so drawn-but-missing frames, freshness and
 * A/V offset cannot be measured here and are reported as NOT MEASURED.
 */
const { spawnSync } = require("child_process");
const fs = require("fs"),
  path = require("path");
const tool = (n) => {
  const p = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", n + ".exe");
  return fs.existsSync(p) ? p : n;
};
const FFPROBE = tool("ffprobe"),
  FFMPEG = tool("ffmpeg");
const st = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return { n: a.length, mean: +(a.reduce((p, x) => p + x, 0) / a.length).toFixed(2), p50: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s[s.length - 1].toFixed(1) };
};
const json = (args) => JSON.parse(spawnSync(FFPROBE, args, { encoding: "utf8", maxBuffer: 1 << 28 }).stdout || "{}");

function analyze(file) {
  const fmt = json(["-v", "error", "-show_format", "-show_streams", "-of", "json", file]);
  const vs = (fmt.streams || []).find((s) => s.codec_type === "video");
  const as = (fmt.streams || []).find((s) => s.codec_type === "audio");
  const pk = (sel) => ((json(["-v", "error", "-select_streams", sel, "-show_entries", "packet=pts_time,duration_time", "-of", "json", file]).packets) || []).map((p) => ({ pts: Number(p.pts_time), dur: Number(p.duration_time) })).filter((p) => Number.isFinite(p.pts));
  const vFile = pk("v:0");
  let nonIncreasing = 0;
  for (let i = 1; i < vFile.length; i++) if (vFile[i].pts <= vFile[i - 1].pts) nonIncreasing++;
  const v = vFile.map((p) => p.pts).sort((a, b) => a - b);
  const a = as ? pk("a:0").sort((x, y) => x.pts - y.pts) : [];
  const gaps = [];
  for (let i = 1; i < v.length; i++) gaps.push((v[i] - v[i - 1]) * 1000);
  const after2 = v.filter((p) => p >= v[0] + 2);
  const fps = after2.length > 1 ? (after2.length - 1) / (after2[after2.length - 1] - after2[0]) : null;
  const early = [];
  for (let i = 1; i < v.length && v[i] <= v[0] + 3; i++) early.push({ gapMs: (v[i] - v[i - 1]) * 1000, afterPts: v[i - 1] });
  const earlyMax = early.reduce((m, x) => (x.gapMs > m.gapMs ? x : m), { gapMs: 0, afterPts: null });
  const spanS = v.length ? v[v.length - 1] - v[0] : 0;
  const medianGap = st(gaps) ? st(gaps).p50 / 1000 : 0;
  const lengthS = spanS + medianGap;
  const meta = fmt.format && Number(fmt.format.duration);
  const dec = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-enc_time_base", "demux", "-fps_mode", "passthrough", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const decErr = (dec.stderr || "").split("\n").filter((l) => l.trim()).length;
  const seeks = [0.25, 0.5, 0.75].map((f) => {
    const r = spawnSync(FFMPEG, ["-v", "error", "-ss", (lengthS * f).toFixed(3), "-i", file, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" });
    return r.status === 0 && !(r.stderr || "").trim();
  });
  const audioEnd = a.length ? a[a.length - 1].pts + (Number.isFinite(a[a.length - 1].dur) ? a[a.length - 1].dur : 0) : null;
  return {
    file: path.basename(file),
    sizeMB: +(fs.statSync(file).size / 1048576).toFixed(1),
    video: vs && { codec: vs.codec_name, width: vs.width, height: vs.height },
    audio: as ? { codec: as.codec_name, channels: as.channels, packets: a.length } : "none",
    frames: v.length,
    fpsAfter2s: fps && +fps.toFixed(3),
    framesVs30fps: lengthS ? +((v.length / (30 * lengthS)) * 100).toFixed(2) : null,
    gapMs: st(gaps),
    gapShareLe50: gaps.length ? +((gaps.filter((g) => g <= 50.0001).length / gaps.length) * 100).toFixed(2) : null,
    gapsOver100ms: gaps.filter((g) => g > 100).length,
    gapsUnder20ms: gaps.filter((g) => g < 20).length,
    startup: { firstVideoPts: v[0], largestGapFirst3sMs: +earlyMax.gapMs.toFixed(1), afterPts: earlyMax.afterPts },
    durationS: { metadata: meta, videoLength: +lengthS.toFixed(3), metadataMinusVideo: meta ? +(meta - lengthS).toFixed(3) : null },
    audioTiming: a.length ? { firstAudioMinusFirstVideoMs: +((a[0].pts - v[0]) * 1000).toFixed(1), audioEndMinusVideoEndS: +(audioEnd - (v[v.length - 1] + medianGap)).toFixed(3) } : "no audio",
    integrity: { genuineDecodeErrorLines: decErr, videoPtsNonIncreasing: nonIncreasing, seekOk: `${seeks.filter(Boolean).length}/3` },
    notMeasured: "drawn-but-missing frames, screen/camera freshness, A/V offset (no measurement markers in app recordings); CPU/GPU (not sampled)",
  };
}
for (const f of process.argv.slice(2)) console.log(JSON.stringify(analyze(f), null, 1));
