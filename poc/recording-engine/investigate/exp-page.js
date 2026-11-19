"use strict";
// Offline FPS + A/V experiments. SYNTHETIC canvas and SYNTHETIC audio only: no getDisplayMedia,
// no getUserMedia, no desktopCapturer. Recorded with Chromium's real MediaRecorder using the
// app's MIME order and 8 Mbps.
// Variant fields:
//   scheduler: "app" (copied src/renderer.js loop) | "deadline" (option A)
//   capture:   "rate30" (canvas.captureStream(30), as the app) | "requestFrame" (option B:
//              captureStream(0) + track.requestFrame() after every draw)
//   audioMode: "webaudio" (AudioContext -> MediaStreamDestination, as the app) | "generator"
//              (direct track: MediaStreamTrackGenerator + AudioData, no WebAudio)
//   marker:    null | "worklet" | "legacy" (webaudio)  ·  "generator" (generator mode)
//   tsMode:    generator AudioData timestamps: "perf" (performance.now-based) | "counter" (from 0)
const W = 1920,
  H = 1080;
const out = document.getElementById("out");
const ctx = out.getContext("2d");
const stat = document.createElement("canvas");
stat.width = W;
stat.height = H;
(function buildStatic() {
  const g = stat.getContext("2d");
  g.fillStyle = "#102030";
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 12; i++) {
    g.fillStyle = `hsl(${i * 30} 55% 38%)`;
    g.fillRect((i * W) / 12 - 40, 140, 120, H - 280);
  }
  g.fillStyle = "#9fb3c8";
  g.font = "20px Consolas, monospace";
  for (let i = 0; i < 18; i++) g.fillText(`synthetic line ${i}  CamShare POC offline experiment`, 960, 212 + i * 32);
})();
const MIME_ORDER = ["video/webm;codecs=h264,opus", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
const TARGET = 1000 / 30;

function drawFrame(c, flash) {
  ctx.drawImage(stat, 0, 0);
  const bx = Math.round((Math.sin(c / 27) * 0.4 + 0.5) * (W - 220)),
    by = Math.round((Math.cos(c / 21) * 0.35 + 0.5) * (H - 360) + 140);
  ctx.fillStyle = "#c0563a";
  ctx.fillRect(bx, by, 220, 160);
  Barcode.draw(ctx, 0, 0, 32, c); // compositor frame counter, same place as recorder.js
  ctx.fillStyle = flash ? "#ffffff" : "#000000"; // A/V flash box, same place as recorder.js
  ctx.fillRect(896, 0, 96, 96);
}

async function loadWorklet(ac) {
  try {
    await ac.audioWorklet.addModule("marker-worklet.js");
    return "file";
  } catch (e1) {
    const src = await (await fetch("marker-worklet.js")).text();
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    await ac.audioWorklet.addModule(url);
    return "blob (file load failed: " + e1.message + ")";
  }
}

// Direct synthetic audio track (no WebAudio): MediaStreamTrackGenerator + AudioData, paced in real
// time with a 20 ms lead; -60 dBFS 200 Hz bed plus 100 ms 1 kHz tone on request.
function makeGeneratorAudio(meta, tsMode, onTone) {
  const SR = 48000,
    N = 480; // 10 ms chunks
  const gen = new MediaStreamTrackGenerator({ kind: "audio" });
  const writer = gen.writable.getWriter();
  const t0 = performance.now();
  let idx = 0,
    bedPhase = 0,
    tonePhase = 0,
    toneLeft = 0,
    toneReq = 0,
    n = 0,
    stopped = false;
  const pump = () => {
    if (stopped) return;
    const target = ((performance.now() - t0) / 1000) * SR + SR * 0.02;
    while (idx < target) {
      const data = new Float32Array(N);
      if (toneReq > 0 && toneLeft <= 0) {
        toneReq--;
        toneLeft = Math.round(SR * 0.1);
        tonePhase = 0;
        const tNom = t0 + (idx / SR) * 1000;
        n++;
        meta.markers.push({ n, sampleIndex: idx, tNom, tWrite: performance.now(), tFlashDraw: null, cFlash: null });
        onTone(tNom);
      }
      for (let i = 0; i < N; i++) {
        let s = 0.001 * Math.sin(bedPhase);
        bedPhase += (2 * Math.PI * 200) / SR;
        if (toneLeft > 0) {
          s += 0.5 * Math.sin(tonePhase);
          tonePhase += (2 * Math.PI * 1000) / SR;
          toneLeft--;
        }
        data[i] = s;
      }
      const tsUs = tsMode === "perf" ? Math.round((t0 + (idx / SR) * 1000) * 1000) : Math.round((idx / SR) * 1e6);
      const ad = new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: N, numberOfChannels: 1, timestamp: tsUs, data });
      writer.write(ad).catch((e) => xp.log({ generatorWriteError: e.message }));
      idx += N;
    }
  };
  const timer = setInterval(pump, 5);
  pump();
  return {
    track: gen,
    fire: () => toneReq++,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      try {
        await writer.close();
      } catch {}
    },
    info: { sampleRate: SR, chunkFrames: N, tsMode, leadMs: 20 },
  };
}

