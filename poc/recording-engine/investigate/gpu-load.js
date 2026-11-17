"use strict";
// Synthetic GPU-load process for the offline contention experiments (separate Electron process, so
// its GPU work is attributable to its own PIDs). Draws a busy canvas every frame. Nothing is
// captured or recorded.
//   electron poc/recording-engine/investigate/gpu-load.js [--level=1..4]
// level 1 = 1280x720 window, 400 rects (followup2); higher levels = larger window, more rects,
// blur shadows (calibrated by calibrate-load.js).
const { app, BrowserWindow, screen } = require("electron");
const path = require("path");
const levelArg = process.argv.find((a) => a.startsWith("--level="));
const level = Math.max(1, Math.min(8, Number(levelArg ? levelArg.slice(8) : 1) || 1));
app.setPath("userData", path.join(app.getPath("temp"), "camshare-poc-gpu-load"));
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => {
  const d = screen.getPrimaryDisplay();
  const big = level >= 2; // levels 2+ use a near-full-display window
  const win = new BrowserWindow({
    x: d.bounds.x + 380,
    y: d.bounds.y + 0,
    width: big ? d.bounds.width - 380 : Math.min(1280, d.bounds.width - 380),
    height: big ? d.bounds.height : Math.min(720, d.bounds.height),
    title: "CamShare POC synthetic GPU load (not captured)",
    frame: false,
    show: true,
    backgroundColor: "#102030",
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, "gpu-load.html"), { query: { level: String(level) } });
});
