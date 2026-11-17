"use strict";
// Offline encoder self-test page: SYNTHETIC CANVAS ONLY (no getDisplayMedia/getUserMedia/desktopCapturer).
// Each output frame mirrors the POC output layout at 1920x1080:
//   captured-window stand-in: static background + moving box + privacy canaries + test-window
//   barcode (0,64); optional "foreign" rectangle (simulates foreign desktop content inside the
//   captured region); PiP with the synthetic camera (barcode, mid-gray patch, white border);
//   compositor barcode (0,0) and black A/V flash box, exactly as recorder.js draws them.
const W = 1920,
  H = 1080;
const out = document.getElementById("out");
const ctx = out.getContext("2d");
const cam = document.createElement("canvas");
cam.width = 1280;
cam.height = 720;
const cctx = cam.getContext("2d");
const PIP = { x: 1382, y: 713, w: 480, h: 270 }; // default PiP rect (x .72, y .66, w .25) on 1920x1080
const FOREIGN = [700, 400, 200, 150];
const canaries = Canary.positions(W, H);
const stat = document.createElement("canvas");
stat.width = W;
stat.height = H;
const sctx = stat.getContext("2d");

function buildStatic(instr) {
  sctx.fillStyle = "#102030";
  sctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 12; i++) {
    sctx.fillStyle = `hsl(${i * 30} 55% 38%)`;
    sctx.fillRect((i * W) / 12 - 40, 140, 120, H - 280);
  }
  sctx.fillStyle = "#9fb3c8";
  sctx.font = "20px Consolas, monospace";
  for (let i = 0; i < 18; i++) sctx.fillText(`synthetic line ${i}  CamShare POC encoder self-test content`, 960, 212 + i * 32);
  if (instr) Canary.draw(sctx, canaries);
}
function drawForeign(g) {
  const [x, y, w, h] = FOREIGN;
  g.fillStyle = "#f3f3f3";
  g.fillRect(x, y, w, h);
  g.fillStyle = "#202020";
  for (let r = 0; r < 9; r++) g.fillRect(x + 10, y + 10 + r * 15, 40 + ((r * 53) % 140), 7); // text-like lines
}
function drawCam(k) {
  cctx.fillStyle = "#282828";
  cctx.fillRect(0, 0, 1280, 720);
  cctx.fillStyle = "#0b3d2e";
  cctx.fillRect(16, 64, 1248, 640);
  cctx.fillStyle = "#e07a2f";
  cctx.beginPath();
  cctx.arc(200 + ((k * 10) % 880), 380, 90, 0, Math.PI * 2);
  cctx.fill();
  cctx.fillStyle = "#808080";
  cctx.fillRect(1080, 520, 200, 200);
  Barcode.draw(cctx, 0, 0, 48, k);
}
// Raw "captured window" frame (what verifyCapture sees): static + box + canaries + test-window barcode.
function drawWindowLayer(g, n, instr, foreign) {
  g.drawImage(stat, 0, 0);
  const bx = Math.round((Math.sin(n / 27) * 0.4 + 0.5) * (W - 220)),
    by = Math.round((Math.cos(n / 21) * 0.35 + 0.5) * (H - 360) + 140);
  g.fillStyle = "#c0563a";
  g.fillRect(bx, by, 220, 160);
  if (instr) {
    Canary.draw(g, canaries, [bx, by, 220, 160]);
    Barcode.draw(g, 0, 64, 32, n);
  }
  if (foreign) drawForeign(g);
}
// The exact pixel checks used by recorder.js verifyCapture (Barcode.read, Canary.test).
function pixelCheck(g) {
  const d = g.getImageData(0, 0, W, H).data;
  const lum = (x, y) => {
    const k = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
    return 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
  };
  return { code: Barcode.read(lum, 0, 64, 32), canaries: canaries.length, failed: canaries.filter(([x, y]) => !Canary.test(lum, x, y)).length };
}

async function runVariant(v) {
  buildStatic(v.instr);
  // verifyCapture-equivalent pixel check on raw (pre-encode) window frames: clean and with foreign
  const probe = document.createElement("canvas");
  probe.width = W;
  probe.height = H;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  drawWindowLayer(pctx, 7, v.instr, false);
  const clean = pixelCheck(pctx);
  drawWindowLayer(pctx, 8, v.instr, true);
  const withForeign = pixelCheck(pctx);

  await st.begin(v.name);
  const MIME_ORDER = ["video/webm;codecs=h264,opus", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
  const mime = MIME_ORDER.find((m) => MediaRecorder.isTypeSupported(m));
  const stream = out.captureStream(30);
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 }); // as recorder.js
  let chain = Promise.resolve();
  mr.ondataavailable = (e) => {
    if (!e.data.size) return;
    chain = chain.then(async () => st.chunk(await e.data.arrayBuffer()));
  };
  const frames = [];
  const meta = { name: v.name, variant: v, seconds: v.seconds, mime, foreignDrawn: [] };
  let c = 0,
    k = 0,
    next = 0,
    running = true;
  const draw = (now) => {
    if (!running) return;
    if (now >= next) {
      next = next && now - next < 100 ? next + 1000 / 30 : now + 1000 / 30;
      c++;
      k++;
      const foreign = !!(v.foreign && c >= v.foreign[0] && c <= v.foreign[1]);
      if (foreign) meta.foreignDrawn.push(c);
      drawWindowLayer(ctx, c, v.instr, foreign);
      drawCam(k);
      ctx.drawImage(cam, PIP.x, PIP.y, PIP.w, PIP.h);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.strokeRect(PIP.x, PIP.y, PIP.w, PIP.h);
      if (v.instr) {
        Barcode.draw(ctx, 0, 0, 32, c);
        ctx.fillStyle = "#000000";
        ctx.fillRect(896, 0, 96, 96);
      }
      frames.push([c, Math.round(now * 10) / 10, 0, [PIP.x, PIP.y, PIP.w, PIP.h], 1280, 720]);
    }
    requestAnimationFrame(draw);
  };
  await new Promise((resolve) => {
    mr.onstart = () => {
      meta.onstartT = performance.now();
      meta.onstartWall = Date.now();
    };
    mr.onstop = async () => {
      meta.onstopT = performance.now();
      meta.onstopWall = Date.now();
      running = false;
      await chain;
      resolve();
    };
    requestAnimationFrame(draw);
    setTimeout(() => {
      meta.startCalledT = performance.now();
      meta.startCalledWall = Date.now();
      meta.compAtStart = c;
      mr.start(1000);
      setTimeout(() => mr.stop(), v.seconds * 1000);
    }, 300);
  });
  stream.getTracks().forEach((t) => t.stop());
  meta.frames = frames;
  meta.pixelCheck = { clean, withForeign };
  await st.end(meta);
  document.getElementById("s").textContent = `${v.name} done`;
}

(async () => {
  try {
    const variants = await st.variants();
    for (const v of variants) await runVariant(v);
    st.done({ ok: true });
  } catch (e) {
    st.log({ error: e.message });
    st.done({ error: e.message });
  }
})();
