# CamShare Recording Engine POC (Phase 1)

An isolated harness that tests whether **Electron 33 + Canvas + MediaRecorder**
can reliably record Screen + Camera, using **window capture of a synthetic test
window** as the screen source; full-display capture is not validated (spec:
[V1-SPECIFICATION.md §3, §5](../../docs/V1-SPECIFICATION.md)).

- **Windows only.** Nothing here validates macOS.
- It is **not** the app. It never touches `src/`, `package.json`, or the build;
  electron-builder only packages `src/**`, so this folder never ships.
- It runs with the repo's installed Electron (`npx electron`, 33.4.11 /
  Chromium 130). There is no rebuild and no new dependency.

## Provenance of copied code

The pipeline is copied from commit
`6c3bf48a75025c9107729f56d2d01812bbf33ae3`. When copied (2026-11-17), these
files were unmodified in the working tree:

| Source | sha256 | Copied into |
|---|---|---|
| `src/main.js` | `dca804d77bd10d8a73d7370adffa208f9b03d828f3aacf8b44e0a73b309c9824` | `main.js` (storage helpers L25-165, recording IPC L296-410, occlusion switch L166-169) |
| `src/renderer.js` | `3b5fe7e4e813b8b80a1bf979e6b8c6f57e6d75eb62db59c98ec14c41ff5c0176` | `recorder.js` (canvas sizing, `camLive`, `pipRect`, `renderFrame`, draw loop, answerer, `startRecording`, cleanup) |
| `server/public/m.html` | `8c85c6bb4eeb19a29a61ad133059cf4363e4a0f081b2741741c14c94c2da6c20` | `pattern.js` (phone-side offer + sender tuning) |

Copied blocks carry `COPIED FROM <file>@6c3bf48 La-Lb` comments. Changed lines
are marked `POC CHANGE` and added lines `POC ADD`. Every run re-hashes the
three source files and records any drift in `run.json` (`sourceCheck`).

### Deliberate differences from the app (`POC CHANGE`)

| Area | App | POC | Why |
|---|---|---|---|
| Capture source | Thumbnail picker of **screens** | **Window capture of the synthetic test window only**, explicitly selected and verified (see below) | Both full-display smoke runs captured a foreign app window |
| System audio | `audio: "loopback"` on Windows | Not requested | Never record the user's audio; V1 is PC-mic-only |
| Recorded audio | Screen audio + PC mic or phone mic | Synthetic 1 kHz marker tone only, same AudioContext → MediaStreamDestination path | A/V sync measurement without real audio |
| Camera | Phone over WebRTC via the Render server | Synthetic 1280×720 camera in a **separate Electron process**, over a local WebRTC loopback (IPC/TCP signaling, no STUN/TURN) | No phone, no server; real encode/decode path |
| Chromium switch | `disable-features=CalculateNativeWinOcclusion` | Same plus `WebRtcHideLocalIpsWithMdns` | The loopback uses plain host candidates |
| Low-disk prompt | `confirm()` | Logged, continues | Unattended |
| Autoplay | Needs the Record click | `autoplayPolicy: no-user-gesture-required` | Starts AudioContext without a click |
| Display sleep | Not blocked | `powerSaveBlocker("prevent-display-sleep")` during the run | Sleep is unsupported in V1 and would void a run |
| Stamps | None | Frame barcodes and an A/V flash box in the top 96 px of the output | Measurement |

PiP changes are applied by mutating `S.pip`, the same state the app's drag,
wheel, and slider handlers mutate. Pointer events themselves are not exercised.

## Capture mode: window capture (since 2026-11-17)

> **Limitation.** Runs from this version on validate the recording engine
> (compositor, MediaRecorder, IPC/storage, A/V, PiP) with a **window** source.
> They do **not** validate full-display (screen) capture: its cost, frame
> delivery, multi-monitor/DPI behaviour, or what a real screen capture contains.

Why: both full-display smoke runs (`20261117-021546-smoke`,
`20261117-022724-smoke`) captured a foreign app window that came in front of
the always-on-top pattern window. alwaysOnTop, focus, and window position are
**not** privacy safeguards and are not relied on.

### How the target window is selected (main process, `installDisplayMediaHandler`)

1. The **recorder** generates a per-run nonce and passes it to the pattern
   process (`--nonce`). The pattern window's title is
   `CamShare POC pattern <nonce>`, and the pattern process exits if the
   nonce is missing. It reports `getMediaSourceId()`,
   `getNativeWindowHandle()` (HWND) and its title over the local TCP control
   channel.
2. `desktopCapturer.getSources({ types: ["window"] })` is the only source
   query. Screens are never listed or granted.
3. The decision is the pure function `decideCaptureSource()` in
   `capture-target.js`. A source is granted only if **all** of these hold:
   - the target HWND is numeric;
   - the HWND inside `getMediaSourceId()` equals it;
   - the title the pattern process reports equals the recorder's expected
     title;
   - exactly one listed source has the form `window:<HWND>:<n>` with that
     HWND;
   - that source's name equals the expected title, and the title is unique.

   Measured on Electron 33.4.11 (cross-process): `getMediaSourceId()`
   returns `window:<HWND>:1` while desktopCapturer lists `window:<HWND>:0`,
   so the HWND is the identity. A window of the *same* process isn't listed
   at all.
