let SERVER_URL = "https://cam-share-app.onrender.com";
const $ = (i) => document.getElementById(i);
const S = {
  state: "idle",
  screen: null,
  pc: null,
  ws: null,
  room: crypto.randomUUID().replace(/-/g, ""),
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
  pip: { x: 0.72, y: 0.66, w: 0.25 },
  q: Promise.resolve(),
  pendingIce: [],
  negotiationId: null,
  file: null,
};
const sv = document.createElement("video"),
  cv = document.createElement("video"); // hidden sources
sv.muted = cv.muted = true;
cv.playsInline = true;
const canvas = $("cv"),
  ctx = canvas.getContext("2d");
let screenSelection = null;
let stopReason = "";
let stopRequested = false;
let recordMode = "cam";
let audioContext = null;
let audioSources = [];

const hasScreen = () =>
  !!S.screen &&
  S.screen.getVideoTracks().some((track) => track.readyState === "live");

function updateScreenButton() {
  $("screenBtn").disabled =
    !!screenSelection ||
    ["preparing", "recording", "finalizing"].includes(S.state);
}

/* ---------- state machine ---------- */
function setState(s, msg) {
  S.state = s;
  $("st").textContent = msg || s;
  $("go").disabled =
    !["idle", "completed", "error"].includes(s) || !hasScreen();
  $("stop").disabled = s !== "recording";
  updateScreenButton();
  $("pick").disabled = ["preparing", "recording", "finalizing"].includes(s);
  $("done").style.display = s === "completed" ? "block" : "none";
}

/* ---------- screen capture + compositor (shared by preview & recording) ---------- */
async function startScreen() {
  if (
    screenSelection ||
    ["preparing", "recording", "finalizing"].includes(S.state)
  )
    return;
  const selection = {};
  screenSelection = selection;
  setState("selecting", "Select a screen to capture");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
    });
    if (screenSelection !== selection) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("No screen video track was selected");
    const previous = S.screen;
    sv.srcObject = stream;
    await sv.play();
    if (!sv.videoWidth || !sv.videoHeight)
      await new Promise((resolve) =>
        sv.addEventListener("loadedmetadata", resolve, { once: true }),
      );
    const h = Math.min(1080, sv.videoHeight),
      w = Math.round((sv.videoWidth * h) / sv.videoHeight);
    canvas.width = w & ~1;
    canvas.height = h & ~1; // never upscale, keep aspect
    S.screen = stream;
    track.onended = () => {
      if (S.screen !== stream) return;
      S.screen = null;
      if (mr && mr.state !== "inactive") {
        stopReason = "Screen capture ended";
        setState("finalizing", "Screen capture ended; saving recording…");
        mr.stop();
      } else {
        setState("error", "Screen capture ended. Select a screen to continue.");
      }
    };
    if (previous && previous !== stream)
      previous.getTracks().forEach((oldTrack) => oldTrack.stop());
    setState("idle");
  } catch (e) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (screenSelection !== selection) return;
    if (sv.srcObject === stream) {
      sv.srcObject = S.screen;
      if (S.screen) {
        try {
          await sv.play();
        } catch (resumeError) {
          console.error(
            "Could not resume the previous screen preview",
            resumeError,
          );
          const previous = S.screen;
          S.screen = null;
          previous.getTracks().forEach((track) => track.stop());
        }
      }
    }
    setState(
      S.screen ? "idle" : "error",
      e.name === "AbortError" || e.name === "NotAllowedError"
        ? "Screen selection cancelled. Select screen to retry."
        : "Screen capture failed: " + e.message,
    );
  } finally {
    if (screenSelection === selection) {
      screenSelection = null;
      updateScreenButton();
    }
  }
}

