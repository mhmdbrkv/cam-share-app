"use strict";
// CamShare Recording Engine POC: recorder renderer (Screen + Camera pipeline).
//
// Provenance: blocks marked "COPIED FROM src/renderer.js@6c3bf48 La-Lb" are verbatim from
// commit 6c3bf48a75025c9107729f56d2d01812bbf33ae3 (src/renderer.js sha256 3b5fe7e4…0176,
// unmodified in the working tree when copied). Inside copied blocks, changed lines are
// marked "POC CHANGE" and added lines "POC ADD". Everything else is POC instrumentation.
const $ = (i) => document.getElementById(i);
const api = window.poc;
let cfg = { mime: "auto" };

// COPIED FROM src/renderer.js@6c3bf48 L3-31 (subset of state)
const S = {
  state: "idle",
  screen: null,
  pc: null,
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
let recordMode = "cam"; // POC CHANGE: the POC always records Screen + Camera
let audioContext = null;
let mr = null,
  outStream = null;

/* ---------- POC ADD: instrumentation ---------- */
const M = {
  // per-second counters (reset by the stats sampler)
  draws: 0,
  rafDraws: 0,
  intervalDraws: 0,
  raf: 0,
  intervalTicks: 0,
  svFrames: 0,
  cvFrames: 0,
  chunks: 0,
  chunkMsMax: 0,
  // cumulative
  compFrame: 0,
  pendingBytes: 0,
  maxPending: 0,
  flashUntil: 0,
  beepPending: false,
  markerN: 0,
  frameLog: [],
};
let audioDest = null;
let bed = null;
let markerTimer = null,
  markerStart = null,
  churnTimer = null;

function countFrames(v, key) {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return false;
  const cb = () => {
    M[key]++;
    v.requestVideoFrameCallback(cb);
  };
  v.requestVideoFrameCallback(cb);
  return true;
}

// COPIED FROM src/renderer.js@6c3bf48 L33-35
const hasScreen = () =>
  !!S.screen &&
  S.screen.getVideoTracks().some((track) => track.readyState === "live");

/* ---------- screen capture (core of src/renderer.js@6c3bf48 L56-102) ---------- */
async function startScreen() {
  // POC CHANGE: the main-process handler grants ONLY the verified synthetic test WINDOW
  // (window capture), never a screen. See installDisplayMediaHandler in main.js.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: false, // POC CHANGE: app uses audio:true (Windows loopback). Disabled so the POC never records the user's system audio; V1 is PC-mic-only.
  });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("No screen video track was selected");
  sv.srcObject = stream;
  await sv.play();
  if (!sv.videoWidth || !sv.videoHeight)
    await new Promise((resolve) =>
      sv.addEventListener("loadedmetadata", resolve, { once: true }),
    );
  // COPIED FROM src/renderer.js@6c3bf48 L84-87
  const h = Math.min(1080, sv.videoHeight),
    w = Math.round((sv.videoWidth * h) / sv.videoHeight);
  canvas.width = w & ~1;
  canvas.height = h & ~1; // never upscale, keep aspect
  S.screen = stream;
  track.onended = () => {
    api.report("screen-ended", {}); // POC CHANGE: report instead of UI text
    S.screen = null;
    if (mr && mr.state !== "inactive") mr.stop();
  };
  const svCounting = countFrames(sv, "svFrames");
  return {
    settings: track.getSettings(),
    videoSize: [sv.videoWidth, sv.videoHeight],
    canvas: [canvas.width, canvas.height],
    rvfc: svCounting,
  };
}

// COPIED FROM src/renderer.js@6c3bf48 L144-154
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
// COPIED FROM src/renderer.js@6c3bf48 L155-166
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
// COPIED FROM src/renderer.js@6c3bf48 L167-171
function setPipSize(size) {
  S.pip.w = Math.min(0.5, Math.max(0.1, size));
  // POC CHANGE: the app also updates the size slider label here; the POC has no slider
}

