const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  desktopCapturer,
  session,
  Menu,
} = require("electron");
const path = require("path"),
  fs = require("fs"),
  crypto = require("crypto"),
  { pathToFileURL } = require("url"),
  { finalizeWebm } = require("./webm-index"),
  QR = require("qrcode");
let win,
  rec = null,
  closing = false,
  saveDir,
  lastSavedFile = null,
  pendingCapture = null,
  captureSources = new Map();
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
      .filter((f) => /^\.camshare-[0-9a-f]+(?:\.indexed)?\.tmp$/.test(f))
      .forEach((f) => fs.unlinkSync(path.join(dir, f)));
  } catch {}
}
// WebM finalization (Duration, SeekHead, Cues, known sizes): see webm-index.js.
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
app.commandLine.appendSwitch(
  "disable-features",
  "CalculateNativeWinOcclusion",
);
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    // No menu bar (decision 2026-11-19). Electron's default File/Edit/View/Window/Help menu also
    // brought shortcuts such as Ctrl+R (reload, which would lose a recording in progress).
    Menu.setApplicationMenu(null);
    saveDir = path.join(app.getPath("videos"), "CamShare");
    cleanStale(saveDir);
    session.defaultSession.setDisplayMediaRequestHandler(async (request, cb) => {
      if (pendingCapture) {
        cb(null);
        return;
      }
      pendingCapture = cb;
      captureSources.clear();
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 320, height: 200 },
        });
        if (pendingCapture !== cb) return;
        if (!sources.length) {
          pendingCapture = null;
          cb(null);
          return;
        }
        captureSources = new Map(sources.map((source) => [source.id, source]));
        win.webContents.send(
          "screen:sources",
          sources.map((source) => ({
            id: source.id,
            name: source.name,
            thumbnail: source.thumbnail.toDataURL(),
          })),
        );
      } catch (error) {
        if (pendingCapture === cb) {
          pendingCapture = null;
          captureSources.clear();
          cb(null);
        }
        console.error("Could not enumerate screens:", error);
      }
    });
    win = new BrowserWindow({
      width: 1200,
      height: 820,
      title: "CamShare",
      icon: path.join(__dirname, "assets", "icon.png"),
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.loadFile(path.join(__dirname, "index.html"));
    // Development only (npm start, never the installed build): keep Ctrl+Shift+I for DevTools,
    // which the removed menu used to provide.
    if (!app.isPackaged)
      win.webContents.on("before-input-event", (_event, input) => {
        if (
          input.type === "keyDown" &&
          input.control &&
          input.shift &&
          input.key.toLowerCase() === "i"
        )
          win.webContents.toggleDevTools();
      });
    win.on("close", async (e) => {
      if (!rec) {
        if (pendingCapture) pendingCapture(null);
        pendingCapture = null;
        captureSources.clear();
        return;
      }
      e.preventDefault();
      if (closing) return;
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
}
app.on("window-all-closed", () => app.quit());

ipcMain.handle("cfg:get", () => ({
  dir: saveDir,
  serverUrl: process.env.SERVER_URL || "https://cam-share-app.onrender.com",
}));
ipcMain.handle("screen:select", (_, id) => {
  const source = captureSources.get(id);
  if (!pendingCapture || !source)
    throw new Error("Screen selection is no longer available");
  const cb = pendingCapture;
  pendingCapture = null;
  captureSources.clear();
  cb({ video: source }); // V1: video only; system audio (loopback) is never granted
});
ipcMain.handle("screen:cancel", () => {
  if (pendingCapture) pendingCapture(null);
  pendingCapture = null;
  captureSources.clear();
});
ipcMain.handle("dir:choose", async () => {
  if (rec) return saveDir; // temp file and final name live in the folder chosen at start
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
  rec = { ws, tmp, final: uniqueName(saveDir, ext), err: null, startedAt: Date.now() };
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
  const dir = path.dirname(r.final);
  let seekable = path.extname(r.final) !== ".webm";
  let seekError = null;
  let indexedTmp = null;
  try {
    const size = fs.existsSync(r.tmp) ? fs.statSync(r.tmp).size : 0;
    if (!size) throw error || new Error("Empty recording");
    if (path.extname(r.final) === ".webm") {
      if (!(await hasRoomToIndex(dir, size))) {
        seekError = new Error("Not enough free disk space to add the video index");
      } else {
        indexedTmp = path.join(
          dir,
          `.camshare-${crypto.randomBytes(6).toString("hex")}.indexed.tmp`,
        );
        try {
          await finalizeWebm(r.tmp, indexedTmp, Date.now() - r.startedAt);
          seekable = true;
        } catch (indexError) {
          seekError = indexError;
          console.error("Could not index WebM recording:", indexError);
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
    lastSavedFile = r.final;
    if (closing) setImmediate(() => win.close());
    return {
      file: r.final,
      partial: !!(error || r.err),
      error: (error || r.err)?.message,
      seekable,
      seekError: seekError?.message,
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
    closing = false;
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
    closing = false;
  }
});
ipcMain.handle("file:show", (_, f) => {
  if (
    typeof f === "string" &&
    lastSavedFile &&
    path.resolve(f) === path.resolve(lastSavedFile)
  )
    shell.showItemInFolder(lastSavedFile);
});
ipcMain.handle("file:url", (_, f) => {
  if (
    typeof f !== "string" ||
    !lastSavedFile ||
    path.resolve(f) !== path.resolve(lastSavedFile)
  )
    throw new Error("File is not the latest CamShare recording");
  return pathToFileURL(lastSavedFile).href;
});
ipcMain.handle("qr", (_, url) =>
  QR.toDataURL(String(url), { width: 220, margin: 1 }),
);
