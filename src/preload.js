const { contextBridge, ipcRenderer: ipc } = require("electron");
contextBridge.exposeInMainWorld("api", {
  config: () => ipc.invoke("cfg:get"),
  chooseDir: () => ipc.invoke("dir:choose"),
  prepare: () => ipc.invoke("rec:prepare"),
  start: (ext) => ipc.invoke("rec:start", ext),
  chunk: (buf) => ipc.invoke("rec:chunk", buf),
  stop: (durationMs) => ipc.invoke("rec:stop", durationMs),
  abort: () => ipc.invoke("rec:abort"),
  showFile: (f) => ipc.invoke("file:show", f),
  fileUrl: (f) => ipc.invoke("file:url", f),
  qr: (url) => ipc.invoke("qr", url),
  selectScreen: (id) => ipc.invoke("screen:select", id),
  cancelScreen: () => ipc.invoke("screen:cancel"),
  onScreenSources: (cb) =>
    ipc.on("screen:sources", (_, sources) => cb(sources)),
  onStopRequest: (cb) => ipc.on("stop-request", () => cb()),
});