// COPIED FROM src/renderer.js@6c3bf48 L172-204, with POC ADD stamps at the end
function renderFrame(source) {
  if (!S.screen || !sv.videoWidth) return;
  ctx.drawImage(sv, 0, 0, canvas.width, canvas.height);
  const pipEnabled = mr ? recordMode === "cam" : true; // POC CHANGE: no mode radio in the POC
  let rect = null; // POC ADD
  if (pipEnabled && camLive()) {
    const r = pipRect();
    rect = r; // POC ADD
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
  // POC ADD: measurement stamps. Layout contract with analyze.js (output pixels):
  //   compositor barcode x 0..832, y 0..32 (cell 32); A/V flash box x 896..992, y 0..96.
  const c = ++M.compFrame;
  Barcode.draw(ctx, 0, 0, 32, c);
  const t = performance.now();
  const flash = t < M.flashUntil;
  ctx.fillStyle = flash ? "#ffffff" : "#000000";
  ctx.fillRect(896, 0, 96, 96);
  if (flash && M.beepPending) {
    M.beepPending = false;
    const at = beep();
    api.report("marker", { n: M.markerN, c, t, audioTime: at, sinceRecMs: markerStart === null ? null : t - markerStart });
  }
  // POC ADD (--scheduler=optionB): explicit frame emission for every intended frame
  if (outVideoTrack && cfg.scheduler === "optionB") outVideoTrack.requestFrame();
  M.draws++;
  if (source === 0) M.rafDraws++;
  else M.intervalDraws++;
  if (mr)
    M.frameLog.push([
      c,
      Math.round(t * 10) / 10,
      source,
      rect ? [+rect.x.toFixed(2), +rect.y.toFixed(2), +rect.w.toFixed(2), +rect.h.toFixed(2)] : null,
      cv.videoWidth,
      cv.videoHeight,
    ]);
}

// COPIED FROM src/renderer.js@6c3bf48 L207-223, with POC ADD counters.
// POC CHANGE (--scheduler=optionB only; default "app" is the unchanged copy): phase-keeping fixed
// 30 Hz deadline, drawn on the vsync nearest each deadline, resync after a stall (no burst).
// Validated offline in investigate/ (REPORT-fps-av.md §4): with captureStream(0)+requestFrame,
// 6/6 runs at 30.00 fps, 0 drawn frames missing.
let lastFrameTime = 0;
const frameInterval = 1000 / 30; // 30 fps cadence
let deadline = null, // POC ADD (optionB)
  prevTick = null,
  tickEma = 1000 / 144;
let outVideoTrack = null; // POC ADD (optionB): canvas track for requestFrame()
function loop(now) {
  M.raf++; // POC ADD
  if (cfg.scheduler === "optionB") {
    if (prevTick !== null) tickEma += 0.05 * (Math.min(50, Math.max(2, now - prevTick)) - tickEma);
    prevTick = now;
    if (deadline === null) deadline = now;
    if (now >= deadline - tickEma / 2) {
      renderFrame(0);
      deadline += frameInterval;
      if (now - deadline > frameInterval) deadline = now + frameInterval;
    }
  } else if (now - lastFrameTime >= frameInterval - 2) {
    lastFrameTime = now;
    renderFrame(0);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Background fallback: ensure frames continue flowing into recorder when window is minimized
setInterval(() => {
  M.intervalTicks++; // POC ADD
  if (document.hidden && mr) {
    renderFrame(1);
  }
}, frameInterval);

/* ---------- camera stream + signaling ---------- */
// COPIED FROM src/renderer.js@6c3bf48 L266-308 (desktop is the answerer)
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
          iceServers: [], // POC CHANGE: loopback, no STUN/TURN
        }));
        pc.ontrack = (e) => {
          cv.srcObject = e.streams[0];
          cv.play();
          if (!cvCounting) cvCounting = countFrames(cv, "cvFrames"); // POC ADD
        };
        pc.onicecandidate = (e) =>
          e.candidate &&
          sendSignal({ negotiationId, ice: e.candidate });
        pc.onconnectionstatechange = () => {
          api.report("pc-state", { state: pc.connectionState }); // POC CHANGE: report instead of UI text
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
    .catch((e) => api.report("error", { message: "onSig: " + e.message })); // POC CHANGE
}
let cvCounting = false;
function sendSignal(data) {
  // POC CHANGE: IPC loopback instead of the WebSocket relay. JSON round-trip as the app's
  // ws.send(JSON.stringify(...)) does: RTCSessionDescription/RTCIceCandidate lose their
  // fields when passed through contextBridge as objects (found in run 20261117-021331-smoke).
  api.sig(JSON.parse(JSON.stringify(data)));
}
api.onSig(onSig);

