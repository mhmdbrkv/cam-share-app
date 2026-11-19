"use strict";
/*
 * CamShare POC: run the UNMODIFIED production app (src/main.js, src/preload.js, src/index.html,
 * src/renderer.js) for privacy-preserving visual checks with the real phone camera.
 *   npx electron poc/recording-engine/app-harness.js
 *
 * Exactly two production behaviours are overridden, after src/main.js has set them up:
 *   1. The display-media request is answered with WINDOW CAPTURE of the verified synthetic test
 *      window (capture-target.js identity checks), never a screen, and without system audio.
 *      Production shows a picker of screens and adds Windows loopback audio instead.
 *   2. getUserMedia device requests (microphone) are denied; display-capture is allowed.
 * Plus: the app window is kept above the full-display synthetic window (alwaysOnTop), and the
 * visible status texts (#st, #cam) and window state are logged once per second.
 * Recordings are saved by production code to Videos\CamShare; harness logs go to
 * Videos\CamShare-POC\<timestamp>-app-harness\ (outside the repository).
 */
const { app, BrowserWindow, session, desktopCapturer } = require("electron");
const path = require("path"),
  fs = require("fs"),
  net = require("net"),
  crypto = require("crypto"),
  { spawn } = require("child_process");
const { decideCaptureSource } = require("./capture-target");

const REPO = path.resolve(__dirname, "..", "..");
const nonce = crypto.randomBytes(8).toString("hex");
const expectedTitle = `CamShare POC pattern ${nonce}`;
let target = null,
  outDir = null,
  patChild = null,
  appWin = null;
const pending = [];
const log = (kind, data = {}) => {
  const line = JSON.stringify({ wall: Date.now(), kind, ...data }) + "\n";
  if (outDir) fs.appendFileSync(path.join(outDir, "events.jsonl"), line);
  else pending.push(line);
};

// ---- the production main process, unmodified ----
require(path.join(REPO, "src", "main.js"));

app.whenReady().then(() => {
  const p2 = (n) => String(n).padStart(2, "0");
  const d = new Date();
  outDir = path.join(app.getPath("videos"), "CamShare-POC", `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-app-harness`);
  fs.mkdirSync(outDir, { recursive: true });
  pending.forEach((l) => fs.appendFileSync(path.join(outDir, "events.jsonl"), l));
  const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO, f))).digest("hex");
  fs.writeFileSync(
    path.join(outDir, "run.json"),
    JSON.stringify({ purpose: "production app with verified window capture of a synthetic window", electron: process.versions.electron, productionFiles: Object.fromEntries(["src/main.js", "src/renderer.js", "src/preload.js", "src/index.html"].map((f) => [f, hash(f)])) }, null, 2),
  );

  // Override 1: window capture of the verified synthetic window only (replaces production's handler).
  let grants = 0;
  session.defaultSession.setDisplayMediaRequestHandler(async (request, cb) => {
    for (let i = 0; i < 100 && !target; i++) await new Promise((r) => setTimeout(r, 100)); // wait for the test window
    try {
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      const dec = decideCaptureSource({ sources, target, expectedTitle });
      if (dec.ok !== true) {
        log("capture-denied", { reason: dec.reason, details: dec.details });
        return cb(null);
      }
      grants++;
      log("capture-granted", { sourceId: dec.src.id, hwnd: target.hwnd, title: dec.src.name, grants, audioRequested: request.audioRequested });
      cb({ video: dec.src }); // no audio: system audio is never captured
    } catch (e) {
      log("capture-denied", { reason: "exception", message: e.message });
      cb(null);
    }
  });
  // Override 2: deny microphone/camera device requests; allow the display-capture path.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const types = (details && details.mediaTypes) || [];
    if (permission === "media" && types.length) {
      log("permission-denied", { permission, mediaTypes: types });
      return callback(false);
    }
    callback(true);
  });

  // Synthetic full-display test window (separate process, recorder-generated nonce title).
  const srv = net.createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.t === "pattern-ready") {
          target = m.target;
          log("pattern-ready", { target });
          setTimeout(raiseAppWindow, 300);
        } else if (m.t === "abort") app.quit();
      }
    });
  });
  srv.listen(0, "127.0.0.1", () => {
    patChild = spawn(process.execPath, [path.join(__dirname, "main.js"), "--role=pattern", `--port=${srv.address().port}`, "--pattern=light", `--nonce=${nonce}`], { stdio: "ignore" });
    log("pattern-spawned", { pid: patChild.pid });
  });

  // Keep the production window above the synthetic window; log visible state once per second.
  function raiseAppWindow() {
    appWin = BrowserWindow.getAllWindows()[0] || null;
    if (!appWin || appWin.isDestroyed()) return;
    appWin.setAlwaysOnTop(true);
    appWin.moveTop();
    appWin.focus();
    for (const ev of ["minimize", "restore", "focus", "blur", "show", "hide"]) appWin.on(ev, () => log("window", { ev }));
  }
  setInterval(async () => {
    if (!appWin || appWin.isDestroyed()) return;
    let ui = null;
    try {
      ui = await appWin.webContents.executeJavaScript(
        `({ st: document.getElementById("st").textContent, cam: document.getElementById("cam").textContent, hidden: document.hidden })`,
      );
    } catch (e) {
      ui = { error: e.message };
    }
    log("ui", { minimized: appWin.isMinimized(), ...ui });
  }, 1000);
});

app.on("will-quit", () => {
  if (patChild && patChild.exitCode === null) patChild.kill();
});
