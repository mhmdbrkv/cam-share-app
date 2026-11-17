"use strict";
// CamShare Recording Engine POC: "screen content + phone" simulator.
// Runs in a SEPARATE Electron process (--role=pattern) so its CPU/GPU cost is not
// attributed to the recorder. It covers the whole primary display, so the
// recording captures only POC content, never the user's desktop.
//
// The WebRTC sender logic is COPIED FROM server/public/m.html@6c3bf48
// (sha256 8c85c6bb…6c20), lines 163-216 and 133-155. Changed lines are marked "POC CHANGE".
const api = window.poc;
const scr = document.getElementById("screen");
const sctx = scr.getContext("2d");
const cam = document.getElementById("cam");
const cctx = cam.getContext("2d");
const dpr = window.devicePixelRatio || 1;

let canaries = [];
function size() {
  scr.width = Math.round(innerWidth * dpr);
  scr.height = Math.round(innerHeight * dpr);
  scr.style.width = innerWidth + "px";
  scr.style.height = innerHeight + "px";
  // Camera preview placed in PHYSICAL pixels so the canary exclusion rect matches exactly.
  const cp = Canary.CAM_PREVIEW;
  cam.style.left = cp.x / dpr + "px";
  cam.style.top = cp.y / dpr + "px";
  cam.style.width = cp.w / dpr + "px";
  cam.style.height = cp.h / dpr + "px";
  canaries = Canary.positions(scr.width, scr.height);
}
size();
addEventListener("resize", size);

/* ---------- simulated screen content (physical pixels) ---------- */
// Layout contract with analyze.js (output pixels = screen physical pixels at 1080p):
//   screen barcode: x 0..832, y 64..96 (cell 32). Rows 0..130 stay dark apart from it.
// --pattern=heavy : full-screen redraw every update (moving bars, text, box) — first smoke run.
// --pattern=light : static background drawn once; per update only the moving box (dirty-rect
//                   restore from the static layer) and the barcode change. Added after run
//                   20261117-021546-smoke to separate test-screen GPU load from recorder load.
const MODE = new URLSearchParams(location.search).get("mode") === "heavy" ? "heavy" : "light";
let sFrame = 0;
function paintFull(g, t, frameNo, withBox) {
  const W = scr.width;
  const H = scr.height;
  g.fillStyle = "#102030";
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 12; i++) {
    const x = ((t * 0.12 + (i * W) / 12) % (W + 200)) - 200;
    g.fillStyle = `hsl(${(i * 30 + t * 0.02) % 360} 55% 38%)`;
    g.fillRect(x, 140, 120, H - 280);
  }
  if (withBox) {
    const b = boxAt(t);
    g.fillStyle = "#c0563a";
    g.fillRect(b.x, b.y, b.w, b.h);
  }
  g.fillStyle = "#9fb3c8";
  g.font = `${Math.round(16 * dpr)}px Consolas, monospace`;
  for (let i = 0; i < 18; i++)
    g.fillText(
      `pattern frame ${frameNo + i}  t=${(t / 1000).toFixed(3)}  CamShare POC synthetic screen content`,
      Math.round(W * 0.5),
      Math.round(170 * dpr + i * 26 * dpr),
    );
  Canary.draw(g, canaries); // privacy canaries always on top of the synthetic content
}
function boxAt(t) {
  const W = scr.width;
  const H = scr.height;
  return {
    x: Math.round((Math.sin(t / 900) * 0.4 + 0.5) * (W - 220)),
    y: Math.round((Math.cos(t / 700) * 0.35 + 0.5) * (H - 360) + 140),
    w: 220,
    h: 160,
  };
}
const staticLayer = document.createElement("canvas");
const stctx = staticLayer.getContext("2d");
let staticReady = false,
  prevBox = null;
addEventListener("resize", () => (staticReady = false));
function drawScreen(t) {
  if (MODE === "heavy") {
    paintFull(sctx, t, sFrame, true);
  } else {
    if (!staticReady) {
      staticLayer.width = scr.width;
      staticLayer.height = scr.height;
      paintFull(stctx, 0, 0, false);
      sctx.drawImage(staticLayer, 0, 0);
      staticReady = true;
      prevBox = null;
    }
    if (prevBox)
      sctx.drawImage(staticLayer, prevBox.x, prevBox.y, prevBox.w, prevBox.h, prevBox.x, prevBox.y, prevBox.w, prevBox.h);
    const b = boxAt(t);
    sctx.fillStyle = "#c0563a";
    sctx.fillRect(b.x, b.y, b.w, b.h);
    Canary.draw(sctx, canaries, [b.x, b.y, b.w, b.h]); // keep canaries on top of the moving box
    prevBox = b;
  }
  Barcode.draw(sctx, 0, 64, 32, ++sFrame);
}

