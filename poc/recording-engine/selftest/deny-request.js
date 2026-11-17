"use strict";
// Denial-only check (no capture possible): the display-media handler below has NO grant path.
//   npx electron poc/recording-engine/selftest/deny-request.js
// Verifies: (1) a request answered with cb(null) rejects in the page and yields zero tracks;
// (2) which permission requests getDisplayMedia triggers, so denying 'media' (main.js) is known
//     not to interfere with the display-capture path.
const { app, BrowserWindow, session } = require("electron");
const path = require("path"), fs = require("fs");
const OUT = process.env.DENY_OUT;
const note = (o) => OUT && fs.appendFileSync(OUT, JSON.stringify(o) + "\n");
app.setPath("userData", path.join(app.getPath("temp"), "camshare-poc-selftest-deny"));
app.whenReady().then(async () => {
  const seen = { handlerCalls: 0, permissionRequests: [], permissionChecks: [] };
  session.defaultSession.setDisplayMediaRequestHandler((request, cb) => {
    seen.handlerCalls++;
    note({ step: "handler-called" });
    seen.handlerRequest = { videoRequested: request.videoRequested, audioRequested: request.audioRequested };
    try { cb(null); note({ step: "cb(null) returned" }); } catch (e) { note({ step: "cb(null) threw", message: e.message }); } // the ONLY thing this handler can do
  });
  // Same rule as main.js: allow 'media' only with empty mediaTypes (display capture path).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const types = (details && details.mediaTypes) || [];
    const allow = permission !== "media" || types.length === 0;
    seen.permissionRequests.push({ permission, mediaTypes: types, allowed: allow });
    callback(allow);
  });
  const win = new BrowserWindow({ width: 200, height: 100, x: 0, y: 0, show: true, frame: false, backgroundColor: "#102030" });
  note({ step: "window" });
  setTimeout(() => {
    note({ step: "hard-timeout", seen });
    app.exit(3);
  }, 20000);
  await win.loadFile(path.join(__dirname, "deny-page.html")); // file:// like the POC pages
  note({ step: "loaded", hasMediaDevices: await win.webContents.executeJavaScript("!!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)"), secure: await win.webContents.executeJavaScript("window.isSecureContext") });
  const result = await win.webContents.executeJavaScript(
    `Promise.race([navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
       .then((s) => { const n = s.getTracks().length; s.getTracks().forEach((t) => t.stop()); return { resolved: true, tracks: n }; })
       .catch((e) => ({ resolved: false, name: e.name, message: e.message })), new Promise((r) => setTimeout(() => r({ resolved: false, pending: true, note: "still pending after 8 s" }), 8000))])`,
    true,
  );
  note({ step: "done" });
  const line = JSON.stringify({ electron: process.versions.electron, result, ...seen, permissionChecks: [...new Set(seen.permissionChecks)] });
  note({ final: JSON.parse(line) });
  console.log(line);
  app.exit(result.resolved ? 1 : 0);
});
