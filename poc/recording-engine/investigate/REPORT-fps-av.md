# Investigation: FPS shortfall and A/V offset (2026-11-17)

Scope: read-only analysis of existing runs (mainly `20261117-214024-smoke`,
window capture, PRIVACY PASS) plus calculations. **No capture, no recording,
no app changes.**
Scripts: `investigate/fps-model.js`, `investigate/av-timing.js`.

Labels: **[M]** measured from run data · **[C]** calculated/simulated ·
**[H]** hypothesis.

---

## 1. FPS: 28.68 fps output vs. 30 fps target

### Root cause (confidence: **high**)
The copied app loop's **scheduling rule, quantized by the display refresh
rate**. It isn't a throughput bottleneck.

`src/renderer.js@6c3bf48` L207-216 draws on a `requestAnimationFrame` tick
only when `now - lastFrameTime >= 1000/30 - 2` (31.33 ms), then sets
`lastFrameTime = now`. rAF ticks arrive on vsync, so the draw interval
becomes the **smallest whole number of refresh periods ≥ 31.33 ms**.

### Evidence
| | Value |
|---|---|
| [M] Draw interval mode | **34.7 ms** (2,669 of 3,464 intervals, 77 %), = 5 × 6.944 ms at 144 Hz |
| [M] Draw intervals of ~41.7 ms (6 refreshes) | 419 (12 %): the occasional missed vsync |
| [M] rAF ticks per second | mean 140.5 (min 108, max 145) of 144 possible: ~2.4 % of vsyncs missed |
| [M] Draws per second / output fps | 28.71 / 28.68 |
| [M] Drawn frames missing from the file | 0.26 %: the encoder keeps up |
| [M] Screen video frames per second (rVFC) | 29.0: capture is not the limit |
| [C] Closed form, 144 Hz | 1000 / (⌈31.33 / 6.944⌉ × 6.944) = **28.80 fps** |
| [C] Simulation, 144 Hz, using the run's 2.4 % missed-vsync rate | **28.66 fps** (measured 28.68) |

### Model of the current loop ([C])
| Display | Refresh period | Draw interval | Expected fps | With 2.4 % missed vsyncs |
|---|---|---|---|---|
| 60 Hz | 16.67 ms | 2 → 33.33 ms | **30.0** | 29.6 |
| 75 Hz | 13.33 ms | 3 → 40.0 ms | **25.0** | 24.8 |
| 90 Hz | 11.11 ms | 3 → 33.33 ms | 30.0 | 29.8 |
| 100 Hz | 10.0 ms | 4 → 40.0 ms | **25.0** | 24.8 |
| 120 Hz | 8.33 ms | 4 → 33.33 ms | 30.0 | 29.8 |
| 144 Hz | 6.94 ms | 5 → 34.72 ms | **28.8** | 28.7 |
| 165 Hz | 6.06 ms | 6 → 36.36 ms | **27.5** | 27.4 |
| 240 Hz | 4.17 ms | 8 → 33.33 ms | 30.0 | 29.9 |

Only 60/90/120/240 Hz reach 30 fps, and only without missed vsyncs. Because
the loop sets `last = now`, every late tick permanently loses time; there's
no catch-up.

### Unknown
- Behaviour on a real 60/165 Hz display (only 144 Hz is available here).
- Whether the ~2.4 % missed vsyncs come from the test-screen's GPU load (the
  integrated GPU's 3D engine was at 79 % mean / 98 % peak across all
  processes).
- Minimized and background behaviour, which uses a separate `setInterval`
  path (Stage O4).

### Scheduling options ([C]/[H]; nothing implemented)
| Option | Expected fps | Cost | Notes |
|---|---|---|---|
| **A. Phase-keeping deadline in rAF**: draw on the first vsync at or after `deadline − T/2`, then `deadline += 33.33 ms`; resync after a long stall | [C] **30.0 at every refresh rate**, including with 2.4 % missed vsyncs | Same as now (one draw per output frame, +4 % draws vs 28.8) | Intervals alternate (e.g. 27.8/34.7 ms at 144 Hz). Timestamps follow draw time [M], so jitter is ±½ refresh period. **Recommended first.** |
| B. A + `canvas.captureStream(0)` + `track.requestFrame()` after each draw | 30.0 | Same | Frame emission becomes explicit, independent of the captureStream rate cap. Behaviour in Electron 33 unverified. |
| C. Timer-driven at 30 Hz (`setInterval`, or a worker timer) | ~30 | Fewer wakeups (30/s instead of 144/s) | Not vsync-aligned; could also replace the separate background path. Timer throttling must be measured (O4). |
| D. `requestVideoFrameCallback`-driven: draw when the screen or camera delivers a new frame | ≤ 30, variable frame rate | Lowest on static screens | Output fps drops on static content; needs a decision on VFR output. Open question. |

