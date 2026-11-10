const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  desktopCapturer,
  session,
} = require("electron");
const path = require("path"),
  fs = require("fs"),
  crypto = require("crypto"),
  QR = require("qrcode");
let win,
  rec = null,
  closing = false,
  saveDir;
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
function cleanStale(dir) {
  // only files this app owns
  try {
    fs.readdirSync(dir)
      .filter((f) => /^\.camshare-[0-9a-f]+\.tmp$/.test(f))
      .forEach((f) => fs.unlinkSync(path.join(dir, f)));
  } catch {}
}
app.whenReady().then(() => {
  saveDir = path.join(app.getPath("videos"), "CamShare");
  cleanStale(saveDir);
  session.defaultSession.setDisplayMediaRequestHandler(async (_, cb) => {
    const s = await desktopCapturer.getSources({ types: ["screen"] });
    cb({ video: s[0] });
  });
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: "CamShare",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.on("close", async (e) => {
    if (!rec || closing) return;
    e.preventDefault();
    const r = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Stop & Close"],
      defaultId: 0,
      cancelId: 0,
      message: "A recording is in progress.",
      detail: "Stop & Close will save the recording first.",
    });
    if (r.response === 1) {
      closing = true;
      win.webContents.send("stop-request");
    }
  });
});
app.on("window-all-closed", () => app.quit());

ipcMain.handle("cfg:get", () => ({ dir: saveDir }));
ipcMain.handle("dir:choose", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: saveDir,
  });
  if (!r.canceled) saveDir = r.filePaths[0];
  return saveDir;
});
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
  rec = { ws, tmp, final: uniqueName(saveDir, ext), err: null };
  ws.on("error", (e) => {
    if (rec) rec.err = e;
  });
  return true;
});
// Resolves only after the write is flushed -> renderer awaiting this = backpressure
ipcMain.handle(
  "rec:chunk",
  (_, buf) =>
    new Promise((res, rej) => {
      if (!rec) return rej(new Error("No active recording"));
      if (rec.err) return rej(rec.err);
      rec.ws.write(Buffer.from(buf), (e) => (e ? rej(e) : res(true)));
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
  try {
    const size = fs.existsSync(r.tmp) ? fs.statSync(r.tmp).size : 0;
    if (!size) throw error || new Error("Empty recording");
    fs.renameSync(r.tmp, r.final); // same directory -> no cross-volume rename
    rec = null;
    if (closing) setImmediate(() => win.close());
    return {
      file: r.final,
      partial: !!(error || r.err),
      error: (error || r.err)?.message,
    };
  } catch (e) {
    rec = null;
    closing = false;
    throw e;
  }
});
ipcMain.handle("rec:abort", () => {
  if (rec) {
    rec.ws.destroy();
    try {
      fs.unlinkSync(rec.tmp);
    } catch {}
    rec = null;
    closing = false;
  }
});
ipcMain.handle("file:show", (_, f) => {
  if (typeof f === "string" && f.startsWith(saveDir)) shell.showItemInFolder(f);
});
ipcMain.handle("qr", (_, url) =>
  QR.toDataURL(String(url), { width: 220, margin: 1 }),
);