// Reported pre-warm (cold-start mitigation candidate): a throwaway 1 s recording of a small
// synthetic canvas with the same MIME, started and stopped BEFORE the measured recording. Its data
// is discarded; its timing is reported in meta.prewarm (never hidden).
async function prewarmRecorder() {
  const t0 = performance.now();
  const pc = document.createElement("canvas");
  pc.width = 320;
  pc.height = 180;
  const pctx = pc.getContext("2d");
  const s = pc.captureStream(0);
  const tr = s.getVideoTracks()[0];
  const mime = MIME_ORDER.find((m) => MediaRecorder.isTypeSupported(m));
  const r = new MediaRecorder(s, { mimeType: mime, videoBitsPerSecond: 1e6 });
  let onstartT = null,
    bytes = 0;
  r.onstart = () => (onstartT = performance.now());
  r.ondataavailable = (e) => (bytes += e.data.size); // discarded
  let i = 0;
  const timer = setInterval(() => {
    pctx.fillStyle = `hsl(${(i++ * 7) % 360} 50% 40%)`;
    pctx.fillRect(0, 0, 320, 180);
    tr.requestFrame();
  }, 1000 / 30);
  r.start(250);
  await new Promise((res) => setTimeout(res, 1000));
  await new Promise((res) => {
    r.onstop = res;
    r.stop();
  });
  clearInterval(timer);
  s.getTracks().forEach((t) => t.stop());
  return { totalMs: +(performance.now() - t0).toFixed(1), onstartAfterStartMs: onstartT ? +(onstartT - t0).toFixed(1) : null, discardedBytes: bytes };
}