/* ---------- POC ADD: capture verification (privacy gate, runs before anything is recorded) ----------
 * Checks, all required:
 *   a) the track reports displaySurface "window"
 *   b) the captured frame size equals the test window's physical size reported by its process
 *   c) in 5 captured frames over ~1.2 s: the test window's barcode decodes and strictly increases
 *      (live content of THIS window), and EVERY privacy canary is present. Canaries include the
 *      area where the recorder window overlaps the test window on screen, so this also proves that
 *      an overlapping window does not leak into the window capture.
 */
async function verifyCapture(expected) {
  const track = S.screen.getVideoTracks()[0];
  const settings = track.getSettings();
  const W = sv.videoWidth,
    H = sv.videoHeight;
  const res = { displaySurface: settings.displaySurface, size: [W, H], expected, samples: [] };
  if (settings.displaySurface !== "window") return { ok: false, reason: "displaySurface is not 'window'", ...res };
  if (!expected || expected.size[0] !== W || expected.size[1] !== H) return { ok: false, reason: "captured size differs from the test window's physical size", ...res };
  const oc = document.createElement("canvas");
  oc.width = W;
  oc.height = H;
  const octx = oc.getContext("2d", { willReadFrequently: true });
  const list = Canary.positions(W, H);
  let last = -1;
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 250));
    octx.drawImage(sv, 0, 0, W, H);
    const d = octx.getImageData(0, 0, W, H).data;
    const lum = (x, y) => {
      const k = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
      return 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
    };
    const code = Barcode.read(lum, 0, 64, 32);
    const failed = list.filter(([x, y]) => !Canary.test(lum, x, y)).length;
    res.samples.push({ code, canaries: list.length, failed });
    if (code === null) return { ok: false, reason: "test-window barcode not readable in the captured frame", ...res };
    if (code <= last) return { ok: false, reason: "test-window barcode did not advance (not live content of the test window)", ...res };
    if (failed > 0) return { ok: false, reason: `${failed} of ${list.length} privacy canaries missing in the captured frame`, ...res };
    last = code;
  }
  return { ok: true, canaries: list.length, ...res };
}

/* ---------- POC ADD: synthetic A/V marker tone ---------- */
function beep() {
  if (!audioContext || !audioDest) return null;
  const t = audioContext.currentTime;
  const o = audioContext.createOscillator();
  const g = audioContext.createGain();
  o.frequency.value = 1000;
  g.gain.setValueAtTime(0.5, t);
  g.gain.setValueAtTime(0, t + 0.1);
  o.connect(g).connect(audioDest);
  o.start(t);
  o.stop(t + 0.12);
  return t;
}