4. The handler's only grant is `cb({ video: src })` with that one source, and
   at most one grant is allowed per run. Every other outcome (including
   exceptions and second requests) calls `cb(null)` and ends the run as
   `capture-target-not-verified` before anything is recorded. There is no
   fallback to another window or a screen. Other windows' names are never
   logged.
5. Permission rule: the POC never calls getUserMedia. A `media` permission
   request is allowed only with **empty** `mediaTypes`, and denied when it
   names devices (`video`/`audio`).
   - Measured: `getDisplayMedia` itself raises a `media` request with empty
     `mediaTypes` before the handler runs. A blanket denial would block
     window capture.
   - **Not verified:** whether Electron reports the legacy
     `getUserMedia({chromeMediaSource:'desktop'})` request with non-empty
     `mediaTypes`. Testing it would require attempting a desktop capture,
     and the POC has no call site for it.

### Ready gate

- The renderer reports `ready` only after `verifyCapture()` succeeds.
  `startRecording()` refuses to run unless that verification succeeded.
- The main process starts recording only if **both** the selection record
  and the pixel-verification record are `ok`. Otherwise it ends the run as
  `capture-verification-failed`.

### How the captured pixels are verified (renderer, `verifyCapture`, before recording)

- The track must report `displaySurface: "window"`.
- The frame size must equal the test window's physical size.
- In 5 captured frames over about 1.2 s, the test window's barcode must
  decode and strictly increase (live content of *this* window). **All 458
  privacy canaries** (12×12 checker tiles every 64 px, drawn on top of the
  synthetic content) must be intact.
- The recorder window overlaps the test window on screen, so the canary check
  also proves that an overlapping window does not leak into the window
  capture. An occlusion-sensitive capture path would fail it.
- Any failure stops the capture track and ends the run as
  `capture-verification-failed`. `ready` is never reported, so recording
  never starts.

### Post-recording privacy check (analyzer, every frame)

- **Every** decoded frame is checked. A frame passes only if every canary
  outside the PiP rect (+4 px) is intact and the test-window barcode decodes.
  A frame whose PiP rect can't be identified is checked against all canaries,
  so it fails if the PiP hides any.
- `P.target` and `P.frames` are report criteria. The run-level verdict is
  `PRIVACY: FAIL — the run is invalid` and the analyzer **exits with code 4**
  if even one frame fails or the capture target wasn't verified.
- The only image the analyzer ever writes is `contact-sheet.png`. It's
  extracted only when every frame passed **and** the capture target was
  verified (offline self-tests: per-frame check only).
- Detection limit: any opaque foreign region larger than about 76×76 px
  covers at least one canary. Smaller content that falls between canaries is
  not guaranteed to be detected by this check.
- Offline check (libx264 at 3 Mbps, synthetic frames, no capture): 0 false
  failures in 60 clean frames. 30/30 frames with a 200×150 foreign rectangle
  were detected (≥ 9 canaries failed each). Chromium's encoder may behave
  differently.

### Offline self-tests (no capture, no real session)

```bash
node poc/recording-engine/selftest/run-offline-selftests.js
```

| Test | What it proves |
|---|---|
| `selftest/capture-target.test.js` | The selector denies screen sources, missing targets, look-alike titles, duplicate HWNDs, prefix HWNDs and malformed input, and grants only the exact window (19 cases) |
| `selftest/deny-request.js` | A display-media handler that can only `cb(null)` makes the page's request reject (`AbortError`) with no tracks, under the POC's permission rule |
| `selftest/encoder-selftest.js` | Chromium's **real MediaRecorder** (POC MIME order, 8 Mbps) encodes a **synthetic canvas** with the POC layout; the analyzer then checks clean, 15-foreign-frame, 1-foreign-frame and no-instrumentation variants |

