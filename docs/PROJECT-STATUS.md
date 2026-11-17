# Project Status

_Last reviewed: 2026-11-17, against commit `6c3bf48` plus uncommitted
working-tree changes. Version in `package.json`: `0.1.0`. Electron:
`^33.0.0` (33.4.11 installed and used for the last build)._

This file keeps three things separate:

1. **Current State** (§1): what the inspected code actually does.
2. **V1 Target** (§2–§3): the approved behaviour in
   [V1-SPECIFICATION.md](V1-SPECIFICATION.md) and how far the code is from it.
3. **V2 Deferred** (§4): only features the spec explicitly defers.

Update it whenever a feature lands, changes, or is verified.

## Legend

**Implementation status** (§1):

| Mark | Meaning |
|---|---|
| ✅ **Verified** | Exercised at runtime and behaved as described. The method is noted. |
| 🟢 **Implemented (code-traced)** | A complete code path exists and was read end to end, but was **not** run. Not yet "done". |
| 🟡 **Partial** | Some of the behaviour exists; the gaps are noted. |
| ❌ **Not implemented** | No code exists. |
| ❓ **Unverified** | Depends on runtime, platform, or device conditions nobody has checked yet. |

**V1 compliance** (§2) uses the same marks, plus:

| Mark | Meaning |
|---|---|
| ⛔ **Conflicts** | The current code does something the V1 spec says it must not do, or does it differently. It needs a code change (or a spec decision). |

Verification method used on 2026-11-17: a local black-box test of
`server/server.js` (Node v22.17.0, `ws` client, 24 checks, all passed). The
desktop app and the phone page were **not** run in this review.

> **The Canvas + MediaRecorder recording approach is not production-ready.**
> None of the proof-of-concept acceptance criteria (§3) have been run.

---

## 1. Current State

### 1.1 Platform