/* ---------- recording controller ---------- */
// COPIED FROM src/renderer.js@6c3bf48 L388-515 (Screen + Camera path), changes marked
let captureVerifiedOk = false; // POC ADD: set only by a successful verifyCapture()
async function startRecording() {
  if (mr) return;
  if (!captureVerifiedOk) {
    // POC ADD: renderer-side gate (defence in depth; main also gates on verification)
    api.report("rec-error", { stage: "start", message: "refused: capture not verified" });
    return;
  }
  setState("preparing");
  try {
    const mode = "cam"; // POC CHANGE: no mode radio
    recordMode = mode;
    if (mode === "cam" && !camLive())
      throw new Error("Phone camera is not streaming");
    const p = await api.prepare();
    api.report("prepare", p); // POC CHANGE: the app asks confirm() when p.low; the POC logs and continues
    // POC CHANGE (--scheduler=optionB): captureStream(0) + requestFrame() per drawn frame; the
    // default ("app") keeps the app's captureStream(30)
    outStream = canvas.captureStream(cfg.scheduler === "optionB" ? 0 : 30);
    outVideoTrack = cfg.scheduler === "optionB" ? outStream.getVideoTracks()[0] : null;
    // POC CHANGE (audio): the app mixes screen audio + PC mic or phone mic. The POC records
    // ONLY a synthetic 1 kHz marker tone through the same AudioContext ->
    // MediaStreamDestination path, so A/V sync can be measured without capturing any real audio.
    audioContext = new AudioContext();
    audioDest = audioContext.createMediaStreamDestination();
    // POC ADD (fix after run 20261117-021546-smoke): a continuous near-silent bed (200 Hz at
    // -60 dBFS) so the audio track carries data from the first instant. Without it the
    // destination produced no audio until the first marker tone and MediaRecorder started
    // ~5 s late. The bed feeds ONLY the recording (never the speakers) and is far below the
    // analyzer's tone-onset threshold (-26 dBFS). Non-zero so the encoder cannot treat it as
    // digital silence.
    bed = audioContext.createOscillator();
    bed.frequency.value = 200;
    const bedGain = audioContext.createGain();
    bedGain.gain.value = 0.001;
    bed.connect(bedGain).connect(audioDest);
    bed.start();
    outStream.addTrack(audioDest.stream.getAudioTracks()[0]);
    await audioContext.resume();
    // POC ADD: confirm the audio graph is rendering before recording starts
    const ct0 = audioContext.currentTime;
    await new Promise((r) => setTimeout(r, 250));
    api.report("audio-ready", {
      state: audioContext.state,
      advancedS: audioContext.currentTime - ct0,
      sampleRate: audioContext.sampleRate,
      baseLatency: audioContext.baseLatency,
      trackState: outStream.getAudioTracks()[0].readyState,
    });
    // Prefer hardware accelerated codecs (H.264 / VP8) over heavy software VP9 to prevent CPU spikes and frame drops
    const MIME_ORDER = [
      "video/webm;codecs=h264,opus",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
    ];
    // POC ADD: optional --mime override for codec comparison runs
    const forced = {
      h264: "video/webm;codecs=h264,opus",
      vp8: "video/webm;codecs=vp8,opus",
      vp9: "video/webm;codecs=vp9,opus",
    }[cfg.mime];
    const mime = forced
      ? MediaRecorder.isTypeSupported(forced)
        ? forced
        : null
      : MIME_ORDER.find((m) => MediaRecorder.isTypeSupported(m));
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
      M.pendingBytes = pending; // POC ADD
      if (pending > M.maxPending) M.maxPending = pending; // POC ADD
      if (pending > 256e6)
        return fail(new Error("Disk too slow: write backlog exceeded"));
      chain = chain
        .then(async () => {
          const t0 = performance.now(); // POC ADD
          await api.chunk(await e.data.arrayBuffer());
          const ms = performance.now() - t0; // POC ADD
          M.chunks++; // POC ADD
          if (ms > M.chunkMsMax) M.chunkMsMax = ms; // POC ADD
          pending -= e.data.size;
          M.pendingBytes = pending; // POC ADD
        })
        .catch(fail);
    };
    mr.onstart = () =>
      api.report("mr-start", { wall: Date.now(), t: performance.now(), mime, vbps: recorder.videoBitsPerSecond, abps: recorder.audioBitsPerSecond }); // POC ADD
    mr.onerror = (e) => api.report("mr-error", { message: e.error?.message || String(e.error) }); // POC ADD
    mr.onstop = async () => {
      api.report("mr-stop", { wall: Date.now(), t: performance.now() }); // POC ADD
      clearInterval(markerTimer); // POC ADD
      setChurn(false, true); // POC ADD
      mr = null;
      setState("finalizing");
      await chain;
      flushFrames(); // POC ADD
      cleanupRecordingStreams();
      try {
        const r = await api.stop();
        setState("completed");
        api.report("rec-done", { result: r, rendererError: err ? err.message : null }); // POC CHANGE: report instead of preview UI
      } catch (e) {
        setState("error");
        api.report("rec-error", { stage: "stop", message: e.message }); // POC CHANGE
      }
    };
    api.report("mr-start-called", { t: performance.now(), wall: Date.now(), c: M.compFrame }); // POC ADD: start-delay reference
    mr.start(1000);
    setState("recording");
    const supported = {};
    for (const m of [...MIME_ORDER, "video/webm;codecs=h264,opus", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm;codecs=av1,opus"])
      supported[m] = MediaRecorder.isTypeSupported(m);
    api.report("rec-started", { mime, supported }); // POC ADD
    // POC ADD: A/V marker every 10 s, first at 5 s: a 100 ms white flash + a 100 ms 1 kHz tone,
    // triggered on the same compositor draw.
    markerStart = performance.now();
    let n = 0;
    const arm = () => {
      M.flashUntil = performance.now() + 100;
      M.beepPending = true;
      M.markerN = ++n;
    };
    markerTimer = setTimeout(() => {
      arm();
      markerTimer = setInterval(arm, 10000);
    }, 5000);
  } catch (e) {
    cleanupRecordingStreams();
    await api.abort();
    setState("error");
    api.report("rec-error", { stage: "start", message: e.message }); // POC CHANGE
  }
}
// COPIED FROM src/renderer.js@6c3bf48 L516-532 (no mic / audio sources in the POC)
function cleanupRecordingStreams() {
  const screenTracks = new Set(S.screen ? S.screen.getTracks() : []);
  if (outStream)
    outStream.getTracks().forEach((track) => {
      if (!screenTracks.has(track)) track.stop();
    });
  if (bed) {
    try {
      bed.stop(); // POC ADD
    } catch {}
    bed = null;
  }
  if (audioContext && audioContext.state !== "closed")
    audioContext.close().catch((error) =>
      console.error("Could not close audio mixer:", error),
    );
  audioContext = null;
  audioDest = null; // POC ADD
  outStream = null;
  outVideoTrack = null; // POC ADD (optionB)
}
function setState(s) {
  S.state = s; // POC CHANGE: no button/UI state handling
}

/* ---------- POC ADD: PiP automation (exercises the same S.pip state the drag handlers mutate) ---------- */
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
function setChurn(on, quiet) {
  if (churnTimer) clearInterval(churnTimer);
  churnTimer = null;
  if (on) {
    let step = 0;
    churnTimer = setInterval(() => {
      step++;
      if (step % 4 === 0) setPipSize(0.1 + 0.4 * Math.abs(((step / 4) % 10) / 5 - 1));
      else {
        S.pip.x = rnd() * 0.9;
        S.pip.y = 0.12 + rnd() * 0.78; // keep clear of the measurement stamps (top 130 px)
      }
    }, 500);
  }
  if (!quiet) api.report("pip-churn", { on, c: M.compFrame });
}

function flushFrames() {
  if (M.frameLog.length) {
    api.frames(M.frameLog);
    M.frameLog = [];
  }
}

async function inboundStats() {
  if (!S.pc) return null;
  const rep = await S.pc.getStats();
  let o = null;
  rep.forEach((s) => {
    if (s.type === "inbound-rtp" && s.kind === "video")
      o = {
        framesDecoded: s.framesDecoded,
        framesDropped: s.framesDropped,
        framesReceived: s.framesReceived,
        fps: s.framesPerSecond,
        w: s.frameWidth,
        h: s.frameHeight,
        freezeCount: s.freezeCount,
        totalFreezesDuration: s.totalFreezesDuration,
      };
  });
  return o;
}

setInterval(async () => {
  const s = {
    t: Math.round(performance.now()),
    wall: Date.now(),
    vis: document.visibilityState,
    hidden: document.hidden,
    focus: document.hasFocus(),
    draws: M.draws,
    rafDraws: M.rafDraws,
    intervalDraws: M.intervalDraws,
    raf: M.raf,
    intervalTicks: M.intervalTicks,
    svFrames: M.svFrames,
    cvFrames: M.cvFrames,
    chunks: M.chunks,
    chunkMsMax: Math.round(M.chunkMsMax * 10) / 10,
    comp: M.compFrame,
    pending: M.pendingBytes,
    maxPending: M.maxPending,
    camLive: camLive(),
    pc: S.pc ? S.pc.connectionState : null,
    cam: [cv.videoWidth, cv.videoHeight],
    rec: mr ? mr.state : null,
    state: S.state,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
  for (const k of ["draws", "rafDraws", "intervalDraws", "raf", "intervalTicks", "svFrames", "cvFrames", "chunks", "chunkMsMax"]) M[k] = 0;
  const tr = outStream && outStream.getVideoTracks()[0];
  if (tr) {
    if ("stats" in tr) {
      try {
        const st = tr.stats;
        s.trackStats = { delivered: st.deliveredFrames, discarded: st.discardedFrames, total: st.totalFrames };
      } catch (e) {
        s.trackStats = { error: e.message };
      }
    } else s.trackStats = "unsupported";
  }
  try {
    s.inbound = await inboundStats();
  } catch (e) {
    s.inbound = { error: e.message };
  }
  api.stats(s);
  flushFrames();
  $("stats").textContent =
    `state ${s.state}  rec ${s.rec}  draws/s ${s.draws} (raf ${s.rafDraws}, interval ${s.intervalDraws})  raf/s ${s.raf}\n` +
    `camera ${s.camLive ? "live" : "not live"} ${s.cam.join("x")}  pc ${s.pc}  pending ${(s.pending / 1e6).toFixed(2)} MB  comp #${s.comp}\n` +
    `Ctrl+Shift+Q aborts the run (the recording is still saved)`;
}, 1000);

/* ---------- POC control ---------- */
api.onCtl((m) => {
  if (m.t === "start") startRecording();
  else if (m.t === "stop") {
    if (mr && mr.state !== "inactive") mr.stop();
  } else if (m.t === "pip-churn") setChurn(!!m.on);
  else if (m.t === "peer" && !m.up) {
    cv.srcObject = null; // COPIED FROM src/renderer.js@6c3bf48 L368-369 (peer down)
    api.report("peer-down", {});
  }
});

(async () => {
  cfg = await api.config();
  let info;
  try {
    info = await startScreen();
  } catch (e) {
    api.report("capture-verify-failed", { reason: "getDisplayMedia failed or was denied", message: e.message });
    return;
  }
  let v;
  try {
    v = await verifyCapture(cfg.expectedCapture);
  } catch (e) {
    v = { ok: false, reason: "exception during capture verification", message: e.message };
  }
  if (!v.ok) {
    S.screen.getTracks().forEach((t) => t.stop()); // stop capturing immediately
    S.screen = null;
    api.report("capture-verify-failed", v);
    return; // never reports ready -> recording never starts
  }
  captureVerifiedOk = true;
  api.report("capture-verified", v);
  api.report("screen-ready", info);
  const t0 = performance.now();
  const wait = setInterval(() => {
    if (camLive() && hasScreen()) {
      clearInterval(wait);
      api.report("ready", {
        canvas: [canvas.width, canvas.height],
        screen: S.screen.getVideoTracks()[0].getSettings(),
        camera: [cv.videoWidth, cv.videoHeight],
        camTrack: cv.srcObject.getVideoTracks()[0].getSettings(),
        pip: { ...S.pip },
        waitedMs: Math.round(performance.now() - t0),
        rvfc: { sv: info.rvfc, cv: cvCounting },
      });
    }
  }, 200);
})();
