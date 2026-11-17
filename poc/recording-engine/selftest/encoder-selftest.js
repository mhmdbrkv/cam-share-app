"use strict";
/*
 * Offline Chromium MediaRecorder self-test for the POC's privacy markers and barcodes.
 *   SELFTEST_OUT=<dir outside repo> npx electron poc/recording-engine/selftest/encoder-selftest.js
 *
 * NO CAPTURE: frames are drawn on a synthetic <canvas>. This process denies every display-media
 * request (handler can only call cb(null)) and every 'media' permission, and never calls
 * desktopCapturer, getDisplayMedia or getUserMedia. The canvas is encoded by Chromium's real
 * MediaRecorder with the POC's MIME order and bitrate, then written as synthetic run folders
 * (summary.selftest = true) that analyze.js can read.
 */
const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path"),
  fs = require("fs"),
  os = require("os");

const OUT = process.env.SELFTEST_OUT;
if (!OUT) {
  console.error("SELFTEST_OUT is required");
  process.exit(64);
}
const REPO = path.resolve(__dirname, "..", "..", "..");
const rel = path.relative(REPO, OUT);
if (!(rel.startsWith("..") || path.isAbsolute(rel))) {
  console.error("refusing to write inside the repository");
  process.exit(65);
}
fs.mkdirSync(OUT, { recursive: true });
const note = (o) => fs.appendFileSync(path.join(OUT, "encoder-selftest.log.jsonl"), JSON.stringify({ wall: Date.now(), ...o }) + "\n");

const VARIANTS = [
  { name: "A-clean", seconds: 8, instr: true, foreign: null },
  { name: "B-foreign-15-frames", seconds: 8, instr: true, foreign: [120, 134] },
  { name: "C-foreign-1-frame", seconds: 8, instr: true, foreign: [120, 120] },
  { name: "D-no-instrumentation", seconds: 8, instr: false, foreign: null },
];

app.setPath("userData", path.join(app.getPath("temp"), "camshare-poc-selftest-encoder"));
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

app.whenReady().then(() => {
  // Capture is impossible by construction in this process.
  session.defaultSession.setDisplayMediaRequestHandler((_r, cb) => {
    note({ kind: "unexpected-display-media-request-denied" });
    cb(null);
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission !== "media" && permission !== "display-capture"));

  let ws = null,
    vdir = null,
    vfile = null;
  ipcMain.handle("st:variants", () => VARIANTS);
  ipcMain.handle("st:begin", (_e, name) => {
    vdir = path.join(OUT, name);
    fs.mkdirSync(vdir, { recursive: true });
    vfile = path.join(vdir, `selftest-${name}.webm`);
    ws = fs.createWriteStream(vfile, { flags: "wx" });
    note({ kind: "begin", name });
    return true;
  });
  ipcMain.handle(
    "st:chunk",
    (_e, buf) => new Promise((res, rej) => ws.write(Buffer.from(buf), (err) => (err ? rej(err) : res(true)))),
  );
  ipcMain.handle("st:end", async (_e, meta) => {
    await new Promise((res) => ws.end(res));
    const runId = `selftest-${meta.name}`;
    const run = {
      runId,
      selftest: true,
      versions: process.versions,
      platform: process.platform,
      logicalCpus: os.cpus().length,
      primaryDisplay: null,
      displayCount: null,
      source: { commit: "n/a (synthetic canvas self-test)" },
      sourceCheck: {},
      gpuInfo: null,
    };
    const summary = {
      reason: "completed",
      scenario: "selftest",
      selftest: true,
      captureMode: "selftest-synthetic-canvas",
      minutes: meta.seconds / 60,
      backgroundThrottling: false,
      errors: [],
      ready: { canvas: [1920, 1080], screen: { width: 1920, height: 1080 } },
      recStarted: { mime: meta.mime },
      mrStartCalled: { renderer: { t: meta.startCalledT, wall: meta.startCalledWall, c: meta.compAtStart } },
      mrStart: { renderer: { t: meta.onstartT, wall: meta.onstartWall } },
      mrStop: { renderer: { t: meta.onstopT, wall: meta.onstopWall } },
      result: { result: { file: vfile, partial: false, seekable: false, durationWrittenMs: null } },
      io: {},
      variant: meta.variant,
      foreignDrawnFrames: meta.foreignDrawn,
      pixelCheck: meta.pixelCheck,
    };
    fs.writeFileSync(path.join(vdir, "run.json"), JSON.stringify(run, null, 2));
    fs.writeFileSync(path.join(vdir, "summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(vdir, "frames.jsonl"), meta.frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
    fs.writeFileSync(path.join(vdir, "events.jsonl"), "");
    note({ kind: "end", name: meta.name, mime: meta.mime, frames: meta.frames.length, foreignDrawn: meta.foreignDrawn, pixelCheck: meta.pixelCheck });
    return true;
  });
  ipcMain.on("st:done", (_e, info) => {
    note({ kind: "done", ...info });
    app.exit(info && info.error ? 1 : 0);
  });
  ipcMain.on("st:log", (_e, o) => note({ kind: "page", ...o }));

  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 360,
    height: 260,
    title: "CamShare POC encoder self-test (synthetic canvas, no capture)",
    show: true,
    backgroundColor: "#102030",
    webPreferences: {
      preload: path.join(__dirname, "encoder-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, "encoder-page.html"));
  setTimeout(() => {
    note({ kind: "hard-timeout" });
    app.exit(3);
  }, 120000);
});