Result on 2026-11-17 (15/15 checks, outputs in
`Videos\CamShare-POC\selftest-20261117-213403\`):
- Clean: 0 of 171 frames failed, verdict PASS, contact sheet generated.
- 15 foreign frames drawn: 12 were encoded (Chromium dropped 122, 127 and
  134), **all 12 failed**, the neighbouring frames passed, exit 4, no image.
- 1 foreign frame: it was encoded and failed, exit 4, no image.
- The `verifyCapture` pixel checks rejected a raw frame with foreign content
  (9 canaries missing).

### Instrumentation effects (test-only; not part of the app)

Recorded-image area (1920×1080 output):

| Element | Drawn by | Area | Notes |
|---|---|---|---|
| Compositor frame barcode, 832×32 | recorder | 26,624 px (1.28 %) | changes every frame |
| A/V flash box, 96×96 | recorder | 9,216 px (0.44 %) | black; white for 100 ms every 10 s |
| Test-window barcode, 832×32 | test window | 26,624 px (1.28 %) | changes every test-window update |
| 458 privacy canaries, 12×12 | test window | 65,952 px (3.18 %) | static high-contrast checker tiles; some are hidden under the PiP |
| Synthetic-camera barcode + gray patch | test window (camera) | scales with the PiP | inside the PiP only |

Together the stamps and canaries cover about **6.2 %** of every frame with
high-contrast, fine detail that typical screen content doesn't have.

Workload:
- **Measured** (offline, synthetic canvas, Chromium MediaRecorder, H.264 in
  WebM at 8 Mbps): **939 kbps with instrumentation vs 669 kbps without**
  (+270 kbps, +40 %) on mostly static content. On busier content the
  relative overhead will be smaller, but this isn't measured.
- **Estimated, not measured:**
  - The recorder adds 27 `fillRect` calls per frame. The light test window
    redraws its barcode (26 rects) and the canaries under the moving box
    (about 12 tiles × 4 rects) per update; the heavy test window redraws all
    458 canaries (1,832 rects).
  - Pre-recording verification reads back five 1920×1080 frames
    (`getImageData`, about 8 MB each), before recording only.
  - The GPU/CPU cost isn't isolated and is expected to be small compared
    with the two full-frame `drawImage` calls per frame. Unverified.
- **Consequence:** bitrate, file-size and encoder-load results describe the
  **instrumented** synthetic content. They aren't representative of real
  screens and mustn't be presented as such.

### Other privacy measures

- No microphone and no system audio are ever opened.
- GPU diagnostics (`getGPUInfo`) run only before recording starts and after
  it stops, never during recording.
- All outputs go to `%USERPROFILE%\Videos\CamShare-POC\<run>\`, outside the
  repository. `main.js` refuses to start if that path is inside the repo.

## Running

Close other heavy apps. The run takes over the primary display.
**Ctrl+Shift+Q** (or **Esc** on the pattern) aborts; the recording is still
saved. **Ctrl+Shift+M** writes a timestamped `manual-mark` event.

```bash
npx electron poc/recording-engine/main.js --scenario=smoke
```
```bash
node poc/recording-engine/analyze.js "%USERPROFILE%\Videos\CamShare-POC\<run>"
```

Options: `--minutes=N`, `--background-throttling=true` (control run),
`--mime=h264|vp8|vp9`. `--camera=phone` is intentionally not implemented
(the real-phone test needs separate approval).

| Scenario | Default length | Timeline (s after recording start) | Approval stage |
|---|---|---|---|
| `smoke` | 2 min | foreground only | Stage 1 |
| `pip` | 6 min | 60 → 300: PiP move every 500 ms, resize sweep 10–50 % | Stage 2 |
| `background` | 25 min | 120 minimize, 720 restore, 840 covered by another window, 1440 uncover | Separate |
| `soak` | 35 min | 300–600 PiP churn, 900–1500 minimized, 1620–1920 covered | Separate |
| `reconnect` | 4 min | camera drop/restore at 60/90 and 150/180 | Not yet scheduled |

## Measurement design

| Measurement | How | Source file |
|---|---|---|
| Output resolution, codec, duration | ffprobe | recording |
| Output frame rate, frame gaps | ffprobe packet timestamps | recording |
| Dropped / duplicated frames | Compositor frame counter barcode (top-left, 26 cells × 32 px) read from every decoded frame: a jump > 1 means drawn but not recorded, 0 means duplicate | recording + `frames.jsonl` |
| Screen freshness | Pattern barcode at screen y 64–96 (redrawn at ~72 Hz) | recording |
| Camera presence/freshness | Synthetic camera barcode, read inside the logged PiP rect | recording + `frames.jsonl` |
| PiP geometry | Position of the white PiP border vs the logged rect (left/right/bottom) | recording + `frames.jsonl` |
| Resize handle leak | Luminance where the handle would be, over a mid-gray camera patch | recording |
| A/V sync | 100 ms white flash + 1 kHz tone every 10 s (first at 5 s), triggered on the same draw; flash frame pts vs tone onset | recording |
| File integrity | Full `ffmpeg -v error` decode, seeks at 25/50/75 % | recording |
| CPU, memory | `app.getAppMetrics()` per process, 1 Hz (recorder and pattern apps separately), `os.cpus()` | `metrics.jsonl`, `pattern-metrics.jsonl` |
| GPU | `typeperf "\GPU Engine(*)\Utilization Percentage"` 1 Hz, filtered to recorder PIDs | `gpu.csv` |
| Draw loop, visibility, write latency, backlog, WebRTC inbound stats | Recorder renderer counters, 1 Hz | `renderer-stats.jsonl` |

The analyzer **stops** if `ffmpeg` or `ffprobe` is missing. A criterion is
reported as PASS only if its metric was actually measured. Otherwise it is
NOT MEASURED, with the reason.

## Output files (per run, never modified by the analyzer)

`run.json`, `events.jsonl`, `metrics.jsonl`, `pattern-metrics.jsonl`,
`renderer-stats.jsonl`, `frames.jsonl`, `gpu.csv`, `typeperf.log`,
`pattern-process.log`, `summary.json`, and the recording
`CamShare-YYYYMMDD-HHMMSS.webm`. The analyzer writes only to a new
`analysis-<timestamp>/` subfolder: `report.md`, `analysis.json`, and
`contact-sheet.png`.