async function runVariant(v) {
  await xp.begin(v.name);
  const meta = { name: v.name, variant: v, frames: [], markers: [], rafTicks: 0, draws: 0 };
  if (v.prewarm) meta.prewarm = await prewarmRecorder();
  const audioMode = v.audioMode || "webaudio";
  let ac = null,
    dest = null,
    bed = null,
    node = null,
    genAudio = null;
  let flashFrom = -1; // draw counter value at which a flash starts (worklet)
  let flashUntil = 0; // performance.now() until which the flash stays on
  let flashAt = Infinity; // generator: flash from this performance.now() (tone nominal time)
  let legacyPending = false;

  if (audioMode === "generator") {
    if (typeof MediaStreamTrackGenerator === "undefined" || typeof AudioData === "undefined") {
      meta.unavailable = `MediaStreamTrackGenerator: ${typeof MediaStreamTrackGenerator}, AudioData: ${typeof AudioData}`;
      await xp.end(meta);
      return;
    }
    genAudio = makeGeneratorAudio(meta, v.tsMode || "perf", (tNom) => {
      flashAt = tNom;
      flashUntil = tNom + 100;
    });
    meta.audio = { mode: "generator", ...genAudio.info };
  } else {
    // ---- audio: same structure as the app/POC (AudioContext -> MediaStreamDestination) ----
    ac = new AudioContext(v.latencyHint ? { latencyHint: v.latencyHint } : undefined);
    dest = ac.createMediaStreamDestination();
    bed = ac.createOscillator();
    bed.frequency.value = 200;
    const bedGain = ac.createGain();
    bedGain.gain.value = 0.001; // -60 dBFS bed, as in the POC
    bed.connect(bedGain).connect(dest);
    bed.start();
    if (v.marker === "worklet") {
      meta.workletLoad = await loadWorklet(ac);
      node = new AudioWorkletNode(ac, "marker", { numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(dest);
      node.port.onmessage = (e) => {
        const tRecv = performance.now();
        let ots = null;
        try {
          ots = ac.getOutputTimestamp();
        } catch {}
        meta.markers.push({ n: e.data.n, frame: e.data.frame, ctxTime: e.data.time, tRecv, ctxTimeAtRecv: ac.currentTime, outputTimestamp: ots, tFlashDraw: null, cFlash: null });
        flashUntil = tRecv + 100;
        flashFrom = meta.draws + 1; // flash on the NEXT draw after the audio was rendered
      };
    }
    await ac.resume();
    meta.audio = { mode: "webaudio", sampleRate: ac.sampleRate, baseLatency: ac.baseLatency, outputLatency: ac.outputLatency, state: ac.state, latencyHint: v.latencyHint || "default" };
  }
  await new Promise((r) => setTimeout(r, 300));
  if (ac) meta.audio.outputLatency = ac.outputLatency;

  const requestFrameMode = v.capture === "requestFrame";
  const stream = out.captureStream(requestFrameMode ? 0 : 30); // rate30 = as recorder.js
  const vtrack = stream.getVideoTracks()[0];
  // requestFrame() emission control: like the POC recorder, frames are pushed only once recording
  // starts ("primeMs: 0"); with primeMs > 0 pushing begins that many ms BEFORE mr.start()
  // (cold-start mitigation candidate). Earlier variants (no primeMs) pushed from stream creation.
  let pushEnabled = v.primeMs === undefined;
  stream.addTrack(genAudio ? genAudio.track : dest.stream.getAudioTracks()[0]);
  const mime = MIME_ORDER.find((m) => MediaRecorder.isTypeSupported(m));
  meta.mime = mime;
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  let chain = Promise.resolve();
  mr.ondataavailable = (e) => {
    if (e.data.size) chain = chain.then(async () => xp.chunk(await e.data.arrayBuffer()));
  };

  // ---- draw loop ----
  let running = true,
    last = 0,
    lastDraw = -1e9,
    deadline = null,
    prevTick = null,
    tickEma = 1000 / 144;
  const onDraw = () => {
    const c = ++meta.draws;
    const now = performance.now();
    let flash = false;
    if (v.marker === "worklet") flash = c >= flashFrom && flashFrom > 0 && now < flashUntil + 0.001;
    else if (v.marker === "legacy") flash = now < flashUntil;
    else if (v.marker === "generator") flash = now >= flashAt && now < flashUntil;
    drawFrame(c, flash);
    if (requestFrameMode && pushEnabled) vtrack.requestFrame(); // option B: explicit frame emission
    const tDraw = performance.now();
    meta.frames.push([c, Math.round(tDraw * 100) / 100]);
    if (flash) {
      if (v.marker === "worklet" || v.marker === "generator") {
        const m = meta.markers[meta.markers.length - 1];
        if (m && m.cFlash === null) {
          m.cFlash = c;
          m.tFlashDraw = tDraw;
        }
      } else if (legacyPending) {
        // exactly the POC's beep(): osc.start(audioContext.currentTime) on the first flash draw
        legacyPending = false;
        const t = ac.currentTime;
        const o = ac.createOscillator(),
          g = ac.createGain();
        o.frequency.value = 1000;
        g.gain.setValueAtTime(0.5, t);
        g.gain.setValueAtTime(0, t + 0.1);
        o.connect(g).connect(dest);
        o.start(t);
        o.stop(t + 0.12);
        meta.markers.push({ n: meta.markers.length + 1, cFlash: c, tFlashDraw: tDraw, ctxTimeAtBeep: t, outputTimestamp: ac.getOutputTimestamp() });
      }
    }
  };
  const tick = (now) => {
    if (!running) return;
    meta.rafTicks++;
    if (prevTick !== null) tickEma += 0.05 * (Math.min(50, Math.max(2, now - prevTick)) - tickEma);
    prevTick = now;
    if (v.scheduler === "app") {
      // COPIED FROM src/renderer.js@6c3bf48 L209-213 (current app loop)
      if (now - last >= TARGET - 2) {
        last = now;
        onDraw();
      }
    } else if (v.scheduler === "smooth") {
      // Smoothed deadline: same 30 Hz deadlines, but never draw within 0.75 x 33.3 ms (25 ms) of
      // the previous draw; when late, skip ahead instead of catching up with closely spaced draws.
      if (deadline === null) deadline = now;
      if (now >= deadline - tickEma / 2 && now - lastDraw >= 0.75 * TARGET) {
        onDraw();
        lastDraw = now;
        deadline += TARGET;
        if (deadline < now + 0.75 * TARGET - tickEma / 2) deadline = now + TARGET; // late: no catch-up
      }
    } else {
      // Option A: phase-keeping 30 Hz deadline, drawn on the vsync nearest the deadline
      if (deadline === null) deadline = now;
      if (now >= deadline - tickEma / 2) {
        onDraw();
        deadline += TARGET;
        if (now - deadline > TARGET) deadline = now + TARGET; // resync after a stall, no burst
      }
    }
    requestAnimationFrame(tick);
  };

  // ---- markers every 2 s, first at 2 s ----
  const fire = () => {
    if (v.marker === "worklet") node.port.postMessage({ cmd: "fire" });
    else if (v.marker === "legacy") {
      flashUntil = performance.now() + 100;
      legacyPending = true;
    } else if (v.marker === "generator") genAudio.fire();
  };
  await new Promise((resolve) => {
    mr.onstart = () => {
      meta.onstartT = performance.now();
    };
    mr.onstop = async () => {
      meta.onstopT = performance.now();
      running = false;
      await chain;
      resolve();
    };
    requestAnimationFrame(tick);
    const preStartMs = v.primeMs === undefined ? 500 : Math.max(v.primeMs, 50);
    if (v.primeMs > 0)
      setTimeout(() => {
        pushEnabled = true;
        meta.primeStartedT = performance.now();
      }, preStartMs - v.primeMs);
    setTimeout(() => {
      meta.startCalledT = performance.now();
      meta.drawsAtStart = meta.draws;
      pushEnabled = true;
      mr.start(1000);
      let timer = null;
      if (v.marker)
        setTimeout(() => {
          fire();
          timer = setInterval(fire, 2000);
        }, 2000);
      setTimeout(() => {
        clearInterval(timer);
        mr.stop();
      }, v.seconds * 1000);
    }, preStartMs);
  });
  stream.getTracks().forEach((t) => t.stop());
  if (genAudio) await genAudio.stop();
  if (bed) bed.stop();
  if (ac) await ac.close();
  await xp.end(meta);
  document.getElementById("s").textContent = `${v.name} done`;
}

(async () => {
  try {
    for (const v of await xp.plan()) await runVariant(v);
    xp.done({ ok: true });
  } catch (e) {
    xp.log({ error: e.message, stack: e.stack });
    xp.done({ error: e.message });
  }
})();
