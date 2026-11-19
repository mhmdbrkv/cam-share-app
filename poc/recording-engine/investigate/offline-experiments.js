"use strict";
/*
 * Offline FPS + A/V experiments (Electron main). NO CAPTURE, NO MICROPHONE:
 * synthetic canvas + synthetic WebAudio only. Every display-media request is denied and every
 * 'media' / 'display-capture' permission is refused in this process.
 *   XP_OUT=<dir outside repo> npx electron poc/recording-engine/investigate/offline-experiments.js
 */
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path"),
  fs = require("fs"),
  os = require("os"),
  { spawn } = require("child_process");

const OUT = process.env.XP_OUT;
if (!OUT) {
  console.error("XP_OUT is required");
  process.exit(64);
}
const REPO = path.resolve(__dirname, "..", "..", "..");
const rel = path.relative(REPO, OUT);
if (!(rel.startsWith("..") || path.isAbsolute(rel))) {
  console.error("refusing to write inside the repository");
  process.exit(65);
}
fs.mkdirSync(OUT, { recursive: true });
const note = (o) => fs.appendFileSync(path.join(OUT, "experiments.log.jsonl"), JSON.stringify({ wall: Date.now(), ...o }) + "\n");

const PLAN_FIRST = [
  { name: "fps-app-loop", scheduler: "app", seconds: 60, marker: null },
  { name: "fps-deadline", scheduler: "deadline", seconds: 60, marker: null },
  { name: "av-worklet-interactive", scheduler: "deadline", seconds: 40, marker: "worklet", latencyHint: "interactive" },
  { name: "av-worklet-balanced", scheduler: "deadline", seconds: 40, marker: "worklet", latencyHint: "balanced" },
  { name: "av-worklet-playback", scheduler: "deadline", seconds: 40, marker: "worklet", latencyHint: "playback" },
  { name: "av-legacy-interactive", scheduler: "deadline", seconds: 40, marker: "legacy", latencyHint: "interactive" },
];
// Follow-up (XP_PLAN=followup): warm-up, then option A (captureStream(30)) vs option B
// (captureStream(0) + requestFrame), each "plain" (default AudioContext, bed only) and "avlike"
// (explicit latencyHint interactive + AudioWorklet markers), 3 repeats, seeded random order;
// then direct-track audio (MediaStreamTrackGenerator, no WebAudio) with two timestamp modes.
function followupPlan(seed) {
  const conds = {
    "A-plain": { scheduler: "deadline", capture: "rate30", marker: null },
    "A-avlike": { scheduler: "deadline", capture: "rate30", marker: "worklet", latencyHint: "interactive" },
    "B-plain": { scheduler: "deadline", capture: "requestFrame", marker: null },
    "B-avlike": { scheduler: "deadline", capture: "requestFrame", marker: "worklet", latencyHint: "interactive" },
  };
  const runs = [];
  for (const [k, c] of Object.entries(conds)) for (let r = 1; r <= 3; r++) runs.push({ name: `${k}-r${r}`, condition: k, seconds: 30, ...c });
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [runs[i], runs[j]] = [runs[j], runs[i]];
  }
  return [
    { name: "warmup", condition: "warmup", scheduler: "deadline", capture: "rate30", seconds: 10, marker: null },
    ...runs.map((r, i) => ({ ...r, name: `${String(i + 1).padStart(2, "0")}-${r.name}` })),
    { name: "13-av-generator-perf", condition: "generator-perf", scheduler: "deadline", capture: "rate30", audioMode: "generator", marker: "generator", tsMode: "perf", seconds: 30 },
    { name: "14-av-generator-counter", condition: "generator-counter", scheduler: "deadline", capture: "rate30", audioMode: "generator", marker: "generator", tsMode: "counter", seconds: 30 },
  ];
}
// Follow-up 2 (XP_PLAN=followup2): GPU/CPU cost and contention, warm process.
//   A30 = fixed schedule + captureStream(30); B = fixed schedule + captureStream(0)+requestFrame;
//   Bs = smoothed schedule (never < 25 ms between draws, no catch-up) + requestFrame;
//   each without and with a separate synthetic GPU-load process; 2 repeats; 20 s; seeded order.
function followup2Plan(seed) {
  const conds = {
    "A30-noload": { scheduler: "deadline", capture: "rate30" },
    "B-noload": { scheduler: "deadline", capture: "requestFrame" },
    "Bs-noload": { scheduler: "smooth", capture: "requestFrame" },
    "A30-load": { scheduler: "deadline", capture: "rate30", load: true },
    "B-load": { scheduler: "deadline", capture: "requestFrame", load: true },
    "Bs-load": { scheduler: "smooth", capture: "requestFrame", load: true },
  };
  const runs = [];
  for (const [k, c] of Object.entries(conds)) for (let r = 1; r <= 2; r++) runs.push({ name: `${k}-r${r}`, condition: k, seconds: 20, marker: null, ...c });
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [runs[i], runs[j]] = [runs[j], runs[i]];
  }
  return [{ name: "warmup", condition: "warmup", scheduler: "deadline", capture: "rate30", seconds: 10, marker: null }, ...runs.map((r, i) => ({ ...r, name: `${String(i + 1).padStart(2, "0")}-${r.name}` }))];
}
// Cold start (XP_PLAN=cold-baseline | cold-prime): ONE 10 s recording as the FIRST recording of a
// fresh process. baseline = option B pushing frames only from mr.start() (as the POC recorder);
// prime = option B pushing frames from 500 ms before mr.start().
// Follow-up 3 (XP_PLAN=followup3): B vs Bs under a near-saturating WebGL GPU load
// (XP_LOAD_LEVEL, calibrated: level 5 ~97 % total 3D), 3 repeats x 20 s, seeded order.
function followup3Plan(seed) {
  const runs = [];
  for (const [k, c] of Object.entries({ "B-heavy": { scheduler: "deadline" }, "Bs-heavy": { scheduler: "smooth" } }))
    for (let r = 1; r <= 3; r++) runs.push({ name: `${k}-r${r}`, condition: k, seconds: 20, marker: null, capture: "requestFrame", load: true, ...c });
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [runs[i], runs[j]] = [runs[j], runs[i]];
  }
  return [{ name: "warmup", condition: "warmup", scheduler: "deadline", capture: "rate30", seconds: 10, marker: null }, ...runs.map((r, i) => ({ ...r, name: `${String(i + 1).padStart(2, "0")}-${r.name}` }))];
}
const COLD = {
  "cold-prime1500": [{ name: "cold-prime1500", condition: "cold-prime1500", scheduler: "deadline", capture: "requestFrame", primeMs: 1500, seconds: 10, marker: null }],
  "cold-prewarm": [{ name: "cold-prewarm", condition: "cold-prewarm", scheduler: "deadline", capture: "requestFrame", primeMs: 0, prewarm: true, seconds: 10, marker: null }],
  "cold-baseline": [{ name: "cold-baseline", condition: "cold-baseline", scheduler: "deadline", capture: "requestFrame", primeMs: 0, seconds: 10, marker: null }],
  "cold-prime": [{ name: "cold-prime", condition: "cold-prime", scheduler: "deadline", capture: "requestFrame", primeMs: 500, seconds: 10, marker: null }],
};
const PLAN =
  process.env.XP_PLAN === "followup" ? followupPlan(20261117) : process.env.XP_PLAN === "followup2" ? followup2Plan(20261118) : process.env.XP_PLAN === "followup3" ? followup3Plan(20261119) : COLD[process.env.XP_PLAN] || PLAN_FIRST;