/* ---------- synthetic phone camera (1280x720) ---------- */
// Layout contract with analyze.js (camera pixels, scaled into the PiP rect):
//   camera barcode: x 0..1248, y 0..48 (cell 48); dark border; mid-gray 200x200 patch
//   in the bottom-right corner (used to detect a resize handle leaking into the output).
let kFrame = 0;
function drawCam(t) {
  cctx.fillStyle = "#282828";
  cctx.fillRect(0, 0, 1280, 720);
  cctx.fillStyle = "#0b3d2e";
  cctx.fillRect(16, 64, 1248, 640);
  cctx.fillStyle = "#e07a2f";
  cctx.beginPath();
  cctx.arc(200 + ((t * 0.3) % 880), 380, 90, 0, Math.PI * 2);
  cctx.fill();
  cctx.fillStyle = "#808080";
  cctx.fillRect(1080, 520, 200, 200);
  cctx.fillStyle = "#c8d0d8";
  cctx.font = "40px Consolas, monospace";
  cctx.fillText(`camera frame ${kFrame + 1}`, 60, 140);
  Barcode.draw(cctx, 0, 0, 48, ++kFrame);
}

let tick = 0;
let camNext = 0;
function loop(now) {
  if (++tick % 2 === 0) drawScreen(now);
  if (now >= camNext) {
    drawCam(now);
    camNext = camNext && now - camNext < 100 ? camNext + 1000 / 30 : now + 1000 / 30;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ---------- WebRTC sender (phone side) ---------- */
let pc,
  stream = cam.captureStream(), // POC CHANGE: synthetic camera instead of getUserMedia
  busy = false,
  offerSequence = 0,
  activeNegotiationId = null;
const iceServers = []; // POC CHANGE: same-machine loopback, no STUN/TURN
let pendingIce = [];
let messageQueue = Promise.resolve();
// POC CHANGE: JSON round-trip like m.html's ws.send(JSON.stringify(...)); RTC objects lose their
// fields when passed through contextBridge as objects (found in run 20261117-021331-smoke).
const sig = (data) => api.sig(JSON.parse(JSON.stringify(data)));

// COPIED FROM server/public/m.html@6c3bf48 L163-181
async function applySenderOptimizations(targetPc) {
  const senders = targetPc.getSenders();
  for (const sender of senders) {
    if (sender.track && sender.track.kind === "video") {
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) {
          params.encodings = [{}];
        }
        params.encodings[0].degradationPreference = "maintain-framerate";
        params.encodings[0].maxBitrate = 2500000; // 2.5 Mbps
        await sender.setParameters(params);
      } catch (err) {
        console.warn("Could not set sender parameters:", err);
      }
    }
  }
}

// COPIED FROM server/public/m.html@6c3bf48 L183-216
async function offer() {
  if (busy) return;
  busy = true;
  const negotiationId = `${Date.now()}-${++offerSequence}`;
  activeNegotiationId = negotiationId;
  try {
    if (pc) pc.close();
    pendingIce = [];
    const currentPc = (pc = new RTCPeerConnection({ iceServers }));
    stream.getTracks().forEach((t) => currentPc.addTrack(t, stream));
    currentPc.onicecandidate = (e) =>
      e.candidate && sig({ negotiationId, ice: e.candidate }); // POC CHANGE: IPC instead of WebSocket
    currentPc.onconnectionstatechange = () => {
      if (pc === currentPc)
        api.report("pc-state", { state: currentPc.connectionState }); // POC CHANGE: report, not status text
    };
    await currentPc.setLocalDescription(await currentPc.createOffer());
    await applySenderOptimizations(currentPc);
    if (pc === currentPc && activeNegotiationId === negotiationId)
      sig({ negotiationId, sdp: currentPc.localDescription }); // POC CHANGE: IPC instead of WebSocket
  } catch (error) {
    api.report("error", { message: "Connection error: " + error.message }); // POC CHANGE
  } finally {
    busy = false;
  }
}

// COPIED FROM server/public/m.html@6c3bf48 L133-155 (d.data -> data)
api.onSig((data) => {
  messageQueue = messageQueue
    .then(async () => {
      if (!pc) return;
      if (data.sdp) {
        if (
          (data.negotiationId && data.negotiationId !== activeNegotiationId) ||
          pc.signalingState !== "have-local-offer"
        )
          return;
        await pc.setRemoteDescription(data.sdp);
        for (const candidate of pendingIce) await pc.addIceCandidate(candidate);
        pendingIce = [];
      } else if (data.ice) {
        if (data.negotiationId && data.negotiationId !== activeNegotiationId) return;
        if (pc.remoteDescription) await pc.addIceCandidate(data.ice);
        else pendingIce.push(data.ice);
      }
    })
    .catch((error) => api.report("error", { message: "Connection error: " + error.message }));
});

/* ---------- POC control ---------- */
api.onCtl((m) => {
  if (m.t === "offer") offer(); // like the phone re-offering on "peer up"
  else if (m.t === "drop") {
    if (pc) pc.close();
    pc = null;
    api.report("camera-dropped", {});
  }
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.abortRun();
});
api.report("pattern-loaded", { dpr, mode: MODE, inner: [innerWidth, innerHeight], canvas: [scr.width, scr.height], canaries: canaries.length });