### Recommended next experiment (no desktop capture)
An offline synthetic-canvas run, like `selftest/encoder-selftest.js`,
comparing **current loop vs. option A**, each 60 s through the real
MediaRecorder. Measure output fps, interval distribution, missing frames and
renderer CPU. Repeat at 60 Hz if you switch the display's refresh rate in
Windows settings (your action; I can't change system settings). With
approval, a POC-only `--scheduler=deadline` flag for one window-capture
smoke run.

### Files that a later fix would touch
- App: `src/renderer.js` L206-223 (rAF loop + background interval);
  L403 (`canvas.captureStream(30)`) only for option B.
- POC mirror: `poc/recording-engine/recorder.js` (copied loop section).
- Docs: `docs/ARCHITECTURE.md` §3.4 (cadence), `docs/PROJECT-STATUS.md`
  §1.2/§2.4.

---

## 2. A/V offset: audio ~42 ms after video

### Most likely explanation (confidence: **medium**)
The file is internally consistent. Each track's timeline faithfully follows
its own clock. The **±4 ms variation is marker instrumentation** (high
confidence). The **constant ~42 ms is the gap, on the file timeline, between
"AudioContext time read when the flash is drawn" and "the flash draw
time"**. Whether that gap is a real recording-pipeline misalignment or the
marker tone genuinely being produced ~42 ms later in real time **can't be
decided from the logged data** (see Unknown).

### Evidence
| | Value |
|---|---|
| [M] Video file pts vs renderer draw time, all 3,447 frames | slope **1.000000**, residual spread **2.9 ms** (−0.9…+2.0). Video timestamps = draw time + constant. The flash frame residual is +0.28 ms mean |
| [M] Tone onset pts vs scheduled `AudioContext.currentTime` | constant within **0.07 ms** for 11 of 12 markers (one +8 ms outlier). The audio track follows the AudioContext sample clock exactly |
| [M] `currentTime` read at draw vs renderer draw time | spread **7.8 ms**. This alone explains the offset's 37.9–46.9 ms range |
| [M] Mean offset, two independent runs | **41.87 ms** (022724) and **42.07 ms** (214024) |
| [M] Drift trend | +0.15 ± 1.18 and −1.79 ± 1.58 ms/min: **not significant** in 2-minute runs |
| [M] Audio clock vs renderer clock | +0.8 ± 15.9 ppm and −48.5 ± 18.7 ppm: inconclusive |
| [M] AudioContext at pre-check | `baseLatency` 10 ms; `currentTime` did not advance during the 250 ms pre-check (render start lag) |

### Answers to the questions
1. **Does the marker add scheduling delay?** **Yes, jitter: [M].**
   `beep()` calls `osc.start(audioContext.currentTime)`, meaning "as soon as
   possible". `currentTime` as seen from the main thread advances in steps of
   about one render callback (`baseLatency` 10 ms), so the real-time moment
   the tone starts varies by about 8 ms relative to the flash draw. Whether
   the marker also adds a **constant** real-time delay is **[H], unknown**.
2. **Different time origins?** **Yes: [M].** Video timestamps follow the
   renderer/compositor clock (`performance.now`-based draw time). Audio
   follows the AudioContext sample clock. MediaRecorder aligns them once, so
   any constant difference between "audio produced" and "audio stamped" stays
   constant. The rate difference between the clocks is within measurement
   noise over 2 minutes.
3. **Real file sync or instrumentation error?** **Both, partly.**
   - The ±4 ms variation is instrumentation ([M]).
   - The 42 ms constant is either:
     - (a) a real pipeline delay on the audio path (WebAudio
       render-ahead/FIFO between the graph and the MediaStream; 2048 samples
       at 48 kHz = 42.7 ms, a suggestive but unproven match); or
     - (b) the marker tone genuinely being rendered ~42 ms after the flash
       draw.

     If (a), it would also apply to the app's PC-microphone audio, which
     passes through the same `AudioContext → MediaStreamDestination` path
     ([H]). Its sign and size for a real mic are **unverified**.
4. **Independent measurement:** see next.

### Proposed measurement method
**M1: separate instrumentation from pipeline, offline, no capture, no mic
([recommended next]).** Synthetic canvas plus WebAudio into the real
MediaRecorder, like the encoder self-test.
- Generate the tone in an **AudioWorklet** at a known sample frame. The
  worklet posts `{frame, currentTime}` when it renders that first sample.
  The main thread logs the receipt time plus
  `audioContext.getOutputTimestamp()`, `outputLatency` and `baseLatency`.
- Then **draw the flash on the next frame after receipt**, so the real-time
  order is "audio rendered, then flash drawn", with both times known in
  `performance.now`.
- Expected file offset if the pipeline is aligned:
  −(draw time − render time). Any remainder is pipeline misalignment.
- Repeat with `latencyHint` `interactive` / `balanced` / `playback`. If the
  constant scales with buffer size, the cause is buffering ([H] test).
- Emit a marker every 2 s instead of 10 s, giving 30+ points per minute for
  drift.

**M2: true end-to-end, later, requires approval of microphone use.** One
physical event recorded by the real PC mic and the window capture (a
synthetic window flash plus a speaker click, with the pattern process
logging `getOutputTimestamp` to compensate speaker latency). It must also
be repeated with the **real phone camera**.

**M3: camera path latency, loopback now, real phone later.** Log the
test-window camera frame draw time as an epoch time
(`performance.timeOrigin + now`) in the pattern process. Compare it with the
recorder's draw time for the output frame showing that camera barcode.
- Rationale ([H]): for V1 (PC mic + phone PiP), the **phone video's
  WebRTC/jitter-buffer latency** (typically far above 42 ms) is likely the
  dominant lip-sync risk, and nothing measures it today.

### Unknown
- Whether 42 ms is pipeline or marker (M1 decides).
- Real-mic offset (M2).
- Camera latency (M3).
- Drift over 30 minutes (soak run, or M1 with dense markers).
- The +8 ms outlier on marker 10 (one Opus frame boundary? [H]).

### Files that a later change would touch
- POC instrumentation (next experiment):
  - `poc/recording-engine/recorder.js` (marker → AudioWorklet, clock logs)
  - new `poc/recording-engine/marker-worklet.js`
  - `poc/recording-engine/analyze.js` (decomposition)
  - `poc/recording-engine/pattern.js` + `main.js` (M3 camera epoch logging)
  - an offline variant in `poc/recording-engine/selftest/`
- App, **only if** M1/M2 confirm a constant pipeline offset (no fix proposed
  yet):
  - `src/renderer.js` L404-437 (audio graph / AudioContext options)
  - `src/main.js` L48-128 and L327-400, if compensation were done by shifting
    audio timecodes during finalization (EBML rewrite, like
    `addWebmDuration`)
- Docs: `docs/PROJECT-STATUS.md` (§2.5, §3), `docs/V1-SPECIFICATION.md`
  untouched unless a decision changes.

---

## Limitations of this investigation
- One machine: 144 Hz, Intel + NVIDIA hybrid, window capture, synthetic
  instrumented content.
- A/V evidence comes from 2 runs × 11–12 markers.
- The test-screen app loads the same integrated GPU.
- Nothing here validates macOS or full-display capture.

---

## 3. Experiment results (offline, 2026-11-17 22:00)

Harness: `investigate/offline-experiments.js` (+ `exp-page.js`,
`marker-worklet.js`); analysis: `investigate/analyze-experiments.js`,
`investigate/drop-pattern.js`.
- **Synthetic canvas and synthetic WebAudio only.** No capture, no
  microphone, no camera. The harness denies all display-media and `media`
  permission requests.
- Real Chromium MediaRecorder: H.264 in WebM, 8 Mbps, 1 s chunks; the app's
  audio structure (AudioContext → MediaStreamDestination → track added to
  `canvas.captureStream(30)`).
- 144 Hz display; Electron 33.4.11.
- Outputs: `%USERPROFILE%\Videos\CamShare-POC\experiments-20261117-220036\`.

### 3.1 FPS: current loop vs. option A (fixed 30 fps schedule), 60 s each
| [M] | Current app loop | Option A |
|---|---|---|
| Draws per second | **28.80** (= calculated 28.8) | **30.00** |
| Draw interval p50 / min / max | 34.7 / 28.1 / 48.2 ms | 34.7 / 25.8 / 37.1 ms (alternating 27.8 / 34.7) |
| Output fps (file, after 2 s) | 27.81 | **30.00** |
| Drawn but missing from file | 117 (60 consecutive in the first 2 s = start-up stall, then ~1 per s) | **0** |
| Largest frame gap | 2,118 ms (start-up stall) | **37 ms** |
| Renderer-app CPU, whole machine | 2.33 % | 2.40 % (+0.07 points ≈ the extra 4 % of draws) |
| Video pts vs draw time | slope 1.000000, ±0.6 ms | slope 1.000000, ±0.6 ms |

**But (measured):** the four A/V runs below also used option A, and lost
**118–184 drawn frames (10–15 %)**, giving output fps of only **25.5–27.1**.
- The drops are single frames, evenly spread (~4–5 per s), and **61–86 %
  of them follow a short (< 28.5 ms) draw interval**.
- In the FPS run, 342 short-interval frames were all kept.
- [H] That frames following a short interval get dropped is consistent with
  `canvas.captureStream(30)`'s internal 30 fps rate cap. Why it applied in
  the A/V runs but not in the FPS run is **unknown**. Differences: those runs
  had an explicit AudioContext `latencyHint` and/or a worklet, and they ran
  later in the same process.

**Conclusion (FPS):**
- The current loop's 28.8 draws/s is **confirmed** (measured = calculated).
- Option A fixes the draw rate (30.00/s at no meaningful CPU cost), and in
  one 60 s run also the output.
- Option A is **not yet proven** to give 30 fps output reliably, because its
  short intervals can be discarded by the capture/recorder. The start-up
  stall (2 s, first recording in a fresh process) is a separate finding;
  the cause is unknown ([H]: H.264 encoder initialisation).

**Next experiment (offline, same harness):**
- Option B: `captureStream(0)` + `track.requestFrame()` after every draw,
  which removes the 30 fps cap.
- Option A vs B with variant order randomised and each condition repeated
  ≥ 3×, with and without an explicit `latencyHint`.
- A 10 s warm-up recording before measured runs, to separate the start-up
  stall.

### 3.2 A/V: AudioWorklet marker vs. old marker
D = tone onset in file − (video timeline position of the main-thread time
the worklet reported rendering the tone). The receipt time is ≥ the render
time, so the true value is ≥ D.

| [M] | latencyHint | outputLatency | **D (audio placed late vs. its render time)** | File offset (tone − flash) | Draw lag (flash after render) |
|---|---|---|---|---|---|
| Worklet | interactive | 42 ms | **48.1 ms** (46.4–48.9) | 27.3 ms | 20.9 ms |
| Worklet | balanced | 42 ms | **48.0 ms** (47.1–48.8) | 23.5 ms | 24.4 ms |
| Worklet | playback | 52 ms | 41.6 ms (36.1–57.3, **drifting** +1.25 ms per 2 s) | 28.8 ms | 12.9 ms |
| Old marker (POC method) | interactive | 48 ms | **49.3 ms** (48.2–49.7) | 49.2 ms | — |

Also measured: `currentTime − getOutputTimestamp().contextTime` = 42.3–42.6 ms
(interactive/balanced), 50.8 (playback), 58.9 (old-marker run), tracking
the reported `outputLatency`.

**Conclusion (A/V): the ~42–49 ms offset is real pipeline behaviour, not
marker error (confidence: high for this synthetic path).**
- With the marker's scheduling taken out (the worklet reports the actual
  render moment), audio produced in the WebAudio graph is still placed
  **≈ 48 ms later** in the file than video drawn at the same instant. Video
  timestamps equal draw time (±0.6 ms).
- The old marker reproduces the same ≈ 49 ms. The ±4 ms jitter seen in the
  smoke runs is the old marker's scheduling.
- [H] Mechanism: audio leaving `MediaStreamDestination` is timestamped
  around its *estimated playout time* (render time + output-device latency
  ≈ 42 ms + a few ms), while canvas frames are stamped at draw time.
  Supported by D ≈ outputLatency + 6 ms for interactive/balanced; not
  consistent for `playback` (lower mean, drifting). Mechanism confidence:
  medium.
- `latencyHint: "playback"` gives an unstable offset (drift ~37 ms/min in
  this run) and shouldn't be used.

**What this means for the app ([H], untested):** the app routes the PC
microphone through the same AudioContext → MediaStreamDestination path, so
mic audio would likely be placed ≈ 48 ms late as well, plus the mic's own
input latency, partly offset by screen-capture latency on the video side.
The real end-to-end offset still needs M2, which requires microphone
approval.

V1 records **PC mic only**, with no mixing needed, so adding the mic track
directly to the recorded stream, bypassing WebAudio, is a candidate that
might remove this offset. Unverified.

**Next experiments:**
- **(a)** Offline: same harness, record audio from an `AudioWorkletNode`
  versus a direct, non-WebAudio synthetic track (e.g. a
  `MediaStreamTrackGenerator` audio track, if available in Chromium 130) to
  test the bypass idea without a mic.
- **(b)** M3 camera latency in loopback.
- **(c)** M2 with a real mic, separate approval.

### Files a later fix would touch (unchanged from §1/§2)
- **FPS:** `src/renderer.js` L206-223 (loop); L403 if option B
  (`captureStream(0)` + `requestFrame`).
- **A/V:** `src/renderer.js` L404-437 (audio routing: direct mic track
  instead of the WebAudio mix when there is a single source; V1 = PC mic
  only), or audio-timestamp compensation in `src/main.js` finalization
  (L327-400, EBML rewrite).
- POC mirrors: `poc/recording-engine/recorder.js`, `analyze.js`.

---

## 4. Follow-up experiments (offline, 2026-11-17 22:10)

Same harness (synthetic canvas and audio only; no capture, no microphone),
`XP_PLAN=followup`. Outputs:
`%USERPROFILE%\Videos\CamShare-POC\experiments-followup-20261117-221023\`
(`experiments-results.json`).

Design:
- a 10 s warm-up recording, discarded;
- 4 conditions × 3 repeats × 30 s, in seeded random order
  (warmup, B-plain-r3, B-avlike-r1, A-avlike-r1, B-avlike-r3, B-plain-r1,
  A-plain-r2, A-avlike-r3, A-plain-r3, A-avlike-r2, A-plain-r1, B-avlike-r2,
  B-plain-r2);
- then two direct-audio-track runs.

Condition definitions:
- **A** = fixed 30 fps schedule + `canvas.captureStream(30)`
- **B** = fixed 30 fps schedule + `canvas.captureStream(0)` +
  `track.requestFrame()` after every draw
- **plain** = default AudioContext, bed tone only
- **avlike** = `latencyHint: "interactive"` + AudioWorklet markers every 2 s

### 4.1 FPS (measured)
| Condition | Output fps per run | Drawn but missing per run | Largest gap | CPU (whole machine) |
|---|---|---|---|---|
| **B-plain** | **30.00, 30.00, 30.00** | **0, 0, 0** | 37–52 ms | 2.41 % |
| **B-avlike** | **30.00, 30.00, 30.00** | **0, 0, 0** | 36–37 ms | 2.45 % |
| A-plain | 30.00, 28.24, 25.29 | 0, 54, 155 | 37–597 ms | 2.30 % |
| A-avlike | 30.00, 26.95, 25.73 | 0, 92, 127 | 37–69 ms | 2.31 % |

- **Option A's drops are intermittent and don't depend on the audio
  setup.** Four of its six runs dropped 54–155 frames, in both plain and
  avlike. Good and bad A runs are interleaved with perfect B runs, so it
  isn't an order or degradation effect.
- **Option B: 6 of 6 runs at 30.00 fps with zero drawn frames missing.**
  This confirms [H] that `captureStream(30)`'s internal rate cap discards
  frames drawn after a short (~27.8 ms at 144 Hz) interval. Explicit
  `requestFrame()` removes that.
- Cost: +0.1 point of whole-machine CPU vs A, the same per drawn frame.
- **Start-up stall reproduced:** the first recording in the fresh process
  (the warm-up run) lost 66 frames, with a 2,236 ms gap; later runs didn't.
  The first experiment session showed the same (2,118 ms). The window-capture
  smoke run (also the first recording in its process) did **not** show it
  (296 ms start delay, largest gap 71 ms). Cause unknown;
  harness-specific vs. app-relevant is **unverified**.

**FPS conclusion (confidence: high for this synthetic path on this
machine):** a fixed 30 fps schedule **combined with explicit frame
emission** (`captureStream(0)` + `requestFrame()`) delivers a steady 30 fps
with no dropped frames. The app's current loop is capped at 28.8 fps on
144 Hz (§1, §3.1). Neither change alone is sufficient:
- the fixed schedule alone suffers random drops (A);
- the app loop + `requestFrame` was not tested; it would still draw only
  28.8 per second.

Not yet validated:
- other refresh rates;
- window or screen capture as the source;
- minimized or background behaviour (O4);
- long runs (O5).

### 4.2 A/V (measured)
- `AudioContext → MediaStreamDestination` path, `latencyHint` interactive,
  6 runs × 14 markers: **D = 48.0–48.7 ms** (per-run means; per-marker range
  47.6–49.0). Together with §3.2 (48.1 / 48.0 ms): **8 of 8 runs at ≈ 48 ms,
  spread < 1 ms between runs.** Audio produced in the WebAudio graph is
  consistently placed ≈ 48 ms late relative to video drawn at the same
  instant.
- **Direct-track bypass test: inconclusive.** With a `MediaStreamTrackGenerator`
  audio track (AudioData, no WebAudio), MediaRecorder in Chromium 130 wrote
  **no video packets at all**: 0 video and 500 audio packets, under both
  timestamp modes (performance-based and counter). The generator path
  doesn't work as a stand-in for "a mic track without WebAudio", so the
  bypass hypothesis is **still untested**.

### 4.3 Updated recommendations
- **FPS:** candidate fix = fixed 30 fps schedule + `captureStream(0)` +
  `requestFrame()`.
  - Next: a POC-only flag in `recorder.js` for one window-capture smoke run.
    Needs approval; it changes only `poc/recording-engine/recorder.js`.
  - Later, if approved: `src/renderer.js` L206-223 (loop and background
    path) and L403 (`captureStream`).
- **A/V:** treat **≈ 48 ms audio-late** as a real property of the WebAudio
  recording path in Electron 33 on this machine. Two ways to test a
  bypass:
  - **(a)** without a mic: an `<audio>` element playing a generated tone
    file, captured with `audio.captureStream()`, so the track avoids
    `MediaStreamDestination`. Its own playback pipeline will add latency,
    so it is only a partial proxy.
  - **(b)** with a real PC mic (M2): mic track routed directly vs through
    WebAudio, with an audible click + flash. **Requires microphone
    approval.**

  If the bypass removes the offset, the V1 fix candidate is to record the
  PC-mic track directly (V1 is PC-mic-only, so no mixing is needed):
  `src/renderer.js` L404-437. Otherwise: timestamp compensation at
  finalization in `src/main.js` (L327-400).

---

## 5. Window-capture smoke with option B (`--scheduler=optionB`), 2026-11-17 22:22

Run `20261117-222217-smoke-optionB`: the same verified window capture and
privacy checks as `20261117-214024-smoke`. Fresh Electron process, no
warm-up. **PRIVACY: PASS** (0 of 3,603 frames failed; target verified).

| [M] | 214024 (app loop + `captureStream(30)`) | **222217 (option B)** |
|---|---|---|
| Output fps (≥ 29) | 28.68 FAIL | **29.98 PASS** |
| Frames vs 30 fps × length (≥ 99 %) | 95.56 % FAIL | **99.38 % PASS** |
| Drawn but missing (≤ 1 %) | 0.26 % | 0.55 % PASS: **all 20 at start-up** |
| Gaps ≤ 50 ms (≥ 99 %) | 99.68 % PASS | **94.64 % FAIL** |
| Largest gap (≤ 200 ms) | 71 ms PASS | **693 ms FAIL** (right after the first frame); 103 ms afterwards |
| Screen / camera freshness (≥ 95 %) | 97.4 / 98.1 % PASS | **89.5 / 90.1 % FAIL** |
| Draws per second | 28.71 | 29.98 |
| rAF ticks per second | 140.5 (min 108) | **104.4 (min 28)** |
| Draw intervals < 20 ms / > 50 ms | rare | **250 / 195** of 3,634 |
| Start: first file frame after `start()` / `onstart` | 296 / 540 ms | 314 / **1,230 ms**, then a 693 ms hole |
| Recorder CPU (whole machine) | 12.06 % (1.93 cores) | **14.5 % (2.32 cores)** |
| Recorder GPU 3D / VideoDecode | 33.5 / 14.7 % | **42.7 / 20.5 %** |
| Test-screen GPU 3D / all-process 3D | 37.2 / 78.8 % | 39.9 / **91.4 %** (max 98.4) |
| A/V offset mean / max (≤ 40 ms) | 42.0 / 46.9 FAIL | 40.6 / 43.9 FAIL |
| A/V drift / audio start / coverage | −3.7 ms / −19 ms / 100.05 % | 5.3 ms / +8 ms / 100.04 % |
| Duration metadata vs video / video vs recorder | +0.32 / −0.31 s | +0.41 / −0.39 s |
| Decode errors / timestamps / seek | 0 / ok / 3 of 3 | 0 / ok / 3 of 3 |

### Interpretation
- **[M]** Option B fixes the *average*: 30 draws per second and 29.98 fps
  in the file.
- **[M]** Option B degraded *regularity*. The integrated GPU's 3D engine was
  near saturation (91 % mean across processes), and rAF ticks fell to 104/s
  with seconds as low as 28/s. The fixed schedule then catches up with
  closely spaced draws after late ticks. That gives the bimodal
  intervals, which fail the ≤ 50 ms gap share. Two draws a few ms apart
  show the same screen/camera frame, which lowers the freshness figures.
- **[H]** The added GPU/CPU load (recorder 3D +9 points, CPU +0.4 cores)
  comes from the `requestFrame()` capture path, not only from the +4 %
  draws. The offline experiments didn't measure GPU, so this is
  **unverified**.
- **[H]** The POC's own test window (≈ 40 % GPU 3D on the same integrated
  GPU) made the contention worse. In the real app this load wouldn't exist,
  but a busy real screen could create similar contention. Unverified.
- **[M]** Cold start: `onstart` fired 1,230 ms after `start()`. The first
  frame was written, then 20 frames (693 ms) were lost before steady
  output. It wasn't hidden by a warm-up. Previous window run: 540 ms, no
  hole.
- **A/V:** unchanged audio pipeline. Offset 40.6 ms mean (max 43.9) still
  fails the 40 ms limit. This matches the ≈ 40–48 ms WebAudio placement
  delay found in §3–4.

### Does option B meet the FPS acceptance criteria?
**Partly.** Mean fps (O1.fps), frame count (F.frames) and missing frames
(O1.missing) pass. Gap regularity (O1.gaps), the largest gap (O1.maxgap,
from the cold-start hole) and screen/camera freshness fail. So it doesn't
meet all FPS-related criteria in this run.

### Candidate next steps (not run; need approval)
1. Offline, with typeperf GPU sampling: GPU/CPU cost of
   `captureStream(0)` + `requestFrame()` vs `captureStream(30)` at the same
   30 draws per second.
2. A smoother scheduler that never draws less than ~0.75 × 33.3 ms after
   the previous draw (skip instead of catching up), which limits bursts
   under GPU contention.
3. Cold start: emit a few frames before `MediaRecorder.start()`, or start
   the recorder only after the first `requestFrame()` frame is delivered.
   Measure the hole with a fresh process again.
4. Repeat under lower test-screen GPU load, to separate the POC's own load
   from the recorder's.

---

## 6. Offline follow-ups after the option B smoke (2026-11-17 22:30)

Synthetic canvas and audio only; no capture, no microphone. Outputs:
`%USERPROFILE%\Videos\CamShare-POC\experiments-followup2-20261117-222950\`
(`session\`, `cold-*-N\`, each with `experiments-results.json`).

Conditions:
- **Warm session:** a warm-up recording, then 6 conditions × 2 repeats × 20 s
  in seeded random order.
- **GPU sampling:** typeperf, one sampler per run, started after that run's
  processes exist; the first 2 s of each run are excluded.
- **Synthetic GPU load:** a separate Electron process drawing a busy
  1280×720 canvas, not captured.
- **Cold start:** 6 fresh Electron processes, each recording once (10 s).

### 6.1 GPU/CPU cost of explicit frame push, and the smoother scheduler (warm, measured)
| Condition | Output fps | Gaps ≤ 50 ms | Missing | Draw intervals < 20 / > 50 ms | rAF/s | CPU (machine) | GPU 3D: experiment / all processes |
|---|---|---|---|---|---|---|---|
| A30 (fixed schedule + `captureStream(30)`) | 27.9 | 84–100 % | 0–84 | 0 / 0 | 144 | 2.34 % | 13.2–14.4 % / 13–14 % |
| **B** (fixed schedule + `requestFrame`) | **30.00** | **100 %** | **0** | 0 / 0 | 144 | 2.45 % | 14.4 % / 14.4–14.7 % |
| **Bs** (smoothed + `requestFrame`) | **30.00** | **100 %** | **0** | 0 / 0 | 144 | 2.44 % | 14.4 % / 14.4–14.5 % |
| A30 + load | 27.6 | 82–99 % | 5–91 | 0 / 0 | 144 | 4.62 % | 15.0–16.0 % / 60–62 % |
| **B + load** | **30.01** | **100 %** | **0** | 0–1 / 0–1 | 144 | 4.90 % | 16.1–16.4 % / 61–63 % |
| **Bs + load** | **30.01** | **100 %** | **0** | 0 / 0 | 144 | 4.87 % | 16.1–16.5 % / 62–63 % |

CPU with load includes the load process's share of the Browser-side
metrics; the load process has its own processes.

- **[M] `requestFrame()` is not expensive:** about +0.4 points of GPU 3D
  and +0.1 points of CPU vs `captureStream(30)`, at the same 30 draws per
  second. The **[H] in §5** (that the explicit-push path caused the smoke
  run's +9-point recorder GPU rise) is **not supported**. That rise remains
  **unexplained**: the offline test doesn't decode or draw video sources,
  and the smoke-run difference may be run-to-run or contention-related.
- **[M] A30 drops frames again** in 3 of 4 runs, with or without load. This
  confirms the `captureStream(30)` rate-cap problem (§4).
- **[M] Contention jitter was not reproduced.** The synthetic load raised
  total GPU 3D only to ~62 %, not the smoke run's 91 %, and rAF stayed at
  144/s. So B never jittered, and **the smoother scheduler's benefit is
  untested** (it behaved identically to B without stress).
- **[H] remaining:** the smoke-run jitter appears only when the integrated
  GPU approaches saturation (~90 %+) and rAF drops (104/s). This needs a
  heavier load to test offline.

### 6.2 Cold start (fresh process, first recording, measured)
| Trial | `onstart` after `start()` | Hole after first frame (largest gap, first 3 s) | Frames missing (first 3 s) |
|---|---|---|---|
| baseline 1 / 2 / 3 (push from `start()`, as POC) | 2,240 / 2,306 / 1,545 ms | **1,834 / 1,931 / 1,167 ms** | 54 / 57 / 34 |
| prime 500 ms 1 / 2 / 3 | 1,024 / 2,292 / 1,012 ms | **632 / 1,903 / 597 ms** | 18 / 56 / 17 |

- **[M] The cold-start hole is real and consistent** in fresh processes
  (≈ 0.6–1.9 s; 17–57 frames). The first frame is always written
  (~0.31–0.33 s after `start()`). Then nothing arrives until shortly after
  `onstart`, and the hole closes ≈ 0.4 s after `onstart`.
- **[M] Priming 500 ms helps in 2 of 3 trials** (hole ~0.6 s instead of
  ~1.2–1.9 s) but not reliably.
- **[M] Earlier contrast:** the app-loop window-capture smoke (fresh
  process, `captureStream(30)`) had `onstart` at 540 ms and no hole. The
  option B smoke had 1,230 ms and a 693 ms hole. The offline rate30 warm-ups
  also had 2.1–2.2 s holes. Which conditions avoid the hole is
  **unknown**.
- **[H]** Encoder/recorder initialisation for the first recording in a
  process blocks frame delivery until about `onstart`. Unverified.

### 6.3 Conclusions so far
- **FPS:** the fixed 30 fps schedule + `captureStream(0)` +
  `requestFrame()` (B or Bs) gives 30.00 fps with zero drops at negligible
  extra cost, warm and under moderate GPU load. Under near-saturated GPU
  (smoke, 91 %) it showed jitter; whether Bs fixes that is untested.
- **Cold start:** an independent issue affecting the first recording in a
  process, with any capture mode. 0.6–1.9 s of frames can be missing right
  after the first frame. **App-relevant candidates [H], not tested:**
  - keep the UI in *Preparing* until `onstart` / the first chunk arrives,
    so the user doesn't believe recording started earlier;
  - pre-initialise the recorder once at app launch (a deliberate,
    *reported* pre-warm, not hidden in measurements).
- **A/V:** unchanged (≈ 40–48 ms audio late via the WebAudio path).

### Next experiments (need approval)
1. A heavier synthetic GPU load (≥ 90 % total 3D) to reproduce the
   contention jitter offline and compare B vs Bs.
2. Cold-start mitigations offline in fresh processes, ≥ 5 trials each:
   a 1–2 s priming push; waiting for `onstart` before the "recording" state;
   a throwaway recorder at process start (reported pre-warm).
3. Then one window-capture smoke with Bs (+ the chosen cold-start handling).

---

## 7. Heavy-load and cold-start experiments (offline, 2026-11-17 22:40)

Synthetic canvas and audio only; no capture, no microphone. Outputs:
`%USERPROFILE%\Videos\CamShare-POC\experiments-followup3-20261117-223937\`
(`calibration*`, `session`, `cold-*-N`).

### 7.1 Load calibration (measured; typeperf, all-process GPU 3D)
- The 2D-canvas load levels reached at most ≈ 44–50 %: heavier 2D levels
  with blur became CPU-bound and loaded the GPU *less*.
- A WebGL full-window fragment-shader load (level 5) held the GPU at
  ≈ 97 % 3D (peaks 98–102 %). Levels 6–8 were no higher. Level 5 was used.

### 7.2 B vs. Bs under near-saturating GPU load (warm, 3 runs each, seeded order)
| Run | Output fps | Gaps ≤ 50 ms | Missing | Largest gap | Draw intervals < 20 / > 50 ms | rAF/s | GPU 3D: experiment / all |
|---|---|---|---|---|---|---|---|
| B r1 / r2 / r3 | 30.01 / 30.01 / 30.01 | 100 % | 0 / 0 / 0 | 38 / 48 / 37 ms | 0–1 / 0 | 140–141 | 17.5 % / **98.7–98.9 %** |
| Bs r1 / r2 / r3 | 30.01 / 30.01 / 30.01 | 100 % | 0 / 0 / 0 | 39 / 37 / 38 ms | 0 / 0 | 141 | 17.4 % / **98.5–98.8 %** |

- **[M] GPU saturation alone does NOT reproduce the window-capture smoke
  jitter.** At ~98.7 % total GPU 3D, rAF stayed at ~141/s, and both
  schedulers delivered 30.00 fps with 0 drops and 100 % of gaps ≤ 50 ms.
- **The §5/§6 hypothesis is falsified for this load type.** The smoke
  jitter (rAF 104/s, min 28/s) has another cause, still **unknown**.
- **[H] candidates:**
  - drawing **live video sources** (window-capture stream + WebRTC camera:
    texture uploads and decode, which the offline harness doesn't have);
  - the window-capture pipeline itself;
  - the POC test window's own 2D drawing (CPU-side).
- Bs vs B: indistinguishable, because there was still no jitter to smooth.

### 7.3 Cold start: 5 fresh processes per mitigation (measured)
| Mode | `onstart` after `start()` (median, range) | Gap after first frame (median, range) | Frames lost, first 3 s | Frames lost after `onstart` |
|---|---|---|---|---|
| Baseline (push from `start()`, as POC) | 1,234 ms (1,071–2,257) | **834 ms** (667–1,869) | 19–55 | **0 in 5/5** |
| Prime 1.5 s before `start()` | 1,044 ms (959–1,747) | 632 ms (569–1,333) | 16–39 | 0 in 5/5 |
| **Pre-warm** (throwaway 1 s recording first, reported) | **222 ms** (220–243) | **36 ms** (36–37, = normal frame spacing) | **0 in 5/5** | 0 in 5/5 |

The pre-warm itself, measured and **not hidden**, took 1.00–1.01 s. Its
own `onstart` arrived 0.66–1.01 s after its `start()`.

- **[M] Once `onstart` has fired, no frames are lost** (0 in all 15
  trials). The loss lies entirely between `start()` and `onstart`. The
  file then holds the first frame (at ~0.31 s) followed by a frozen gap.
- **[M] Priming only shortens the gap a little** (median 632 vs 834 ms).
  It isn't sufficient.
- **[M] A one-off pre-warm recording removes the gap completely** in 5/5
  fresh processes. The cost (~1 s, first recorder initialisation) moves
  to a controllable moment before the user's recording.
- **[H]** The first MediaRecorder/encoder initialisation in a process
  blocks frame delivery until about `onstart`. Later recorders in the same
  process start in ~0.22 s.

### 7.4 Updated conclusions
- **FPS:** a fixed 30 fps schedule + `captureStream(0)` + `requestFrame()`
  (B; Bs equivalent so far) is robust offline: 30.00 fps, 0 drops, at idle
  and under ~99 % GPU load. The remaining window-capture jitter is **not
  explained by GPU saturation**. It must be investigated with live video
  sources.
- **Cold start:** candidate handling for the app, **not implemented**:
  - **(1)** initialise the recorder once ahead of time (a reported
    pre-warm, e.g. at app launch or on entering *Preparing*);
  - **(2)** treat the recording as started only at `onstart` (spec
    lifecycle: stay in *Preparing* until then).

  (1) removes the gap; (2) alone avoids losing frames after the user sees
  "Recording" but leaves a frozen first frame in the file.
- **A/V:** unchanged (≈ 40–48 ms, WebAudio path).

### Next experiments (need approval)
1. **Offline, closer to the smoke:** draw live `<video>` sources into the
   canvas:
   - a synthetic `MediaStream` from a second canvas (stand-in for the
     window capture);
   - the WebRTC loopback camera, as in the POC.

   Compare B vs Bs, with and without heavy load, to reproduce the jitter
   without capture.
2. **One window-capture smoke** with Bs + a reported pre-warm. It needs
   approval because it captures (the verified test window only).