app.setPath("userData", path.join(app.getPath("temp"), "camshare-poc-offline-experiments"));
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion"); // as src/main.js

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_r, cb) => {
    note({ kind: "unexpected-display-media-request-denied" });
    cb(null);
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission !== "media" && permission !== "display-capture"));

  let ws = null,
    vdir = null,
    current = null;
  const metricsFile = path.join(OUT, "metrics.jsonl");
  setInterval(() => {
    fs.appendFileSync(
      metricsFile,
      JSON.stringify({
        wall: Date.now(),
        variant: current,
        procs: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage, wsKB: m.memory.workingSetSize })),
      }) + "\n",
    );
  }, 1000);

  ipcMain.handle("xp:plan", () => {
    note({ kind: "plan", order: PLAN.map((p) => p.name) });
    return PLAN;
  });
  // GPU sampling per run (XP_GPU=1): typeperf fixes its instance list at start, so one sampler is
  // started per run AFTER that run's processes (incl. the load process) exist; 1 Hz.
  let tp = null;
  const startTypeperf = (name) => {
    if (process.env.XP_GPU !== "1") return;
    tp = spawn("typeperf", ["\\GPU Engine(*)\\Utilization Percentage", "-si", "1", "-sc", "600", "-o", path.join(OUT, `gpu-${name}.csv`), "-f", "CSV", "-y"], { windowsHide: true, stdio: "ignore" });
    note({ kind: "typeperf-start", name, pid: tp.pid });
  };
  const stopTypeperf = () => {
    if (tp && tp.exitCode === null) tp.kill();
    tp = null;
  };
  // Synthetic GPU-load process, started per run that asks for it (separate PIDs, not captured).
  let loadChild = null;
  const startLoad = () =>
    new Promise((res) => {
      loadChild = spawn(process.execPath, [path.join(__dirname, "gpu-load.js"), `--level=${process.env.XP_LOAD_LEVEL || 1}`], { stdio: "ignore" });
      note({ kind: "load-start", pid: loadChild.pid });
      setTimeout(res, 2500); // let it reach steady drawing before the run
    });
  const stopLoad = () => {
    if (loadChild && loadChild.exitCode === null) loadChild.kill();
    if (loadChild) note({ kind: "load-stop", pid: loadChild.pid });
    loadChild = null;
  };
  app.on("before-quit", () => {
    stopLoad();
    stopTypeperf();
  });
  ipcMain.handle("xp:begin", async (_e, name) => {
    const v = PLAN.find((p) => p.name === name);
    if (v && v.load) await startLoad();
    startTypeperf(name);
    current = name;
    vdir = path.join(OUT, name);
    fs.mkdirSync(vdir, { recursive: true });
    ws = fs.createWriteStream(path.join(vdir, `${name}.webm`), { flags: "wx" });
    note({ kind: "begin", name });
    return true;
  });
  ipcMain.handle("xp:chunk", (_e, buf) => new Promise((res, rej) => ws.write(Buffer.from(buf), (err) => (err ? rej(err) : res(true)))));
  ipcMain.handle("xp:end", async (_e, meta) => {
    await new Promise((res) => ws.end(res));
    fs.writeFileSync(path.join(vdir, "meta.json"), JSON.stringify({ ...meta, file: path.join(vdir, `${meta.name}.webm`), electron: process.versions.electron, chrome: process.versions.chrome, logicalCpus: os.cpus().length }, null, 1));
    note({ kind: "end", name: meta.name, draws: meta.draws, rafTicks: meta.rafTicks, markers: meta.markers.length, audio: meta.audio, workletLoad: meta.workletLoad });
    current = null;
    stopTypeperf();
    stopLoad();
    return true;
  });
  ipcMain.on("xp:log", (_e, o) => note({ kind: "page", ...o }));
  ipcMain.on("xp:done", (_e, info) => {
    note({ kind: "done", ...info });
    stopLoad();
    stopTypeperf();
    setTimeout(() => app.exit(info && info.error ? 1 : 0), 500);
  });

  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 360,
    height: 240,
    title: "CamShare POC offline experiments (synthetic, no capture)",
    show: true,
    backgroundColor: "#102030",
    webPreferences: {
      preload: path.join(__dirname, "exp-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // as src/main.js
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.loadFile(path.join(__dirname, "exp-page.html"));
  setTimeout(() => {
    note({ kind: "hard-timeout" });
    stopLoad();
    stopTypeperf();
    app.exit(3);
  }, 15 * 60 * 1000);
});
