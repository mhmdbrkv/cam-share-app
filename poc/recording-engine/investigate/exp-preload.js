"use strict";
// Preload for the offline FPS / A-V experiments (synthetic canvas + synthetic audio only).
const { contextBridge, ipcRenderer: ipc } = require("electron");
contextBridge.exposeInMainWorld("xp", {
  plan: () => ipc.invoke("xp:plan"),
  begin: (name) => ipc.invoke("xp:begin", name),
  chunk: (buf) => ipc.invoke("xp:chunk", buf),
  end: (meta) => ipc.invoke("xp:end", meta),
  done: (info) => ipc.send("xp:done", info),
  log: (o) => ipc.send("xp:log", o),
});