function cancelScreenSelection() {
  if (!screenSelection) return;
  screenSelection = null;
  setState(
    S.screen ? "idle" : "error",
    "Screen selection cancelled. Select screen to retry.",
  );
}
const camLive = () => {
  const t = cv.srcObject && cv.srcObject.getVideoTracks()[0];
  return !!(
    t &&
    t.readyState === "live" &&
    !t.muted &&
    cv.videoWidth > 0 &&
    S.pc &&
    S.pc.connectionState === "connected"
  );
};
function pipRect() {
  const W = canvas.width,
    H = canvas.height,
    pw = S.pip.w * W,
    ph = (pw * cv.videoHeight) / cv.videoWidth;
  return {
    x: Math.min(Math.max(0, S.pip.x * W), W - pw),
    y: Math.min(Math.max(0, S.pip.y * H), H - ph),
    w: pw,
    h: ph,
  };
}
function setPipSize(size) {
  S.pip.w = Math.min(0.5, Math.max(0.1, size));
  $("size").value = String(Math.round(S.pip.w * 100));
  $("sizeValue").textContent = `${Math.round(S.pip.w * 100)}%`;
}
function renderFrame() {
  if (!S.screen || !sv.videoWidth) return;
  ctx.drawImage(sv, 0, 0, canvas.width, canvas.height);
  const pipEnabled = mr
    ? recordMode === "cam"
    : document.querySelector("input[name=mode]:checked")?.value === "cam";
  if (pipEnabled && camLive()) {
    const r = pipRect();
    const track = cv.srcObject.getVideoTracks()[0];
    const isUserFacing = track?.getSettings()?.facingMode === "user";
    if (isUserFacing) {
      ctx.save();
      ctx.translate(2 * r.x + r.w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(cv, r.x, r.y, r.w, r.h);
    if (isUserFacing) ctx.restore();

    // Camera border
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Only draw the resize handle during preview, NOT in the final recording!
    if (!mr) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(r.x + r.w - 18, r.y + r.h - 18, 18, 18);
      ctx.strokeStyle = "#14161a";
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + r.w - 18, r.y + r.h - 18, 18, 18);
    }
  }
}

// requestAnimationFrame loop eliminates timer jitter & dropped frames when window is visible
let lastFrameTime = 0;
const frameInterval = 1000 / 30; // 30 fps cadence
function loop(now) {
  if (now - lastFrameTime >= frameInterval - 2) {
    lastFrameTime = now;
    renderFrame();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Background fallback: ensure frames continue flowing into recorder when window is minimized
setInterval(() => {
  if (document.hidden && mr) {
    renderFrame();
  }
}, frameInterval);

/* ---------- PiP controller ---------- */
let drag = null,
  resizing = false;
const toCanvas = (e) => {
  const b = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - b.left) * canvas.width) / b.width,
    y: ((e.clientY - b.top) * canvas.height) / b.height,
  };
};
canvas.onpointerdown = (e) => {
  if (!camLive()) return;
  const p = toCanvas(e),
    r = pipRect();
  if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
    resizing = p.x >= r.x + r.w - 24 && p.y >= r.y + r.h - 24;
    drag = { dx: p.x - r.x, dy: p.y - r.y, x: r.x };
    canvas.setPointerCapture(e.pointerId);
  }
};
canvas.onpointermove = (e) => {
  if (!drag) return;
  const p = toCanvas(e);
  if (resizing) {
    setPipSize((p.x - drag.x) / canvas.width);
    return;
  }
  S.pip.x = (p.x - drag.dx) / canvas.width;
  S.pip.y = (p.y - drag.dy) / canvas.height;
};
canvas.onpointerup = () => {
  drag = null;
  resizing = false;
};
canvas.onwheel = (e) => {
  setPipSize(S.pip.w - e.deltaY * 0.0005);
};
$("size").oninput = (e) => setPipSize(e.target.value / 100);
setPipSize(S.pip.w);

/* ---------- camera stream manager + signaling (phone is the offerer) ---------- */
function onSig(d) {
  S.q = S.q
    .then(async () => {
      if (d.sdp) {
        const negotiationId =
          d.negotiationId || `legacy-${Date.now()}-${Math.random()}`;
        if (S.pc) S.pc.close();
        S.pendingIce = [];
        S.negotiationId = negotiationId;
        const pc = (S.pc = new RTCPeerConnection({
          iceServers: S.iceServers,
        }));
        pc.ontrack = (e) => {
          cv.srcObject = e.streams[0];
          cv.play();
        };
        pc.onicecandidate = (e) =>
          e.candidate &&
          sendSignal({ negotiationId, ice: e.candidate });
        pc.onconnectionstatechange = () => {
          $("cam").textContent = "Phone: " + pc.connectionState;
          if (["failed", "closed"].includes(pc.connectionState))
            cv.srcObject = null;
        };
        await pc.setRemoteDescription(d.sdp);
        for (const candidate of S.pendingIce)
          await pc.addIceCandidate(candidate);
        S.pendingIce = [];
        await pc.setLocalDescription(await pc.createAnswer());
        if (S.pc === pc && S.negotiationId === negotiationId)
          sendSignal({ negotiationId, sdp: pc.localDescription });
      } else if (d.ice && S.pc) {
        if (d.negotiationId && d.negotiationId !== S.negotiationId) return;
        if (S.pc.remoteDescription) await S.pc.addIceCandidate(d.ice);
        else S.pendingIce.push(d.ice);
      }
    })
    .catch((e) => console.error(e));
}
function sendSignal(data) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN)
    S.ws.send(JSON.stringify({ t: "sig", data }));
}
async function showQr() {
  try {
    const url = `${SERVER_URL}/?s=${S.room}`;
    $("qr").src = await api.qr(url);
  } catch (err) {
    console.error("Failed to generate QR code:", err);
  }
}

