"use strict";
/*
 * CamShare Recording Engine POC: Electron main process (two roles).
 *
 * ISOLATED TEST HARNESS. Not part of the CamShare app and never packaged
 * (electron-builder only packs src/**). Run with the repo's installed Electron 33:
 *   npx electron poc/recording-engine/main.js --scenario=smoke
 *
 *   --role=recorder (default)  the recorder under test + orchestrator + metrics
 *   --role=pattern             spawned automatically: a separate Electron process that
 *                              covers the primary display with synthetic content and
 *                              plays the phone (synthetic camera over local WebRTC)
 *
 * Provenance of copied code: commit 6c3bf48a75025c9107729f56d2d01812bbf33ae3.
 * src/main.js sha256 dca804d7…9824, identical to HEAD and unmodified in the working
 * tree when copied (2026-11-17). Blocks are marked "COPIED FROM src/main.js@6c3bf48 La-Lb";
 * changed lines inside them are marked "POC CHANGE", added lines "POC ADD". The run
 * re-hashes the source files and records any drift in run.json.
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  screen,
  globalShortcut,
  powerSaveBlocker,
} = require("electron");
const path = require("path"),
  fs = require("fs"),
  os = require("os"),
  net = require("net"),
  crypto = require("crypto"),
  { spawn } = require("child_process"),
  { Readable } = require("stream"),
  { pipeline } = require("stream/promises"),
  { decideCaptureSource } = require("./capture-target");

const SOURCE = {
  commit: "6c3bf48a75025c9107729f56d2d01812bbf33ae3",
  copiedOn: "2026-11-17",
  workingTree: "src/main.js, src/renderer.js, server/public/m.html unmodified vs HEAD at copy time",
  sha256: {
    "src/main.js": "dca804d77bd10d8a73d7370adffa208f9b03d828f3aacf8b44e0a73b309c9824",
    "src/renderer.js": "3b5fe7e4e813b8b80a1bf979e6b8c6f57e6d75eb62db59c98ec14c41ff5c0176",
    "server/public/m.html": "8c85c6bb4eeb19a29a61ad133059cf4363e4a0f081b2741741c14c94c2da6c20",
  },
};
const REPO = path.resolve(__dirname, "..", "..");

const argv = process.argv.slice(1);
function arg(name, def) {
  const p = `--${name}=`;
  const a = argv.find((x) => x.startsWith(p));
  return a === undefined ? def : a.slice(p.length);
}
const ROLE = arg("role", "recorder");

// COPIED FROM src/main.js@6c3bf48 L166-169
// POC CHANGE: also disables WebRtcHideLocalIpsWithMdns so the same-machine WebRTC
// loopback can use plain host candidates (no mDNS resolution needed).
const DISABLE_FEATURES = "CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns";
app.commandLine.appendSwitch("disable-features", DISABLE_FEATURES);

function onLines(sock, cb) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        cb(JSON.parse(line));
      } catch (e) {
        console.error("bad line", e.message);
      }
    }
  });
}
const procMetrics = () =>
  app.getAppMetrics().map((m) => ({
    pid: m.pid,
    type: m.type,
    name: m.name,
    service: m.serviceName,
    cpu: m.cpu.percentCPUUsage,
    wakeups: m.cpu.idleWakeupsPerSecond,
    wsKB: m.memory.workingSetSize,
    privKB: m.memory.privateBytes,
    peakKB: m.memory.peakWorkingSetSize,
  }));

if (ROLE === "pattern") runPattern();
else runRecorder();

/* ====================================================================== */
/* Pattern role: covers the primary display, simulates the phone camera.  */
/* ====================================================================== */
function runPattern() {
  app.setName("CamShare-POC-pattern");
  app.setPath("userData", path.join(app.getPath("appData"), "CamShare-POC-pattern"));
  const port = Number(arg("port"));
  const sock = net.connect(port, "127.0.0.1");
  const send = (o) => sock.writable && sock.write(JSON.stringify(o) + "\n");
  let win = null;
  sock.on("error", () => app.exit(1));
  sock.on("close", () => app.exit(0));
  onLines(sock, (m) => {
    if (m.t === "quit") app.exit(0);
    else if (!win || win.isDestroyed()) return;
    else if (m.t === "focus") {
      win.moveTop();
      win.focus();
      send({ t: "pattern-event", ev: { kind: "focused", focused: win.isFocused() } });
    } else if (m.t === "gpu-status") {
      // POC ADD: the pattern process's own GPU status (requested before and after recording only)
      app
        .getGPUInfo("basic")
        .catch((e) => ({ error: e.message }))
        .then((info) =>
          send({ t: "pattern-event", ev: { kind: "gpu-status", phase: m.phase, featureStatus: app.getGPUFeatureStatus(), devices: info.gpuDevice || info } }),
        );
    } else win.webContents.send(m.t === "sig" ? "sig" : "ctl", m.t === "sig" ? m.data : m);
  });
  ipcMain.on("sig", (_, data) => send({ t: "sig", data }));
  ipcMain.on("report", (_, ev) => send({ t: "pattern-event", ev }));
  ipcMain.on("abort", () => send({ t: "abort" }));
  // Per-run random title chosen by the RECORDER process (--nonce); part of the capture-target
  // identity check. Without a valid nonce the pattern process exits and the run cannot start.
  const nonce = arg("nonce", "");
  if (!/^[0-9a-f]{16}$/.test(nonce)) {
    console.error("pattern: missing or malformed --nonce");
    app.exit(2);
    return;
  }
  const title = `CamShare POC pattern ${nonce}`;
  app.whenReady().then(() => {
    const d = screen.getPrimaryDisplay();
    win = new BrowserWindow({
      ...d.bounds,
      title,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#102030",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.setBounds(d.bounds);
    win.on("page-title-updated", (e) => e.preventDefault()); // keep the nonce title
    win.webContents.on("console-message", (_e, level, message) =>
      send({ t: "pattern-event", ev: { kind: "console", level, message } }),
    );
    win.once("ready-to-show", () => {
      win.show();
      win.moveTop();
      win.setTitle(title);
      const hwndBuf = win.getNativeWindowHandle();
      const hwnd = hwndBuf.length >= 8 ? hwndBuf.readBigUInt64LE(0).toString() : String(hwndBuf.readUInt32LE(0));
      const b = win.getBounds();
      send({
        t: "pattern-ready",
        pid: win.webContents.getOSProcessId(),
        bounds: b,
        display: { bounds: d.bounds, size: d.size, scaleFactor: d.scaleFactor },
        // Capture-target identity (window capture): media source id, native handle and title
        target: {
          mediaSourceId: win.getMediaSourceId(),
          hwnd,
          title: win.getTitle(),
          physicalSize: [Math.round(b.width * d.scaleFactor), Math.round(b.height * d.scaleFactor)],
        },
      });
    });
    win.loadFile(path.join(__dirname, "pattern.html"), { query: { mode: arg("pattern", "light") } });
    setInterval(() => send({ t: "pattern-metrics", procs: procMetrics() }), 1000);
  });
}

/* ====================================================================== */
/* Recorder role                                                          */
/* ====================================================================== */
function runRecorder() {
  const SCENARIOS = {
    smoke: { minutes: 2, timeline: [] },
    pip: { minutes: 6, timeline: [[60, "pip-churn-on"], [300, "pip-churn-off"]] },
    background: {
      minutes: 25,
      timeline: [[120, "minimize"], [720, "restore"], [840, "cover"], [1440, "uncover"]],
    },
    soak: {
      minutes: 35,
      timeline: [
        [300, "pip-churn-on"],
        [600, "pip-churn-off"],
        [900, "minimize"],
        [1500, "restore"],
        [1620, "cover"],
        [1920, "uncover"],
      ],
    },
    reconnect: {
      minutes: 4,
      timeline: [[60, "camera-drop"], [90, "camera-restore"], [150, "camera-drop"], [180, "camera-restore"]],
    },
  };
  const scenarioName = arg("scenario", "smoke");
  const sc = SCENARIOS[scenarioName];
  const minutes = Number(arg("minutes", sc ? String(sc.minutes) : "0"));
  const bgThrottle = arg("background-throttling", "false") === "true";
  const mime = arg("mime", "auto");
  const camera = arg("camera", "loopback");
  const patternMode = arg("pattern", "light");
  const scheduler = arg("scheduler", "app"); // POC-only flag: "app" (default) | "optionB"
  const usage = (msg) => {
    console.error(msg);
    app.exit(64);
  };
  if (!sc) return usage(`Unknown --scenario. Use one of: ${Object.keys(SCENARIOS).join(", ")}`);
  if (!(minutes > 0)) return usage("--minutes must be a positive number");
  if (!["auto", "h264", "vp8", "vp9"].includes(mime)) return usage("--mime must be auto, h264, vp8 or vp9");
  if (!["light", "heavy"].includes(patternMode)) return usage("--pattern must be light or heavy");
  if (!["app", "optionB"].includes(scheduler)) return usage("--scheduler must be app or optionB");
  if (camera !== "loopback")
    return usage("Only --camera=loopback is implemented. The real-phone test needs separate approval.");
  const timeline = sc.timeline.filter(([at]) => at < minutes * 60);
  // Recorder-generated per-run identity for the test window (passed to the pattern process).
  const captureNonce = crypto.randomBytes(8).toString("hex");
  const expectedTitle = `CamShare POC pattern ${captureNonce}`;

  app.setName("CamShare-POC");
  app.setPath("userData", path.join(app.getPath("appData"), "CamShare-POC"));

  const HR0 = process.hrtime.bigint();
  const clock = () => ({
    wall: Date.now(),
    mono: Math.round(Number(process.hrtime.bigint() - HR0) / 1e4) / 100,
  });
  let outDir = null;
  const pendingLines = [];
  function write(name, obj) {
    const line = JSON.stringify(obj) + "\n";
    if (!outDir) pendingLines.push([name, line]);
    else fs.appendFileSync(path.join(outDir, name), line);
  }
  const log = (kind, data = {}) => write("events.jsonl", { ...clock(), kind, ...data });

  let recWin = null,
    patSock = null,
    patChild = null,
    tp = null,
    psb = null;
  const st = {
    ready: null,
    readyAt: null,
    mrStart: null,
    mrStop: null,
    mrStartCalled: null,
    audioReady: null,
    gpu: {},
    patternGpu: {},
    target: null,
    captureGranted: false,
    patternCanvas: null,
    captureSelection: null,
    captureVerification: null,
    recStarted: null,
    result: null,
    errors: [],
    aborted: null,
    finished: false,
    patternPid: null,
    recorderPid: null,
    timers: [],
  };
  const toPattern = (o) => patSock && patSock.writable && patSock.write(JSON.stringify(o) + "\n");
  const ctl = (m) => recWin && !recWin.isDestroyed() && recWin.webContents.send("ctl", m);
  const later = (ms, fn) => st.timers.push(setTimeout(fn, ms));
  const winState = () =>
    recWin && !recWin.isDestroyed()
      ? {
          focused: recWin.isFocused(),
          minimized: recWin.isMinimized(),
          visible: recWin.isVisible(),
          bounds: recWin.getBounds(),
        }
      : null;

  /* ---------- COPIED FROM src/main.js@6c3bf48 L25-36, L45-165 (storage helpers) ---------- */
  let saveDir; // POC CHANGE: set to the run's output folder (outside the repository)
  let rec = null;
  const p2 = (n) => String(n).padStart(2, "0");
  function stamp() {
    const d = new Date();
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  }
  function uniqueName(dir, ext) {
    let n = `CamShare-${stamp()}.${ext}`,
      i = 1;
    while (fs.existsSync(path.join(dir, n)))
      n = `CamShare-${stamp()}-${i++}.${ext}`;
    return path.join(dir, n);
  }
  // MediaRecorder WebM has no Duration, so players show no length and scrubbing is poor.
  // This inserts a Duration element into Info (Segment size is "unknown" in Chrome output,
  // so growing Info does not invalidate any offsets) and streams the rest of the file through.
  async function addWebmDuration(file, output, durationMs) {
    const fd = await fs.promises.open(file, "r");
    try {
      const head = Buffer.alloc(65536);
      const { bytesRead } = await fd.read(head, 0, head.length, 0);
      const vlen = (o) => Math.clz32(head[o]) - 23; // 1..8 (0 is invalid)
      const sizeAt = (o) => {
        const n = vlen(o);
        if (n < 1 || n > 8 || o + n > bytesRead) throw new Error("Bad EBML size");
        let v = BigInt(head[o] & (0xff >> n));
        for (let k = 1; k < n; k++) v = (v << 8n) | BigInt(head[o + k]);
        return { n, v, unknown: v === (1n << BigInt(7 * n)) - 1n };
      };
      const idAt = (o) => {
        const n = vlen(o);
        if (n < 1 || n > 4) throw new Error("Bad EBML id");
        return { n, id: head.readUIntBE(o, n) };
      };
      if (idAt(0).id !== 0x1a45dfa3) throw new Error("Not a WebM file");
      const hs = sizeAt(4);
      let o = 4 + hs.n + Number(hs.v);
      const seg = idAt(o);
      if (seg.id !== 0x18538067) throw new Error("Segment not found");
      o += seg.n + sizeAt(o + seg.n).n;
      while (o < bytesRead - 16) {
        const { n: idLen, id } = idAt(o);
        const sz = sizeAt(o + idLen);
        const dataStart = o + idLen + sz.n,
          size = Number(sz.v);
        if (sz.unknown) throw new Error("Unknown-size element before Info");
        if (id === 0x1549a966) {
          const infoEnd = dataStart + size;
          if (infoEnd > bytesRead) throw new Error("Info element too large");
          const info = head.subarray(dataStart, infoEnd);
          let scale = 1000000;
          for (let p = 0; p < info.length - 3; ) { // walk Info children
            const cl = Math.clz32(info[p]) - 23;
            const cid = info.readUIntBE(p, cl);
            const sl = Math.clz32(info[p + cl]) - 23;
            let cv = BigInt(info[p + cl] & (0xff >> sl));
            for (let k = 1; k < sl; k++) cv = (cv << 8n) | BigInt(info[p + cl + k]);
            const cs = Number(cv);
            if (cid === 0x4489) throw new Error("Duration already present");
            if (cid === 0x2ad7b1) scale = Number(info.readUIntBE(p + cl + sl, cs));
            p += cl + sl + cs;
          }
          const dur = Buffer.alloc(11);
          dur.writeUIntBE(0x4489, 0, 2);
          dur[2] = 0x88;
          dur.writeDoubleBE((durationMs * 1e6) / scale, 3);
          const newSize = size + dur.length;
          let n = 1;
          while (newSize >= 2 ** (7 * n) - 1) n++;
          const sizeBuf = Buffer.alloc(n);
          let x = BigInt(newSize) | (1n << BigInt(7 * n));
          for (let k = n - 1; k >= 0; k--) { sizeBuf[k] = Number(x & 0xffn); x >>= 8n; }
          const idBuf = Buffer.alloc(4);
          idBuf.writeUInt32BE(0x1549a966);
          await pipeline(
            Readable.from(
              (async function* () {
                yield head.subarray(0, o);
                yield idBuf;
                yield sizeBuf;
                yield info;
                yield dur;
                for await (const chunk of fs.createReadStream(file, { start: infoEnd }))
                  yield chunk;
              })(),
            ),
            fs.createWriteStream(output, { flags: "wx" }),
          );
          return;
        }
        o = dataStart + size;
      }
      throw new Error("Info element not found");
    } finally {
      await fd.close();
    }
  }
  function publishFile(src, finalPath) {
    // Never overwrite: hard link when possible, otherwise copy with COPYFILE_EXCL
    // (hard links fail on exFAT/FAT32 and some network or synced folders).
    const dir = path.dirname(finalPath),
      ext = path.extname(finalPath).slice(1);
    while (true) {
      try {
        fs.linkSync(src, finalPath);
        fs.unlinkSync(src);
        return finalPath;
      } catch (e) {
        if (e.code === "EEXIST") {
          finalPath = uniqueName(dir, ext);
          continue;
        }
        try {
          fs.copyFileSync(src, finalPath, fs.constants.COPYFILE_EXCL);
          fs.unlinkSync(src);
          return finalPath;
        } catch (copyError) {
          if (copyError.code === "EEXIST") {
            finalPath = uniqueName(dir, ext);
            continue;
          }
          throw copyError;
        }
      }
    }
  }
  async function hasRoomToIndex(dir, size) {
    try {
      const st = await fs.promises.statfs(dir);
      return st.bavail * st.bsize > size * 1.1 + 64 * 1024 * 1024;
    } catch {
      return true;
    }
  }
  /* ---------- end of copied storage helpers ---------- */

  /* ---------- COPIED FROM src/main.js@6c3bf48 L296-410 (recording IPC) ---------- */
  const io = { chunks: 0, bytes: 0, writeMsMax: 0, writeMsTotal: 0 }; // POC ADD
  ipcMain.handle("rec:prepare", async () => {
    fs.mkdirSync(saveDir, { recursive: true });
    fs.accessSync(saveDir, fs.constants.W_OK);
    const st = await fs.promises.statfs(saveDir);
    const free = st.bavail * st.bsize;
    return { free, low: free < 2e9 };
  });
  ipcMain.handle("rec:start", (_, ext) => {
    if (rec) throw new Error("A recording is already active");
    if (!["webm", "mp4"].includes(ext)) throw new Error("Bad format");
    const tmp = path.join(
      saveDir,
      `.camshare-${crypto.randomBytes(6).toString("hex")}.tmp`,
    );
    const ws = fs.createWriteStream(tmp, { flags: "wx" });
    rec = { ws, tmp, final: uniqueName(saveDir, ext), err: null, startedAt: Date.now() };
    ws.on("error", (e) => {
      if (rec) rec.err = e;
    });
    log("rec:start", { tmp, final: rec.final, startedAt: rec.startedAt }); // POC ADD
    return true;
  });
  // Resolves only after the write is flushed -> renderer awaiting this = backpressure
  ipcMain.handle(
    "rec:chunk",
    (_, buf) =>
      new Promise((res, rej) => {
        if (!rec) return rej(new Error("No active recording"));
        if (rec.err) return rej(rec.err);
        const t0 = process.hrtime.bigint(); // POC ADD
        rec.ws.write(Buffer.from(buf), (e) => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6; // POC ADD
          io.chunks++; // POC ADD
          io.bytes += buf.byteLength; // POC ADD
          io.writeMsTotal += ms; // POC ADD
          if (ms > io.writeMsMax) io.writeMsMax = ms; // POC ADD
          e ? rej(e) : res(true);
        });
      }),
  );
  ipcMain.handle("rec:stop", async () => {
    if (!rec) throw new Error("No active recording");
    const r = rec;
    let error = null;
    try {
      await new Promise((res, rej) => {
        r.ws.once("error", rej);
        r.ws.end(res);
      });
    } catch (e) {
      error = e;
    }
    const dir = path.dirname(r.final);
    let seekable = path.extname(r.final) !== ".webm";
    let seekError = null;
    let indexedTmp = null;
    const durationMs = Date.now() - r.startedAt; // POC ADD: record the value written as Duration
    try {
      const size = fs.existsSync(r.tmp) ? fs.statSync(r.tmp).size : 0;
      if (!size) throw error || new Error("Empty recording");
      if (path.extname(r.final) === ".webm") {
        if (!(await hasRoomToIndex(dir, size))) {
          seekError = new Error("Not enough free disk space to add the video duration");
        } else {
          indexedTmp = path.join(
            dir,
            `.camshare-${crypto.randomBytes(6).toString("hex")}.indexed.tmp`,
          );
          try {
            await addWebmDuration(r.tmp, indexedTmp, durationMs); // POC CHANGE: same value, captured above
            seekable = true;
          } catch (indexError) {
            seekError = indexError;
            console.error("Could not add WebM duration:", indexError);
            try {
              fs.unlinkSync(indexedTmp);
            } catch (cleanupError) {
              if (cleanupError.code !== "ENOENT") throw cleanupError;
            }
            indexedTmp = null;
          }
        }
      }
      const fileToSave = indexedTmp || r.tmp;
      r.final = publishFile(fileToSave, r.final);
      if (fileToSave !== r.tmp) fs.rmSync(r.tmp, { force: true });
      rec = null;
      // POC CHANGE: lastSavedFile / Stop & Close handling removed (no app-close lifecycle in the POC)
      return {
        file: r.final,
        partial: !!(error || r.err),
        error: (error || r.err)?.message,
        seekable,
        seekError: seekError?.message,
        durationWrittenMs: durationMs, // POC ADD
      };
    } catch (e) {
      if (indexedTmp) fs.rmSync(indexedTmp, { force: true });
      // Best effort: keep the recorded data instead of leaving it to startup cleanup
      let kept = "";
      try {
        if (fs.existsSync(r.tmp) && fs.statSync(r.tmp).size > 0) {
          const rescued = path.join(
            dir,
            `CamShare-unsaved-${stamp()}${path.extname(r.final)}`,
          );
          fs.renameSync(r.tmp, rescued);
          kept = ` Recorded data was kept at ${rescued}`;
        }
      } catch {}
      rec = null;
      throw new Error(e.message + "." + kept);
    }
  });
  ipcMain.handle("rec:abort", () => {
    if (rec) {
      rec.ws.destroy();
      try {
        fs.unlinkSync(rec.tmp);
      } catch {}
      rec = null;
    }
  });
  /* ---------- end of copied recording IPC ---------- */

  ipcMain.handle("poc:config", () => ({
    scheduler, // POC-only: "app" (copied loop + captureStream(30)) | "optionB"
    mime,
    scenario: scenarioName,
    minutes,
    expectedCapture: st.target ? { surface: "window", size: st.target.physicalSize } : null,
  }));
  ipcMain.on("sig", (_, data) => toPattern({ t: "sig", data }));
  ipcMain.on("stats", (_, s) => write("renderer-stats.jsonl", { ...clock(), ...s }));
  ipcMain.on("frames", (_, batch) => {
    if (!outDir || !Array.isArray(batch) || !batch.length) return;
    fs.appendFileSync(path.join(outDir, "frames.jsonl"), batch.map((f) => JSON.stringify(f)).join("\n") + "\n");
  });
  ipcMain.on("abort", () => abortRun("recorder"));
  ipcMain.on("report", (_, ev) => onReport(ev));

  function onReport(ev) {
    const { kind, ...data } = ev;
    log("r:" + kind, data);
    if (kind === "capture-verified") {
      st.captureVerification = { ok: true, ...data };
    } else if (kind === "capture-verify-failed") {
      st.captureVerification = { ok: false, ...data };
      st.errors.push({ kind: "capture-verify-failed", ...data });
      finish("capture-verification-failed"); // before any recording starts
    } else if (kind === "screen-ready") toPattern({ t: "offer" }); // like the server's "peer up" to the phone
    else if (kind === "ready" && !st.ready) {
      // Ready gate (main process, defence in depth): recording may only start after BOTH the
      // capture-target selection and the renderer's pixel verification succeeded.
      if (!(st.captureSelection && st.captureSelection.ok === true && st.captureVerification && st.captureVerification.ok === true)) {
        st.errors.push({ kind: "ready-without-verified-capture" });
        log("ready-rejected", { selectionOk: !!(st.captureSelection && st.captureSelection.ok), verificationOk: !!(st.captureVerification && st.captureVerification.ok) });
        return finish("capture-verification-failed");
      }
      st.ready = data;
      st.readyAt = clock();
      // GPU diagnostics and typeperf start happen BEFORE recording (none during recording)
      captureGpuStatus("before").then(() => {
        if (st.finished) return;
        startTypeperf();
        later(5000, () => {
          log("cmd", { cmd: "start" });
          ctl({ t: "start" });
        });
      });
    } else if (kind === "rec-started") st.recStarted = data;
    else if (kind === "mr-start-called") st.mrStartCalled = { ...clock(), renderer: data };
    else if (kind === "audio-ready") st.audioReady = data;
    else if (kind === "mr-start") {
      st.mrStart = { ...clock(), renderer: data };
      for (const [at, action] of timeline) later(at * 1000, () => act(action));
      later(minutes * 60 * 1000, () => {
        log("cmd", { cmd: "stop" });
        ctl({ t: "stop" });
        later(180000, () => finish("stop-timeout"));
      });
    } else if (kind === "mr-stop") st.mrStop = { ...clock(), renderer: data };
    else if (kind === "rec-done") {
      st.result = data;
      // after recording only; short grace period for the pattern process's "after" reply
      captureGpuStatus("after").finally(() => setTimeout(() => finish(st.aborted ? "aborted" : "completed"), 500));
    } else if (kind === "rec-error") {
      st.errors.push(data);
      finish("rec-error");
    } else if (kind === "error" || kind === "mr-error") st.errors.push({ kind, ...data });
  }

  function act(action) {
    log("phase", { action });
    if (action === "pip-churn-on") ctl({ t: "pip-churn", on: true });
    else if (action === "pip-churn-off") ctl({ t: "pip-churn", on: false });
    else if (action === "minimize") recWin.minimize();
    else if (action === "restore") {
      recWin.restore();
      recWin.moveTop();
      recWin.focus();
    } else if (action === "cover") toPattern({ t: "focus" });
    else if (action === "uncover") {
      recWin.moveTop();
      recWin.focus();
    } else if (action === "camera-drop") {
      toPattern({ t: "drop" });
      ctl({ t: "peer", up: false });
    } else if (action === "camera-restore") toPattern({ t: "offer" });
    later(1000, () => log("window-state", { after: action, state: winState() }));
  }

  function startTypeperf() {
    try {
      const csv = path.join(outDir, "gpu.csv");
      tp = spawn(
        "typeperf",
        ["\\GPU Engine(*)\\Utilization Percentage", "-si", "1", "-sc", String(Math.ceil(minutes * 60) + 60), "-o", csv, "-f", "CSV", "-y"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const l = fs.createWriteStream(path.join(outDir, "typeperf.log"));
      tp.stdout.pipe(l);
      tp.stderr.pipe(l);
      tp.on("error", (e) => log("typeperf-error", { message: e.message }));
      tp.on("exit", (code) => log("typeperf-exit", { code }));
      log("typeperf-start", { pid: tp.pid });
    } catch (e) {
      log("typeperf-error", { message: e.message });
    }
  }

  // GPU diagnostics: run ONLY before recording starts and after it has stopped. Run
  // 20261117-022724-smoke had a 2.66 s render stall 0.6 s after a getGPUInfo() query made
  // during recording (likely cause, not proven), so no GPU query happens while recording.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms`)), ms))]);
  async function captureGpuStatus(phase) {
    const t0 = Date.now();
    const featureStatus = app.getGPUFeatureStatus();
    let basic = null,
      complete = null;
    try {
      basic = await withTimeout(app.getGPUInfo("basic"), 10000);
    } catch (e) {
      basic = { error: e.message };
    }
    try {
      complete = await withTimeout(app.getGPUInfo("complete"), 15000);
      fs.writeFileSync(path.join(outDir, `gpu-info-${phase}.json`), JSON.stringify(complete, null, 2));
    } catch (e) {
      complete = { error: e.message };
    }
    const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && k in o).map((k) => [k, o[k]]));
    st.gpu[phase] = {
      at: clock(),
      tookMs: Date.now() - t0,
      featureStatus,
      devices: basic && basic.gpuDevice,
      complete: pick(complete, ["auxAttributes", "videoEncodeAcceleratorSupportedProfile", "videoDecodeAcceleratorSupportedProfile", "gpuDevice"]),
    };
    log("gpu-status", { phase, tookMs: st.gpu[phase].tookMs, featureStatus });
    toPattern({ t: "gpu-status", phase });
  }

  function abortRun(from) {
    if (st.aborted) return;
    st.aborted = from;
    log("abort", { from });
    if (st.mrStart && !st.mrStop) ctl({ t: "stop" }); // graceful: keep the recorded data
    else finish("aborted");
  }

  function finish(reason) {
    if (st.finished) return;
    st.finished = true;
    st.timers.forEach(clearTimeout);
    log("finish", { reason });
    try {
      globalShortcut.unregisterAll();
    } catch {}
    if (tp && tp.exitCode === null) tp.kill();
    if (psb !== null) powerSaveBlocker.stop(psb);
    const summary = {
      reason,
      scenario: scenarioName,
      minutes,
      timeline,
      backgroundThrottling: bgThrottle,
      mimeArg: mime,
      camera,
      outDir,
      recorderPid: st.recorderPid,
      patternPid: st.patternPid,
      ready: st.ready,
      readyAt: st.readyAt,
      recStarted: st.recStarted,
      patternMode,
      scheduler,
      mrStartCalled: st.mrStartCalled,
      audioReady: st.audioReady,
      mrStart: st.mrStart,
      mrStop: st.mrStop,
      captureMode: "window",
      captureTarget: st.target,
      captureSelection: st.captureSelection,
      captureVerification: st.captureVerification,
      patternCanvas: st.patternCanvas,
      gpu: st.gpu,
      patternGpu: st.patternGpu,
      result: st.result,
      errors: st.errors,
      aborted: st.aborted,
      io,
    };
    if (outDir) fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    toPattern({ t: "quit" });
    setTimeout(() => {
      if (patChild && patChild.exitCode === null) patChild.kill();
      app.exit(reason === "completed" ? 0 : 1);
    }, 1500);
  }

  /*
   * POC CHANGE (capture source): WINDOW CAPTURE of the synthetic test window only.
   * The app shows a thumbnail picker of screens and adds audio:"loopback" on Windows. After both
   * full-display smoke runs captured a foreign app window, the POC captures exactly one window:
   * the pattern window. The target is identified by three independent facts reported by the
   * pattern process itself, and ALL must match a single desktopCapturer source:
   *   1. source type is "window" (only window sources are ever listed)
   *   2. the HWND in source.id ("window:<HWND>:<n>") === the pattern window's native handle
   *      (BrowserWindow.getNativeWindowHandle()), which must also equal the HWND inside
   *      BrowserWindow.getMediaSourceId()
   *   3. source.name === the per-run random title "CamShare POC pattern <16 hex nonce>"
   * Note (measured offline on Electron 33.4.11, cross-process): getMediaSourceId() returns
   * "window:<HWND>:1" while desktopCapturer lists the same window as "window:<HWND>:0", so the
   * full id strings never match; the HWND component is the stable identity.
   * No screen source is ever requested. Any mismatch denies the request and ends the run before
   * recording. alwaysOnTop, focus and window position are NOT used as safeguards.
   * The renderer then verifies the captured PIXELS before reporting ready (see recorder.js).
   */
  // Offline review hardening (2026-11-17): the decision is a pure, unit-tested function
  // (capture-target.js); the expected title comes from the RECORDER (nonce passed to the pattern
  // process), not from the pattern process; at most ONE grant per run; and the legacy
  // getUserMedia({chromeMediaSource:'desktop'}) path is blocked by denying 'media' permission.
  function installDisplayMediaHandler() {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, cb) => {
      const reject = (reason, extra = {}) => {
        st.captureSelection = { ok: false, reason, ...extra };
        st.errors.push({ kind: "capture-target-rejected", reason, ...extra });
        log("capture-target-rejected", { reason, ...extra });
        try {
          cb(null);
        } catch (e) {
          log("capture-deny-error", { message: e.message });
        }
        finish("capture-target-not-verified");
      };
      try {
        if (st.captureGranted) return reject("a capture was already granted in this run; further requests are denied");
        const sources = await desktopCapturer.getSources({
          types: ["window"], // never "screen"
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        // Only the matching source is inspected or logged; other windows' names are never recorded.
        const d = decideCaptureSource({ sources, target: st.target, expectedTitle });
        if (d.ok !== true) return reject(d.reason, d.details);
        const src = d.src;
        st.captureGranted = true;
        st.captureSelection = {
          ok: true,
          sourceId: src.id,
          patternMediaSourceId: st.target.mediaSourceId,
          hwnd: st.target.hwnd,
          title: src.name,
          windowSourcesListed: sources.length,
          audioRequested: request.audioRequested,
          videoRequested: request.videoRequested,
        };
        log("capture-target-verified", st.captureSelection);
        cb({ video: src }); // the ONLY grant path; no audio: the user's system audio is never captured
      } catch (e) {
        reject("exception while selecting the capture target", { message: e.message });
      }
    });
    // The POC never uses getUserMedia (no camera, no microphone; the camera arrives over WebRTC).
    // Measured offline (selftest/deny-request.js, Electron 33.4.11): getDisplayMedia itself raises
    // a 'media' permission request with EMPTY mediaTypes before the display-media handler runs, so
    // a blanket 'media' denial blocks window capture too. Rule: allow 'media' only with empty
    // mediaTypes (the display-capture path, which the handler above then decides); deny any
    // 'media' request naming devices ('video'/'audio' = getUserMedia). Whether Electron reports
    // getUserMedia({chromeMediaSource:'desktop'}) with non-empty mediaTypes is NOT verified (testing
    // it would require attempting a desktop capture); that path has no call site in the POC.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const types = (details && details.mediaTypes) || [];
      if (permission === "media") {
        const allow = types.length === 0;
        log("permission-media", { mediaTypes: types, allowed: allow });
        return callback(allow);
      }
      callback(true);
    });
  }

  function createRecorderWindow() {
    const d = screen.getPrimaryDisplay();
    recWin = new BrowserWindow({
      x: d.bounds.x + 32,
      y: d.bounds.y + 120,
      width: 880,
      height: 540,
      title: "CamShare POC recorder",
      alwaysOnTop: true,
      show: false,
      backgroundColor: "#14161a",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, // as in src/main.js
        nodeIntegration: false, // as in src/main.js
        backgroundThrottling: bgThrottle, // app uses false; --background-throttling=true is the control run
        autoplayPolicy: "no-user-gesture-required", // POC ADD: recording starts without a click
      },
    });
    for (const ev of ["minimize", "restore", "maximize", "unmaximize", "show", "hide", "focus", "blur"])
      recWin.on(ev, () => log("window", { ev }));
    recWin.webContents.on("console-message", (_e, level, message) => log("console", { level, message }));
    recWin.webContents.on("render-process-gone", (_e, details) => {
      log("renderer-gone", details);
      st.errors.push({ kind: "renderer-gone", ...details });
      finish("renderer-gone");
    });
    recWin.once("ready-to-show", () => {
      recWin.show();
      recWin.moveTop();
      recWin.focus();
      st.recorderPid = recWin.webContents.getOSProcessId();
      log("recorder-shown", { pid: st.recorderPid, state: winState() });
    });
    recWin.loadFile(path.join(__dirname, "recorder.html"));
    later(90000, () => {
      if (!st.ready) {
        st.errors.push({ kind: "not-ready", message: "screen or camera not ready within 90 s" });
        finish("not-ready");
      }
    });
  }

  let prevCpus = os.cpus();
  function sysCpuPct() {
    const cur = os.cpus();
    let idle = 0,
      total = 0;
    cur.forEach((c, i) => {
      const p = prevCpus[i] ? prevCpus[i].times : c.times,
        n = c.times;
      const t = n.user - p.user + (n.nice - p.nice) + (n.sys - p.sys) + (n.irq - p.irq) + (n.idle - p.idle);
      total += t;
      idle += n.idle - p.idle;
    });
    prevCpus = cur;
    return total ? Math.round((1 - idle / total) * 1000) / 10 : null;
  }

  app.whenReady().then(async () => {
    const base = path.join(app.getPath("videos"), "CamShare-POC");
    const rel = path.relative(REPO, base);
    if (!(rel.startsWith("..") || path.isAbsolute(rel))) {
      console.error(`Refusing to write POC output inside the repository: ${base}`);
      app.exit(65);
      return;
    }
    const now = new Date();
    const runId = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}-${scenarioName}${bgThrottle ? "-bgthrottle" : ""}${patternMode === "heavy" ? "-heavy" : ""}${scheduler === "optionB" ? "-optionB" : ""}`;
    outDir = path.join(base, runId);
    fs.mkdirSync(outDir, { recursive: true });
    saveDir = outDir;
    for (const [name, line] of pendingLines) fs.appendFileSync(path.join(outDir, name), line);
    pendingLines.length = 0;

    const sourceCheck = {};
    for (const [f, h] of Object.entries(SOURCE.sha256)) {
      try {
        const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO, f))).digest("hex");
        sourceCheck[f] = { expected: h, actual, match: actual === h };
      } catch (e) {
        sourceCheck[f] = { error: e.message };
      }
    }
    const d = screen.getPrimaryDisplay();
    const run = {
      runId,
      scenario: scenarioName,
      minutes,
      timeline,
      backgroundThrottling: bgThrottle,
      mime,
      camera,
      patternMode,
      scheduler,
      expectedCaptureTitle: expectedTitle,
      disableFeatures: DISABLE_FEATURES,
      versions: process.versions,
      platform: process.platform,
      osRelease: os.release(),
      cpuModel: os.cpus()[0] && os.cpus()[0].model,
      logicalCpus: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1048576),
      primaryDisplay: {
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        displayFrequency: d.displayFrequency,
        physical: [Math.round(d.size.width * d.scaleFactor), Math.round(d.size.height * d.scaleFactor)],
      },
      displayCount: screen.getAllDisplays().length,
      source: SOURCE,
      sourceCheck,
      gpuFeatureStatus: app.getGPUFeatureStatus(),
      argv: process.argv,
      outDir,
    };
    try {
      run.gpuInfo = await app.getGPUInfo("basic");
    } catch (e) {
      run.gpuInfo = { error: e.message };
    }
    fs.writeFileSync(path.join(outDir, "run.json"), JSON.stringify(run, null, 2));
    log("run-start", { runId, outDir, sourceDrift: Object.values(sourceCheck).some((c) => !c.match) });
    if (run.displayCount > 1) log("warning", { message: "More than one display: only the primary display is covered and captured" });

    psb = powerSaveBlocker.start("prevent-display-sleep"); // POC ADD: keep the display awake for the run
    globalShortcut.register("CommandOrControl+Shift+Q", () => abortRun("hotkey"));
    globalShortcut.register("CommandOrControl+Shift+M", () => log("manual-mark", { state: winState() }));
    installDisplayMediaHandler();

    setInterval(
      () =>
        write("metrics.jsonl", {
          ...clock(),
          sysCpuPct: sysCpuPct(),
          freeMemMB: Math.round(os.freemem() / 1048576),
          win: winState(),
          procs: procMetrics(),
          io: { ...io },
        }),
      1000,
    );

    const srv = net.createServer((s) => {
      patSock = s;
      onLines(s, (m) => {
        if (m.t === "pattern-ready") {
          st.patternPid = m.pid;
          st.target = m.target || null;
          log("pattern-ready", m);
          if (!recWin) createRecorderWindow();
        } else if (m.t === "sig") {
          if (recWin && !recWin.isDestroyed()) recWin.webContents.send("sig", m.data);
        } else if (m.t === "pattern-event") {
          log("pattern-event", m.ev);
          if (m.ev && m.ev.kind === "gpu-status") st.patternGpu[m.ev.phase || "unknown"] = m.ev;
          if (m.ev && m.ev.kind === "pattern-loaded") st.patternCanvas = m.ev.canvas;
        }
        else if (m.t === "pattern-metrics") write("pattern-metrics.jsonl", { ...clock(), procs: m.procs });
        else if (m.t === "abort") abortRun("pattern-esc");
      });
      s.on("close", () => log("pattern-disconnected"));
      s.on("error", (e) => log("pattern-socket-error", { message: e.message }));
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      patChild = spawn(process.execPath, [path.join(__dirname, "main.js"), "--role=pattern", `--port=${port}`, `--pattern=${patternMode}`, `--nonce=${captureNonce}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const plog = fs.createWriteStream(path.join(outDir, "pattern-process.log"));
      patChild.stdout.pipe(plog);
      patChild.stderr.pipe(plog);
      patChild.on("exit", (code) => {
        log("pattern-exit", { code });
        if (!st.finished) {
          st.errors.push({ kind: "pattern-exit", code });
          abortRun("pattern-exit");
        }
      });
      log("pattern-spawned", { pid: patChild.pid, port });
    });
    later(60000, () => {
      if (!recWin) {
        st.errors.push({ kind: "pattern-timeout", message: "pattern window not ready within 60 s" });
        finish("pattern-timeout");
      }
    });
  });
}
