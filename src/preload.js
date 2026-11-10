const { contextBridge, ipcRenderer: ipc } = require("electron");
contextBridge.exposeInMainWorld("api", {
  config: () => ipc.invoke("cfg:get"),
  chooseDir: () => ipc.invoke("dir:choose"),
  prepare: () => ipc.invoke("rec:prepare"),
  start: (ext) => ipc.invoke("rec:start", ext),
  chunk: (buf) => ipc.invoke("rec:chunk", buf),
  stop: () => ipc.invoke("rec:stop"),
  abort: () => ipc.invoke("rec:abort"),
  showFile: (f) => ipc.invoke("file:show", f),
  qr: (url) => ipc.invoke("qr", url),
  onStopRequest: (cb) => ipc.on("stop-request", cb),
});
