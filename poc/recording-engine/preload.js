"use strict";
// CamShare Recording Engine POC: narrow preload bridge for both POC windows.
// Modelled on src/preload.js@6c3bf48 (contextBridge, invoke-only recording API).
const { contextBridge, ipcRenderer: ipc } = require("electron");
contextBridge.exposeInMainWorld("poc", {
  config: () => ipc.invoke("poc:config"),
  // Same channel names and shapes as src/preload.js@6c3bf48
  prepare: () => ipc.invoke("rec:prepare"),
  start: (ext) => ipc.invoke("rec:start", ext),
  chunk: (buf) => ipc.invoke("rec:chunk", buf),
  stop: () => ipc.invoke("rec:stop"),
  abort: () => ipc.invoke("rec:abort"),
  // POC-only: loopback signaling, control and measurement channels
  sig: (data) => ipc.send("sig", data),
  onSig: (cb) => ipc.on("sig", (_, d) => cb(d)),
  onCtl: (cb) => ipc.on("ctl", (_, m) => cb(m)),
  report: (kind, data) => ipc.send("report", { kind, ...(data || {}) }),
  stats: (s) => ipc.send("stats", s),
  frames: (batch) => ipc.send("frames", batch),
  abortRun: () => ipc.send("abort"),
});
