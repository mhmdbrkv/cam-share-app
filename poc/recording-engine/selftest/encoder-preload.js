"use strict";
// Preload for the offline encoder self-test (synthetic canvas only).
const { contextBridge, ipcRenderer: ipc } = require("electron");
contextBridge.exposeInMainWorld("st", {
  variants: () => ipc.invoke("st:variants"),
  begin: (name) => ipc.invoke("st:begin", name),
  chunk: (buf) => ipc.invoke("st:chunk", buf),
  end: (meta) => ipc.invoke("st:end", meta),
  done: (info) => ipc.send("st:done", info),
  log: (o) => ipc.send("st:log", o),
});