function wakeServer() {
  try {
    fetch(SERVER_URL, { mode: "no-cors", cache: "no-store" }).catch(() => {});
  } catch {}
}

let sigRetryMs = 1500;
let wakeTimer = null;
async function connectSig() {
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.close();
  }

  if (!cv.srcObject) {
    $("cam").textContent = "Connecting to relay server…";
  }

  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    if (S.ws && S.ws.readyState !== WebSocket.OPEN && !cv.srcObject) {
      $("cam").textContent = "Waking up cloud server (takes ~30s on cold start)…";
    }
  }, 4000);

  const ws = (S.ws = new WebSocket(SERVER_URL.replace(/^http/, "ws")));
  ws.onopen = async () => {
    clearTimeout(wakeTimer);
    sigRetryMs = 1500;
    ws.send(JSON.stringify({ t: "join", room: S.room, role: "desktop" }));
    if (!cv.srcObject) {
      $("cam").textContent = "Phone: scan QR to connect";
    }
  };
  ws.onmessage = (m) => {
    let d;
    try {
      d = JSON.parse(m.data);
    } catch {
      return;
    }
    if (d.t === "config" && Array.isArray(d.iceServers)) {
      S.iceServers = d.iceServers;
      return;
    }
    if (d.t === "sig") onSig(d.data);
    if (d.t === "peer") {
      if (d.up) {
        $("cam").textContent = "Phone: connected";
      } else {
        $("cam").textContent = "Phone: disconnected";
        cv.srcObject = null;
      }
    }
  };
  ws.onclose = (e) => {
    if (e.code === 4001) {
      clearTimeout(wakeTimer);
      $("cam").textContent = "Another CamShare window took over this session";
      return;
    }
    setTimeout(connectSig, sigRetryMs + Math.random() * 500);
    sigRetryMs = Math.min(sigRetryMs * 2, 10000);
  };
}

/* ---------- recording controller ---------- */
let mr = null,
  mic = null,
  outStream = null;
