const SERVER_URL = "https://cam-share-app.onrender.com";
const $ = (i) => document.getElementById(i);
const S = {
  state: "idle",
  screen: null,
  pc: null,
  ws: null,
  room: crypto.randomUUID().replace(/-/g, ""),
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  pip: { x: 0.72, y: 0.66, w: 0.25 },
  q: Promise.resolve(),
  pendingIce: [],
  file: null,
};
const sv = document.createElement("video"),
  cv = document.createElement("video"); // hidden sources
sv.muted = cv.muted = true;
cv.playsInline = true;
const canvas = $("cv"),
  ctx = canvas.getContext("2d");
let selectingScreen = false;
let stopReason = "";

const hasScreen = () =>
  !!S.screen &&
  S.screen.getVideoTracks().some((track) => track.readyState === "live");

/* ---------- state machine ---------- */
function setState(s, msg) {
  S.state = s;
  $("st").textContent = msg || s;
  $("go").disabled =
    !["idle", "completed", "error"].includes(s) || !hasScreen();
  $("stop").disabled = s !== "recording";
  $("screenBtn").disabled =
    selectingScreen || ["preparing", "recording", "finalizing"].includes(s);
  $("done").style.display = s === "completed" ? "block" : "none";
}

/* ---------- screen capture + compositor (shared by preview & recording) ---------- */
async function startScreen() {
  if (
    selectingScreen ||
    ["preparing", "recording", "finalizing"].includes(S.state)
  )
    return;
  selectingScreen = true;
  setState("selecting", "Select a screen to capture");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
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
      e.name === "AbortError"
        ? "Screen selection cancelled. Select screen to retry."
        : "Screen capture failed: " + e.message,
    );
  } finally {
    selectingScreen = false;
    $("screenBtn").disabled = false;
  }
}
const camLive = () => {
  const t = cv.srcObject && cv.srcObject.getVideoTracks()[0];
  return !!(
    t &&
    t.readyState === "live" &&
    cv.videoWidth > 0 &&
    S.pc &&
    S.pc.connectionState !== "failed"
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
setInterval(() => {
  // setInterval + backgroundThrottling:false keeps frames flowing when minimized
  if (!S.screen || !sv.videoWidth) return;
  ctx.drawImage(sv, 0, 0, canvas.width, canvas.height);
  if (camLive()) {
    const r = pipRect();
    ctx.save();
    ctx.translate(2 * r.x + r.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(cv, r.x, r.y, r.w, r.h);
    ctx.restore();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
}, 1000 / 30);

/* ---------- PiP controller (position/size only; compositor just reads it) ---------- */
let drag = null;
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
    drag = { dx: p.x - r.x, dy: p.y - r.y };
    canvas.setPointerCapture(e.pointerId);
  }
};
canvas.onpointermove = (e) => {
  if (!drag) return;
  const p = toCanvas(e);
  S.pip.x = (p.x - drag.dx) / canvas.width;
  S.pip.y = (p.y - drag.dy) / canvas.height;
};
canvas.onpointerup = () => (drag = null);
canvas.onwheel = (e) => {
  S.pip.w = Math.min(0.5, Math.max(0.1, S.pip.w - e.deltaY * 0.0005));
  $("size").value = S.pip.w * 100;
};
$("size").oninput = (e) => (S.pip.w = e.target.value / 100);

/* ---------- camera stream manager + signaling (phone is the offerer) ---------- */
function onSig(d) {
  S.q = S.q
    .then(async () => {
      if (d.sdp) {
        if (S.pc) S.pc.close();
        S.pendingIce = [];
        const pc = (S.pc = new RTCPeerConnection({
          iceServers: S.iceServers,
        }));
        pc.ontrack = (e) => {
          cv.srcObject = e.streams[0];
          cv.play();
        };
        pc.onicecandidate = (e) =>
          e.candidate && sendSignal({ ice: e.candidate });
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
        sendSignal({ sdp: pc.localDescription });
      } else if (d.ice && S.pc) {
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
async function connectSig() {
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.close();
  }
  const ws = (S.ws = new WebSocket(SERVER_URL.replace(/^http/, "ws")));
  ws.onopen = async () => {
    ws.send(JSON.stringify({ t: "join", room: S.room, role: "desktop" }));
    $("qr").src = await api.qr(`${SERVER_URL}/?s=${S.room}`);
    $("cam").textContent = "Phone: waiting for scan";
  };
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.t === "config" && Array.isArray(d.iceServers)) {
      S.iceServers = d.iceServers;
      return;
    }
    if (d.t === "sig") onSig(d.data);
    if (d.t === "peer" && !d.up) {
      $("cam").textContent = "Phone: disconnected";
      cv.srcObject = null;
    }
  };
  ws.onclose = () => setTimeout(connectSig, 2000);
}

/* ---------- recording controller ---------- */
let mr = null,
  mic = null,
  outStream = null;
async function startRecording() {
  setState("preparing");
  stopReason = "";
  try {
    const mode = document.querySelector("input[name=mode]:checked").value;
    if (mode === "cam" && !camLive())
      throw new Error("Phone camera is not streaming");
    const p = await api.prepare();
    if (
      p.low &&
      !confirm(`Only ${(p.free / 1e9).toFixed(1)} GB free. Continue anyway?`)
    )
      return setState("idle");
    outStream =
      mode === "cam"
        ? canvas.captureStream(30)
        : new MediaStream(S.screen.getVideoTracks());
    if ($("aud").checked) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        mic.getAudioTracks().forEach((t) => outStream.addTrack(t));
      } catch {
        if (!confirm("Microphone unavailable. Continue without audio?")) {
          cleanupRecordingStreams();
          return setState("idle");
        }
      }
    }
    const mime = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    ].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("No supported recording format");
    await api.start(mime.includes("mp4") ? "mp4" : "webm");
    mr = new MediaRecorder(outStream, {
      mimeType: mime,
      videoBitsPerSecond: 8e6,
    });
    let chain = Promise.resolve(),
      pending = 0,
      err = null;
    const fail = (e) => {
      err = err || e;
      if (mr.state !== "inactive") mr.stop();
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
      setState("finalizing");
      await chain;
      cleanupRecordingStreams();
      try {
        const r = await api.stop();
        S.file = r.file;
        $("fn").textContent =
          r.file + (r.partial ? " (partial: " + r.error + ")" : "");
        $("pv").src =
          "file://" +
          (r.file.startsWith("/") ? "" : "/") +
          encodeURI(r.file.replace(/\\/g, "/"));
        const messages = [];
        if (stopReason) messages.push(`${stopReason}; recording saved`);
        if (r.partial) messages.push(`partial: ${r.error}`);
        setState("completed", messages.join(" — ") || "Completed");
      } catch (e) {
        setState("error", "Save failed: " + e.message);
      }
    };
    mr.start(1000);
    setState("recording", "Recording…");
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
  outStream = null;
  mic = null;
}
$("go").onclick = startRecording;
$("stop").onclick = () => {
  $("stop").disabled = true;
  mr.stop();
};
api.onStopRequest(() => {
  if (mr && mr.state !== "inactive") mr.stop();
});
$("open").onclick = () => api.showFile(S.file);
$("again").onclick = () => setState("idle");
$("screenBtn").onclick = startScreen;
$("pick").onclick = async () => ($("dir").textContent = await api.chooseDir());

(async () => {
  $("dir").textContent = (await api.config()).dir;
  $("server").textContent = SERVER_URL;
  connectSig();
  startScreen();
})();