| Item | Status | Notes |
|---|---|---|
| Windows desktop app | 🟢 | The only configured platform (`build.win`, NSIS). An installer has been built (`dist/CamShare-Setup.exe`, v0.1.0). |
| Windows installer build (`npm run dist`) | 🟢 | Build output exists in `dist/`; not re-run in this review. |
| macOS desktop app | ❌ | No `mac` build target. No macOS permission handling (`systemPreferences` isn't used). **Never tested.** |
| Linux | ❌ | Not targeted. |
| Code signing | ❌ | Not configured for any platform. |
| Auto-update | ❌ | `latest.yml` is generated but there's no updater code. |

### 1.2 Desktop app (`src/`)

| Feature | Status | Notes |
|---|---|---|
| In-app screen picker with thumbnails | 🟢 | Screens only, not windows. |
| Retry after cancelled or ended screen capture | 🟢 | Recent commit `5936242` targets this; not re-tested here. |
| QR code pairing | 🟢 | New room per launch; the room isn't persisted. |
| Signaling reconnect with backoff | 🟢 | 1.5 s → 10 s. Stops on `4001`. |
| Render cold-start wake-up and message | 🟢 | |
| Compositor canvas (≤ 1080 px tall, no upscale, 30 fps) | ✅ (foreground, 1 run) | Used for **both** recording modes. The canvas is also the visible preview element. Schedule changed 2026-11-17 (uncommitted) to a phase-keeping 30 fps deadline with ≥ 25 ms spacing, plus explicit `requestFrame()` push. **App smoke 2026-11-17** (Windows, 144 Hz, Screen only, user-driven, timing-only analysis), 2-min recording: 29.92 fps, 99.83 % of gaps ≤ 50 ms, largest gap 58 ms, 0 decode errors, seek 3/3. One run, foreground only. |
| Cold-start handling | ✅ (1 run) | Added 2026-11-17 (uncommitted): one-off warm-up recording on the first recording of a session; UI enters *Recording* only on `MediaRecorder` `start`. **App smoke:** first recording of the session had its first video frame at 0.14 s and a largest gap in the first 3 s of 36 ms (previously 0.6–1.9 s holes in the POC). Second recording: 0.14 s / 37 ms. |
| Recording while the window is minimized | 🟢 **Works (one run): ~28 fps measured; screen content kept updating (user's visual check of the recording)** | **Fix 2026-11-17 (uncommitted):** the fallback timer in `renderer.js` now draws whenever rAF hasn't ticked for > 50 ms while recording, instead of only when `document.hidden`. **App smoke `CamShare-20261117-231217.webm`**, minimized ~5.5–36.7 s: **27–30 fps** while minimized (was 1 fps); one 70–141 ms gap per second where the 1 Hz rAF tick pauses the timer; whole file 28.46 fps, largest gap 141 ms. Screen content while minimized: **kept moving**, per the user's playback of that recording (visual check, not instrumented). **Refinement (2026-11-17):** the timer stays active while rAF ticks are > 50 ms apart, plus a 25 ms spacing guard on the timer. App smoke `CamShare-20261117-231723.webm`, minimized ~3–38 s: the 1/s dips are gone (largest gap 94 ms, 0 gaps > 100 ms), but there are ~2 gaps of ~62 ms per second; 28.30 fps overall, 93.6 % of gaps ≤ 50 ms. [H] The timer's spacing guard skips ticks that Windows timer jitter brings in early. **This refined version is the one kept** (user decision 2026-11-17); the temporary diagnostic code was removed afterwards. Remaining: Screen + Camera while minimized, ≥ 10 min minimized (O4), and the ~62 ms gaps are untested or open. |
| Minimized recording: history | ❌ before the fix (kept for reference) | **App smoke recording 2 (2026-11-17):** the user minimized CamShare at ~13.6 s. Until ~21.2 s the file got exactly **1 frame per second** (~7.3 s of frames missing), then 30 fps resumed after restore. The hidden-window fallback (`setInterval` in `renderer.js`) appears throttled to 1 Hz despite `backgroundThrottling: false` ([H]). This path wasn't changed by the FPS fix. **Fix candidate added 2026-11-17 (uncommitted):** `disable-background-timer-throttling` and `disable-renderer-backgrounding` switches in `src/main.js`. **Tested, no effect (measured):** app smoke `CamShare-20261117-230644.webm`, minimized ~4.8–13.6 s, still exactly 1 frame/s. The switches were then removed. **Diagnosis (measured, temporary in-app counters, `CamShare-20261117-230936.webm`):** while minimizing, `document.hidden` stayed **false**, rAF ticks fell (58 → 19/s), and the fallback timer kept ticking at 30/s but drew **0** frames, because it only draws when `document.hidden`. So frames come only from rAF. The steady 1 fps while minimized is [H] rAF ticking at ~1 Hz; the minimize in this run was ~2 s, too short to show the steady state. |
| PiP overlay: drag, resize handle, slider, wheel | 🟢 | Size 10–50 % of width. Works during recording; the resize handle is drawn only while not recording. |
| PiP keeps its position/size across camera reconnects | 🟢 | Stored in `S.pip`, never reset. |
| PiP mirroring for front camera | 🟢 | Based on the track's `facingMode`; ❓ whether phones report it reliably. |
| Recording modes: Screen only / Screen + camera | 🟢 | Screen only skips the camera check and the PiP draw, but still records from the compositor canvas. |
| Screen + camera start check | 🟢 | Throws "Phone camera is not streaming" if the camera isn't live at start. |
| Camera loss during recording → screen only | 🟢 | Not drawn when the track or peer connection isn't live. |
| Recording via MediaRecorder | 🟢 | Fixed 8 Mbps video, browser-default audio bitrate. MIME order: WebM/H.264 → MP4/AVC → MP4 → WebM/VP8 → WebM/VP9 → WebM. ❓ which one Electron 33 picks. |
| Windows system audio (loopback) | 🟢 / ❓ | Always requested on Windows; recorded whenever it's present. |
| Phone microphone | 🟢 | Recorded in Screen + camera mode when the PC mic is off. |
| PC microphone (optional checkbox) | 🟢 | Default device only. If unavailable: confirm "continue without audio" or cancel. No device choice. |
| WebM duration fix (seekable files) | 🟢 / ❓ | Custom EBML patcher; not tested against real recordings here. |
| Temp file → final name after the stream closes; never overwrite | 🟢 | Hard link or `COPYFILE_EXCL` copy, not `rename`. |
| Best-effort rescue on save failure (`CamShare-unsaved-*`) | 🟢 | Same session only. |
| Low-disk warning (< 2 GB) at prepare time only | 🟢 | |
| Write backpressure (await per chunk, 256 MB cap, disk errors) | 🟢 | |
| Recording while minimized / covered | 🟢 / ❓ | `backgroundThrottling: false`, occlusion detection disabled, and a hidden-window interval fallback. Real-world frame rate unverified. |
| Stop & Close dialog during recording | 🟢 | Closes only after a successful save; stays open on failure. |
| Single-instance lock | 🟢 | |
| Post-recording preview, filename, Open Folder, New Recording | 🟢 | |
| Custom save folder | 🟢 | Per session; not persisted between launches. |
| Stale temp-file cleanup at startup | 🟢 | Default folder only. |
| Settings screen / persisted settings | ❌ | |
| Window (single app) capture | ❌ | |
| Configurable server URL | 🟡 | `SERVER_URL` env var exists, but the CSP in `src/index.html` hard-codes the Render origin. |
| Navigation guards (`will-navigate`, `setWindowOpenHandler`) | ❌ | |
| Adaptive quality under load | ❌ | |

### 1.3 Phone page (`server/public/m.html`)

| Feature | Status | Notes |
|---|---|---|
| Connect Camera → WebRTC offer | 🟢 | ❓ No device/browser matrix (iOS Safari, Android Chrome) has been tested. |
| Microphone captured with the camera, video-only fallback | 🟢 | |
| Front/back camera flip | 🟢 | `replaceTrack`; renegotiates if that fails. |
| Screen wake lock | 🟢 / ❓ | Browser support varies. |
| "Keep this page in the foreground" guidance on the phone | ❌ | The README says it; the phone page doesn't. |
| Sender tuned to maintain frame rate, 2.5 Mbps | 🟢 | |
| Re-offer after the desktop reconnects (`peer up`) | 🟢 | |
| Re-offer after a WebRTC failure while signaling stays up | ❌ | Phone only updates the status text. |

### 1.4 Signaling server (`server/server.js`)

| Feature | Status | Notes |
|---|---|---|
| Landing page at `/` | ✅ | Local HTTP test. |
| Phone page at `/?s=<32 hex>`, 400 on a bad room, 404 elsewhere | ✅ | |
| Security headers + CSP | ✅ | |
| WebSocket Origin allow-list | ✅ | Foreign origin → 403; `file://` accepted. ❓ that Electron actually sends `file://` wasn't captured. |
| Join validation, `1008` on bad input | ✅ | |
| `config` with default STUN | ✅ | |
| `peer` up/down notifications | ✅ | |
| `sig` relay to the other member only | ✅ | |
| Same-role replacement with `4001` | ✅ | |
| Join rate limit (10 / IP / min) | ✅ | Invalid attempts count too. |
| TURN REST credential minting | ✅ | Format and 600 s expiry verified. ❓ against a real TURN server. |
| Startup validation of `ICE_SERVERS` / `TURN_SECRET` | ✅ | |
| `MAX_CONNECTIONS` / `MAX_ROOMS` caps | 🟢 | Not exercised. Non-numeric values disable the cap. |
| Heartbeat (30 s) | 🟢 | |
| Static asset serving | ❌ | `server/public/camshare-logo.svg` exists but returns 404. |
| Persistence / multi-instance scaling | ❌ | In-memory only. |

### 1.5 Engineering

| Item | Status |
|---|---|
| Automated tests | ❌ |
| Lint / format config | ❌ |
| CI | ❌ |
| `LICENSE` file | ❌ |
| Release automation | ❌ (manual GitHub release) |
| Deployment config in repo (`render.yaml`) | ❌ (configured in the Render dashboard; ❓ current settings) |

---

## 2. V1 Target — gap analysis

Each row is a requirement from [V1-SPECIFICATION.md](V1-SPECIFICATION.md)
(section in brackets), compared with the code in §1.

### 2.1 Platforms and connection [§2.1]

| Requirement | Current code | V1 |
|---|---|---|
| Windows desktop app | Exists; not run in this review | 🟢 / ❓ |
| macOS desktop app | No build target, no permission handling, system audio gated to `win32` | ❌ (must not be marked verified until tested) |
| QR code + WebRTC | Exists | 🟢 |
| "Over Wi-Fi" | Signaling goes through an internet-hosted server (Render). Media is peer-to-peer and uses public STUN; with TURN configured, media can be relayed over the internet | ❓ open question Q1 |
| Mobile browser camera, no native app | Exists | 🟢 |
| Phone stays awake, page in foreground | Wake lock requested; no on-phone guidance | 🟡 |
| No USB/UVC path | None | 🟢 |

### 2.2 Recording modes [§2.2, §3]

| Requirement | Current code | V1 |
|---|---|---|
| Screen Only must not depend on the phone, WebRTC, Camera Stream Manager, or Canvas Compositor; screen stream goes **directly** to MediaRecorder | Screen Only records `canvas.captureStream(30)` from the shared compositor. Signaling/WebRTC still run in the background (they don't block recording) | ⛔ **C1** |
| Screen + Camera embeds the camera in the same file | Exists | 🟢 |
| Screen + Camera requires screen **and** camera ready before start | Record needs a live screen; start throws if the camera isn't live | 🟢 |

### 2.3 PiP [§2.3]

| Requirement | Current code | V1 |
|---|---|---|
| Camera in preview and final recording | Same canvas | 🟢 |
| Move and resize before and during recording | Drag, wheel, and slider work during recording; the resize handle is invisible while recording, but its hit area still works | 🟡 |
| Preview and recording use the same composition source | Same canvas | 🟢 |
| Compositor separate from the application UI | The compositor canvas *is* the on-screen preview element, and the resize handle is drawn into it (and suppressed while recording) | ⛔ **C2** |
| PiP controls / UI not in the recorded output | Handle drawn only when not recording. A 3 px white border is drawn into the recording | 🟢 (border: open question Q4) |
| Camera disconnect → screen only; reconnect keeps PiP position/size | Yes, when the phone re-offers. No re-offer if WebRTC fails while signaling stays up | 🟡 |

### 2.4 Quality [§2.4]

| Requirement | Current code | V1 |
|---|---|---|
| Automatic resolution/FPS/bitrates/codec (no user settings) | All fixed or automatic; no user controls | 🟢 (Q5) |
| 1080p target, keep aspect, never upscale | Height = min(1080, source); width scaled; rounded to even | 🟢 |
| 30 FPS | Phase-keeping 30 fps rAF schedule + `captureStream(0)` + `requestFrame()` (2026-11-17, uncommitted) | 🟢 / ❓ Before the change, POC measured 28.68 fps at 144 Hz. The new approach gave 30.00 fps in POC runs (offline, plus 29.98 fps in a window-capture smoke with B). The app change itself is unverified by recording |
| Prefer WebM, choose by actual support | WebM/H.264 first, but **MP4 is preferred over WebM/VP8 and VP9** | 🟡 **C3** |

### 2.5 Audio [§2.5]

| Requirement | Current code | V1 |
|---|---|---|
| Optional PC microphone **only** | Also records Windows system audio, and the phone mic in Screen + camera mode | ⛔ **C4** |
| Audio OFF → video only | With the checkbox off, system audio and/or the phone mic are still recorded | ⛔ **C4** |
| Mic unavailable → notify; offer reselection or continue after confirmation | Offers only continue-without-audio or cancel; no reselection | 🟡 |
| Default mic auto-selected | `getUserMedia({audio: true})` | 🟢 |
| Optional mic selection in settings, for new recordings | No settings and no device picker | ❌ |
| Mobile mic deferred to V2 | Phone mic **is** recorded today | ⛔ **C4** |

### 2.6 Output and storage [§2.6]

| Requirement | Current code | V1 |
|---|---|---|
| Default `Videos/CamShare`, user can change it | Yes (not persisted; Q6) | 🟢 |
| Unique date/time names, never overwrite | `CamShare-YYYYMMDD-HHMMSS[-n]`, exclusive link/copy | 🟢 |
| Post-recording preview, filename/location, Open Folder, New Recording | Yes | 🟢 |
| No in-app library | None | 🟢 |
| No fixed duration limit | None in code (stops only on write backlog or errors) | 🟢 / ❓ long runs |
| Warn below 2 GB, continue on confirm | Yes | 🟢 |
| No periodic disk checks during recording | Checked only at prepare | 🟢 |

### 2.7 Recording lifecycle [§2.7]

| Requirement | Current code | V1 |
|---|---|---|
| States Idle → Preparing → Recording → Finalizing → Completed, plus Error | Same states, plus an extra `selecting` state for screen choice | 🟢 (Q7) |
| Camera disconnect during **Preparing** → cancel, return to Idle | The camera is checked once at the start of Preparing; not re-checked before recording starts | ❌ **C5** |
| Camera disconnect during Recording → continue | Yes | 🟢 |
| Recording reported only once the recorder is running | *Recording* state and Stop enabled only on `MediaRecorder` `start`; one-off warm-up first (2026-11-17, uncommitted) | 🟢 / ❓ unverified by recording |
| Finalizing state until the file is ready | Yes | 🟢 |
| Completed only after a successful save | Yes, but a save with a **write error** (truncated "partial" file) is still shown as Completed | 🟡 **C6** |
| Best-effort finalization/recovery on error | Rescue to `CamShare-unsaved-*`; partial files kept | 🟢 |
| No Pause/Resume | None | 🟢 |
| New recording after Completed, separate files | Yes | 🟢 |
| Close during recording: Cancel keeps recording; Stop & Close closes only after a successful save, shows the error otherwise | Yes | 🟢 |

### 2.8 Application behaviour [§2.8]

| Requirement | Current code | V1 |
|---|---|---|
| Keeps recording while minimized | `backgroundThrottling: false` + stall-based fallback timer (2026-11-17, uncommitted) | 🟢 **Works in one run:** ~28 fps while minimized (was 1 fps, measured); screen content kept updating (user visual check). Not yet validated against O4 criteria (≥ 10 min minimized, ≥ 28 fps, no gap > 500 ms) |
| Keeps recording when switching apps | Native occlusion detection disabled | 🟢 / ❓ (POC) |
| Lock screen / sleep unsupported | No handling (consistent) | 🟢 |
| Minimal UI | Single window, five setup sections | 🟢 |

### 2.9 Architecture [§3, §4]

| Logical component | Current code (`src/`) | V1 |
|---|---|---|
| Recording Controller | `startRecording`, `setState` in `renderer.js` | 🟢 (not modular) |
| Screen Capture | `startScreen` (renderer) + display-media handler (main) | 🟢 |
| Camera Stream Manager (independent of transport) | No separate component; the camera `<video>` source is set directly in the WebRTC `ontrack` handler | 🟡 **C7** |
| PiP Controller | `S.pip`, `pipRect`, pointer handlers | 🟢 (not modular) |
| Canvas Compositor (dedicated, separate from UI) | `renderFrame` on the visible `#cv` canvas | ⛔ **C2** |
| MediaRecorder | `startRecording` | 🟢 |
| Recording Storage | `rec:*` IPC handlers in `main.js` | 🟢 |
| Process split Main / Renderer / Preload as specified | Matches | 🟢 |
| `contextIsolation: true`, `nodeIntegration: false` | Yes | 🟢 |
| Chunks over IPC to a Main Writable stream | Yes | 🟢 |
| Backpressure: bounded pending data, ready signal, slow-write and disk-error handling | 256 MB cap, flush-acknowledged `invoke`, error capture | 🟢 |
| Unique temp file; final name only after the stream closes | Yes | 🟢 |
| Startup cleanup of CamShare temp files, default folder only | Yes | 🟢 |
| No crash recovery after restart | None | 🟢 |
| Validate operations and destinations in Main | Extension allow-list, one active recording, folder only from a native dialog, file reveal/preview only for the last saved file | 🟢 |
| High CPU/GPU doesn't auto-stop; degrade gracefully | Nothing stops on CPU/GPU load. No quality degradation either | 🟡 |

---

## 3. Proof-of-concept validation [§5]

None of these have been run. Each must pass **separately on Windows and
macOS** before the Canvas approach is called production-ready.

| # | Criterion | Windows | macOS |
|---|---|---|---|
| 1 | 1080p Screen + Camera recording | ❓ not run | ❓ not run (not buildable yet) |
| 2 | PiP move/resize during recording | ❓ | ❓ |
| 3 | Camera disconnect and reconnect | ❓ | ❓ |
| 4 | ≥ 30-minute recording | ❓ | ❓ |
| 5 | Minimize and restore | ❓ | ❓ |
| 6 | Switching to other applications | ❓ | ❓ |
| 7 | CPU / GPU / memory / smoothness / dropped frames | ❓ | ❓ |

Pending decision: whether to keep `backgroundThrottling: false` (currently set
in `main.js`) depends on criteria 5–6.

---

## 4. V2 — Deferred (explicit only)

| Deferred feature | Present in current code? |
|---|---|
| Virtual webcam | No |
| Mobile microphone recording | **Yes, it's recorded today** (see C4) |
| 60 FPS | No (fixed at 30) |
| Pause/Resume | No |
| In-app recordings library | No |
| Crash recovery UI / recovering recordings after restart | No (only in-session rescue on save failure, which V1 allows) |
| USB/UVC phone connection | No |

### Unsupported in V1 (not V2)

- Recording continuity through the lock screen or system sleep.
- Phone streaming while the phone is locked or the browser is in the
  background.

---

## 5. Conflicts between the code and the V1 spec

| ID | Conflict | Spec | Code |
|---|---|---|---|
| **C1** | Screen Only goes through the Canvas Compositor | §2.2, §3 | `renderer.js` `startRecording`: `outStream = canvas.captureStream(30)` for every mode |
| **C2** | The compositor is the visible UI preview canvas, and the PiP handle is drawn into it | §2.3, §3 | `src/index.html` `#cv`, `renderFrame` |
| **C3** | MP4 is preferred over WebM VP8/VP9 when WebM/H.264 isn't supported | §2.4 | MIME list in `startRecording` |
| **C4** | Audio is more than "PC mic only": Windows system audio is always included when present, and the phone mic is recorded in Screen + camera mode (a V2 feature); "Audio OFF" isn't video-only | §2.5, §6 | `getDisplayMedia({audio:true})`, `audio: "loopback"` in `main.js`, the audio-mixing block in `startRecording` |
| **C5** | A camera disconnect during Preparing isn't detected; the recording proceeds | §2.7 | `startRecording` checks `camLive()` once |
| **C6** | A truncated (write-error) recording is shown as Completed | §2.7 | `mr.onstop` → `setState("completed", …)` with `partial` |
| **C7** | No transport-independent Camera Stream Manager | §3 | `pc.ontrack` sets `cv.srcObject` directly |

Smaller gaps (partial, not conflicts): no mic reselection or device picker,
no on-phone foreground guidance, no re-offer after a WebRTC-only failure, an
invisible resize handle while recording, no macOS build or permissions, and
no graceful quality degradation.

## 6. Open questions

| ID | Question |
|---|---|
| Q1 | "WebRTC over Wi-Fi": is the internet-hosted signaling server (Render) acceptable for V1, or must pairing work on the LAN alone? Is a TURN relay (media over the internet) acceptable? |
| Q2 | Windows system audio: the spec says "PC microphone only". Should system audio be removed in V1, or was it an intended omission from the spec? |
| Q3 | Mic reselection UI: what does "reselection" look like when the mic fails (a device list in the prompt, or a link to settings)? |
| Q4 | Is the 3 px white PiP border part of the intended output, or a UI element that should be excluded? |
| Q5 | Does "automatic" bitrate mean fixed sensible defaults (current: 8 Mbps video, browser-default audio), or adaptive to resolution/load? |
| Q6 | Should the chosen save folder (and the future mic choice) persist across launches? The spec says "settings" but not persistence. |
| Q7 | Is a separate screen-selection state acceptable, or should screen selection be part of Idle? |
| Q8 | Screen Only mode: should signaling/WebRTC pairing stay active in the background (current), or be idle until Screen + Camera is chosen? |
| Q9 | What should happen to a truncated (partial) recording: an Error state with the file kept, or Completed with a warning? |
| Q10 | macOS packaging: dmg or zip, code signing and notarization, minimum macOS version. |
| Q11 | Screen Only output resolution: should it also be capped at 1080p (needs scaling), or record at native resolution once it bypasses the canvas? |

---

## 7. Working-tree note (2026-11-17)

Uncommitted at review time: deletion of the `brand/` folder and
`src/assets/{camshare-logo,logo}.svg`; updated icons and installer bitmaps;
a gradient-stop change in `src/index.html` and `server/public/index.html`;
an updated `server/public/camshare-logo.svg`; formatting-only changes in
`server/server.js`. These docs describe that working tree.