async function startRecording() {
  setState("preparing");
  stopReason = "";
  stopRequested = false;
  try {
    const mode = document.querySelector("input[name=mode]:checked").value;
    recordMode = mode;
    if (mode === "cam" && !camLive())
      throw new Error("Phone camera is not streaming");
    const p = await api.prepare();
    if (
      p.low &&
      !confirm(`Only ${(p.free / 1e9).toFixed(1)} GB free. Continue anyway?`)
    )
      return setState("idle");
    outStream = canvas.captureStream(30);
    if ($("aud").checked) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (!confirm("Microphone unavailable. Continue without audio?")) {
          cleanupRecordingStreams();
          return setState("idle");
        }
      }
    }
    const audioInputs = [];
    const addAudioInput = (stream) => {
      if (stream && stream.getAudioTracks().length) audioInputs.push(stream);
    };
    addAudioInput(S.screen);
    // Prevent echo: if PC mic is enabled, prioritize PC mic directly and skip phone mic
    if ($("aud").checked && mic) {
      addAudioInput(mic);
    } else if (mode === "cam") {
      addAudioInput(cv.srcObject);
    }
    if (audioInputs.length) {
      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      for (const stream of audioInputs) {
        const source = audioContext.createMediaStreamSource(
          new MediaStream(stream.getAudioTracks()),
        );
        source.connect(destination);
        audioSources.push(source);
      }
      outStream.addTrack(destination.stream.getAudioTracks()[0]);
      await audioContext.resume();
    }
    // Prefer hardware accelerated codecs (H.264 / VP8) over heavy software VP9 to prevent CPU spikes and frame drops
    const mime = [
      "video/webm;codecs=h264,opus",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
    ].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("No supported recording format");
    await api.start(mime.includes("mp4") ? "mp4" : "webm");
    mr = new MediaRecorder(outStream, {
      mimeType: mime,
      videoBitsPerSecond: 8e6,
    });
    const recorder = mr;
    let chain = Promise.resolve(),
      pending = 0,
      err = null;
    const fail = (e) => {
      err = err || e;
      if (recorder.state !== "inactive") recorder.stop();
    };
    mr.ondataavailable = (e) => {
      if (!e.data.size || err) return;
      pending += e.data.size;
      if (pending > 256e6)
        return fail(new Error("Disk too slow: write backlog exceeded"));
      chain = chain
        .then(async () => {
          await api.chunk(await e.data.arrayBuffer());
          pending -= e.data.size;
        })
        .catch(fail);
    };
    mr.onstop = async () => {
      mr = null;
      setState("finalizing");
      await chain;
      cleanupRecordingStreams();
      try {
        const r = await api.stop();
        S.file = r.file;
        const partialError = err || r.error;
        const partial = r.partial || !!err;
        $("fn").textContent =
          r.file + (partial ? " (partial: " + partialError + ")" : "");
        $("pv").src = await api.fileUrl(r.file);
        $("pv").load();
        const messages = [];
        if (stopReason) messages.push(`${stopReason}; recording saved`);
        if (!r.seekable)
          messages.push(
            `Saved without seek support: ${r.seekError || "could not build video index"}`,
          );
        if (partial)
          messages.push(
            `Partial file: ${partialError || "recording was truncated"}`,
          );
        setState("completed", messages.join(" — ") || "Completed");
      } catch (e) {
        setState("error", "Save failed: " + e.message);
      }
    };
    mr.start(1000);
    setState(
      "recording",
      audioInputs.length
        ? "Recording…"
        : "Recording… (no audio source available)",
    );
    if (stopRequested && mr.state !== "inactive") mr.stop();
  } catch (e) {
    cleanupRecordingStreams();
    await api.abort();
    setState("error", e.message);
  }
}
function cleanupRecordingStreams() {
  const screenTracks = new Set(S.screen ? S.screen.getTracks() : []);
  if (outStream)
    outStream.getTracks().forEach((track) => {
      if (!screenTracks.has(track)) track.stop();
    });
  if (mic) mic.getTracks().forEach((track) => track.stop());
  audioSources.forEach((source) => source.disconnect());
  audioSources = [];
  if (audioContext && audioContext.state !== "closed")
    audioContext.close().catch((error) =>
      console.error("Could not close audio mixer:", error),
    );
  audioContext = null;
  outStream = null;
  mic = null;
}
$("go").onclick = startRecording;
$("stop").onclick = () => {
  $("stop").disabled = true;
  mr.stop();
};
api.onStopRequest(() => {
  stopRequested = true;
  if (mr && mr.state !== "inactive") mr.stop();
});
$("open").onclick = () => api.showFile(S.file);
$("again").onclick = () => {
  $("pv").pause();
  $("pv").removeAttribute("src");
  $("pv").load();
  $("fn").textContent = "";
  S.file = null;
  setState("idle");
};
$("screenBtn").onclick = startScreen;
$("pick").onclick = async () => ($("dir").textContent = await api.chooseDir());

api.onScreenSources((sources) => {
  const picker = $("screenPicker"),
    list = $("screenSources");
  list.replaceChildren();
  for (const source of sources) {
    const button = document.createElement("button"),
      image = document.createElement("img"),
      label = document.createElement("span");
    button.type = "button";
    button.className = "screenChoice";
    image.src = source.thumbnail;
    image.alt = "";
    label.textContent = source.name;
    button.append(image, label);
    button.onclick = async () => {
      try {
        await api.selectScreen(source.id);
      } catch (error) {
        console.error("Could not select screen:", error);
        try {
          await api.cancelScreen();
        } catch (cancelError) {
          console.error("Could not cancel screen selection:", cancelError);
        }
      } finally {
        picker.hidden = true;
      }
    };
    list.append(button);
  }
  picker.hidden = false;
});
$("screenCancel").onclick = async () => {
  $("screenPicker").hidden = true;
  try {
    await api.cancelScreen();
  } catch (error) {
    console.error("Could not cancel screen selection:", error);
  } finally {
    cancelScreenSelection();
  }
};

(async () => {
  const cfg = await api.config();
  if (cfg.serverUrl) SERVER_URL = cfg.serverUrl;
  $("dir").textContent = cfg.dir;
  $("server").textContent = SERVER_URL;

  // 1. Immediately generate & display the QR code locally (zero delay)
  showQr();

  // 2. Pre-warm cloud relay server so Render container spins up ASAP
  wakeServer();

  // 3. Connect signaling WebSocket
  connectSig();

  // 4. Prompt screen capture
  startScreen();
})();
