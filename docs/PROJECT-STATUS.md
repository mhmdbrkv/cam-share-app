# Project Status

_Last reviewed: 2026-11-19, against the `v1-integration` branch: `origin/main` `c52ecfe` (phone pairing, camera-only and flip fixes) + the recording fixes (`0c380b8`) + A1 audio (`68719cb`). The desktop `src/` files are byte-identical to the ones used in the 2026-11-18 audio validation; the 2026-11-17/18 recording tests ran the same video pipeline before the A1 audio change (A1 changed audio only). `server/public/m.html` is the version deployed on Render (`c52ecfe`). Version in `package.json`: `0.1.0`. Electron: `^33.0.0` (33.4.11 installed)._

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

Verification methods: 2026-11-17, a local black-box test of
`server/server.js` (Node v22.17.0, `ws` client, 24 checks, all passed);
2026-11-17/18, desktop app tests (development build: `npm start` and the POC
app harness; recordings analysed by timing/stream metadata, privacy-gated);
2026-11-18/19, phone-page tests (local scripted tests and user-run checks on a
real Android phone). Each row names the method used. The installed (NSIS)
build has **not** been tested since these changes.

> **The Canvas + MediaRecorder recording approach is not production-ready.**
> None of the proof-of-concept acceptance criteria (§3) has been formally
> passed; there is partial Windows evidence only (see §3).

---

## 1. Current State

### 1.1 Platform

| Item | Status | Notes |
|---|---|---|
| Windows desktop app | 🟢 | The only configured platform (`build.win`, NSIS). An installer was built earlier (`dist/CamShare-Setup.exe`, v0.1.0); it **predates** the recording, audio and phone fixes and must be rebuilt. |
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
| Compositor canvas (≤ 1080 px tall, no upscale, 30 fps) | ✅ (foreground, 1 run) | Used for **both** recording modes. The canvas is also the visible preview element. Schedule changed 2026-11-17 to a phase-keeping 30 fps deadline with ≥ 25 ms spacing, plus explicit `requestFrame()` push. **App smoke 2026-11-17** (Windows, 144 Hz, Screen only, user-driven, timing-only analysis), 2-min recording: 29.92 fps, 99.83 % of gaps ≤ 50 ms, largest gap 58 ms, 0 decode errors, seek 3/3. One run, foreground only. |
| Cold-start handling | ✅ (1 run) | Added 2026-11-17: one-off warm-up recording on the first recording of a session; UI enters *Recording* only on `MediaRecorder` `start`. **App smoke:** first recording of the session had its first video frame at 0.14 s and a largest gap in the first 3 s of 36 ms (previously 0.6–1.9 s holes in the POC). Second recording: 0.14 s / 37 ms. |
| Recording while the window is minimized | 🟢 **Works (one run): ~28 fps measured; screen content kept updating (user's visual check of the recording)** | **Fix 2026-11-17:** the fallback timer in `renderer.js` now draws whenever rAF hasn't ticked for > 50 ms while recording, instead of only when `document.hidden`. **App smoke `CamShare-20261117-231217.webm`**, minimized ~5.5–36.7 s: **27–30 fps** while minimized (was 1 fps); one 70–141 ms gap per second where the 1 Hz rAF tick pauses the timer; whole file 28.46 fps, largest gap 141 ms. Screen content while minimized: **kept moving**, per the user's playback of that recording (visual check, not instrumented). **Refinement (2026-11-17):** the timer stays active while rAF ticks are > 50 ms apart, plus a 25 ms spacing guard on the timer. App smoke `CamShare-20261117-231723.webm`, minimized ~3–38 s: the 1/s dips are gone (largest gap 94 ms, 0 gaps > 100 ms), but there are ~2 gaps of ~62 ms per second; 28.30 fps overall, 93.6 % of gaps ≤ 50 ms. [H] The timer's spacing guard skips ticks that Windows timer jitter brings in early. **This refined version is the one kept** (user decision 2026-11-17); the temporary diagnostic code was removed afterwards. Remaining: Screen + Camera while minimized, ≥ 10 min minimized (O4), and the ~62 ms gaps are untested or open. |
| Minimized recording: history | ❌ before the fix (kept for reference) | **App smoke recording 2 (2026-11-17):** the user minimized CamShare at ~13.6 s. Until ~21.2 s the file got exactly **1 frame per second** (~7.3 s of frames missing), then 30 fps resumed after restore. The hidden-window fallback (`setInterval` in `renderer.js`) appears throttled to 1 Hz despite `backgroundThrottling: false` ([H]). This path wasn't changed by the FPS fix. **Fix candidate added 2026-11-17 (uncommitted):** `disable-background-timer-throttling` and `disable-renderer-backgrounding` switches in `src/main.js`. **Tested, no effect (measured):** app smoke `CamShare-20261117-230644.webm`, minimized ~4.8–13.6 s, still exactly 1 frame/s. The switches were then removed. **Diagnosis (measured, temporary in-app counters, `CamShare-20261117-230936.webm`):** while minimizing, `document.hidden` stayed **false**, rAF ticks fell (58 → 19/s), and the fallback timer kept ticking at 30/s but drew **0** frames, because it only draws when `document.hidden`. So frames come only from rAF. The steady 1 fps while minimized is [H] rAF ticking at ~1 Hz; the minimize in this run was ~2 s, too short to show the steady state. |
| PiP overlay: drag, resize handle, slider, wheel | 🟢 | Size 10–50 % of width. Works during recording; the resize handle is drawn only while not recording. |
| PiP keeps its position/size across camera reconnects | ✅ | Stored in `S.pip`, never reset. **Measured 2026-11-18** (app harness, window capture of the synthetic window, real phone; `CamShare-20261118-204447.webm`, 118.1 s): PiP rect 1382,226 480×852 identical before (0–20 s) and after (34.9–118 s) a phone camera interruption. During the interruption the PiP showed black (20.1–34.9 s) and was briefly not drawn three times (21.1–21.8, 26.1–26.9, 32.0–32.8 s). |
| PiP mirroring for front camera | 🟢 | Based on the track's `facingMode`; ❓ whether phones report it reliably. |
| Recording modes: Screen only / Screen + camera | 🟢 | Screen only skips the camera check and the PiP draw, but still records from the compositor canvas. **Screen + Camera app smoke 2026-11-18** (real phone via Render pairing, user-driven, timing-only analysis; `CamShare-20261118-201248.webm`, 178.8 s): 28.90 fps overall; **30.00 fps with 0 gaps > 50 ms outside 80–141 s** (incl. the PiP drag/resize phase); 80–141 s (presumed minimize and/or phone disconnect, per test plan, not yet confirmed) **26.82 fps**, 12.5 % of gaps > 50 ms, largest 101 ms. Clean start (first frame 0.17 s, largest early gap 49 ms); duration +0.21 s; 0 decode errors; seek 3/3. **Camera delay (measured from 4 frames at 8/14/20/26 s, stopwatch filmed by the phone):** the PiP lags the screen capture by **~80–100 ms** (readings 80, 85, 100, 100 ms; ±~10 ms because the PiP's last digit is motion-blurred). This is camera-path latency *relative to* the screen-capture path, not absolute. ❓ Camera return after the phone disconnect and the minimize/disconnect timings were not checked (the user couldn't recall them). |
| Screen + camera start check | 🟢 | Throws "Phone camera is not streaming" if the camera isn't live at start. |
| Camera loss during recording → screen only | 🟢 | Not drawn when the track or peer connection isn't live. **Measured 2026-11-18** (same run): recording continued through the interruption (30.00 fps in 20–34 s, 0 gaps > 100 ms) and the camera came back without restarting the recording. ⚠️ The camera status text stayed "Phone: connected" throughout (logged once per second), so the UI did not show the interruption. Hypothesis: the phone paused its track without closing the peer connection; not verified. Minimized ~36.8 s while recording with the camera connected (≈55–92 s): recording continued and the PiP stayed live, but **25.83 fps** (max gap 93 ms), below the O4 threshold of 28. Outside the minimize: 29.53–30.00 fps. 0 decode errors, seek 3/3. |
| Recording via MediaRecorder | 🟢 | Fixed 8 Mbps video, browser-default audio bitrate. MIME order: WebM/H.264 → MP4/AVC → MP4 → WebM/VP8 → WebM/VP9 → WebM. Measured on this Windows PC (2026-11-17/18 app recordings, ffprobe): Electron 33 picks **WebM with H.264 + Opus**. ❓ other machines. |
| Audio policy (V1: PC microphone only) | ✅ | **Changed 2026-11-18.** `getDisplayMedia` requests `audio: false` and main grants video only (no loopback); the phone mic is never added. The checkbox is read once at start. **App validation 2026-11-18** (`npm start`, stream metadata via ffprobe): Screen only + Audio off → 1 video, 0 audio (`CamShare-20261118-211250.webm`); Screen + camera + Audio off with phone mic permitted → 1 video, 0 audio (`-211517`); Screen + camera + Audio on → 1 video + 1 Opus audio covering the full 27.7 s (`-211609`), PC mic only per the user's listening check. |
| Windows system audio (loopback) | ❌ by design | Never requested or granted (V1 decision 2026-11-18). |
| Phone microphone | ❌ by design | Never recorded by the desktop. The phone page requests camera only (`server/public/m.html`), deployed via PR #1 (merge `c72b1ce`, Render auto-deploy live 2026-11-18 10:11 PM; live page verified identical to the merged file). ✅ Real phone 2026-11-18: no microphone prompt. |
| PC microphone (optional checkbox, default off) | ✅ | Windows default device only. If unavailable: confirm "continue without audio" (video only) or cancel. No device choice (deferred, decision 2026-11-18). |
| WebM duration fix (seekable files) | ✅ | Custom EBML patcher. Measured on the 2026-11-17/18 app recordings: duration present (within ~0.3 s of the video length), seek checks 3/3, 0 decode errors. |
| Temp file → final name after the stream closes; never overwrite | 🟢 | Hard link or `COPYFILE_EXCL` copy, not `rename`. |
| Best-effort rescue on save failure (`CamShare-unsaved-*`) | 🟢 | Same session only. |
| Low-disk warning (< 2 GB) at prepare time only | 🟢 | |
| Write backpressure (await per chunk, 256 MB cap, disk errors) | 🟢 | |
| Recording while minimized / covered | 🟢 / ❓ | `backgroundThrottling: false`, occlusion detection disabled, and a stall-based fallback timer. Minimized frame rate measured: see "Recording while the window is minimized" above (~28 fps Screen only; 25.8 fps with the camera). Covered/background (other app in front) not separately measured. |
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
| Camera only, no microphone (`audio: false`) | ✅ | Deployed via PR #1 (merge `c72b1ce`, Render auto-deploy live 2026-11-18 10:11 PM; live page verified identical to the merged file). **Real-phone check 2026-11-18** (user-run, Android; phone model not recorded): Connect Camera asked for the camera only, no microphone prompt; camera appeared in CamShare. ❓ iPhone/Safari not reported. |
| Waiting message: "Waiting for the computer… scan the QR code shown in CamShare." | ✅ local only / ❓ real phone | Added 2026-11-18 for blocker A2. Deployed via PR #1 (merge `c72b1ce`, Render auto-deploy live 2026-11-18 10:11 PM; live page verified identical to the merged file). Shown until the server reports the desktop in this session (existing `peer` messages, `role: "desktop"`); shown again when the desktop leaves or the phone's own server connection drops; hidden while the camera's WebRTC connection is `connected` (so a server outage doesn't ask for a rescan) and after a takeover (`4001`). Presence messages from a socket that has since closed are ignored. No protocol or `server.js` change. **Local validation 2026-11-18** (working-tree server on `localhost:8080`, page in a desktop browser, scripted WebSocket client as the desktop; no camera): all 9 checks passed (the 7 review cases plus a stale pairing link and desktop-already-present): (1) visible on initial load; (2) phone joins first → stays visible; (3) desktop in a *different* session (stale pairing link) → stays visible; (4) desktop joins the same session → hidden; (5) desktop leaves → shown; (6) desktop already present when the page loads → hidden; (7) phone's own connection drops → shown, hidden again ~2 s after reconnecting; (8) takeover by another phone → hidden, takeover text shown, no reconnect; (9) server restart → shown while down, stays shown after restart until the desktop rejoins, then hidden. **Real-phone check 2026-11-18** (user-run, Android; phone model not recorded; all as expected): a stale pairing link kept the message shown and never paired; a fresh QR scan hid it and connected; closing CamShare showed it again; reopening CamShare and scanning its new QR hid it again. **Not validated:** iPhone/Safari (not reported); hidden-while-camera-connected during a server restart (optional Render-restart check not reported); the stale-message race (code-traced only). |
| Front/back camera flip | ✅ (Android) | `replaceTrack`; renegotiates if that fails. **Android failure found 2026-11-18** in the real-phone check: "Could not switch camera: Could not start video source" (`NotReadableError`: the phone allows only one open camera, and flip opened the new camera before stopping the old one). **Fix:** try the other camera while the current one runs; on `NotReadableError` stop the current camera and retry; if that fails, reopen the previous camera ("Camera stopped… Reload this page" only if both fail); the facing mode changes only after a successful switch. Local test with simulated cameras: 6/6 scenarios as expected. Deployed via PR #2 (merge `c52ecfe`, Render auto-deploy live 2026-11-19 2:05 AM; live page verified identical to commit `941d9bb`). ✅ **Real Android phone 2026-11-19: flip works** (user check). ❓ iPhone not reported. |
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
| Windows desktop app | Exists; run as a development build in the 2026-11-17/18 app tests; the installed build has not been tested since these changes | ✅ dev build / ❓ installer |
| macOS desktop app | No build target, no permission handling | ❌ (must not be marked verified until tested) |
| QR code + WebRTC | Exists | 🟢 |
| "Over Wi-Fi" | Signaling goes through an internet-hosted server (Render). Media is peer-to-peer and uses public STUN; with TURN configured, media can be relayed over the internet | ❓ open question Q1 |
| Mobile browser camera, no native app | Exists | 🟢 |
| Phone stays awake, page in foreground | Wake lock requested; no on-phone guidance | 🟡 |
| No USB/UVC path | None | 🟢 |

### 2.2 Recording modes [§2.2, §3]

| Requirement | Current code | V1 |
|---|---|---|
| Screen Only must not depend on the phone, WebRTC, Camera Stream Manager, or Canvas Compositor; screen stream goes **directly** to MediaRecorder | Screen Only records the shared compositor canvas (`canvas.captureStream(0)` + `requestFrame()`). Signaling/WebRTC still run in the background (they don't block recording) | ⛔ **C1** |
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
| 30 FPS | Phase-keeping 30 fps rAF schedule + `captureStream(0)` + `requestFrame()` (2026-11-17) | ✅ (foreground, 1 run) Before the change, POC measured 28.68 fps at 144 Hz. The new approach gave 30.00 fps in POC runs (offline, plus 29.98 fps in a window-capture smoke with B) and **29.92 fps in an app recording** (2026-11-17, see §1.2). Long runs not yet measured |
| Prefer WebM, choose by actual support | WebM/H.264 first, but **MP4 is preferred over WebM/VP8 and VP9** | 🟡 **C3** |

### 2.5 Audio [§2.5]

| Requirement | Current code | V1 |
|---|---|---|
| Optional PC microphone **only** | PC default mic only; no system audio, no phone mic | ✅ (2026-11-18, C4 resolved) |
| Audio OFF → video only | No audio track when unchecked | ✅ (2026-11-18, two recordings with 0 audio streams) |
| Mic unavailable → notify; offer reselection or continue after confirmation | Offers only continue-without-audio or cancel; no reselection | 🟡 |
| Default mic auto-selected | `getUserMedia({audio: true})` | 🟢 |
| Optional mic selection in settings, for new recordings | No settings and no device picker | ❌ **Deferred from V1** (decision 2026-11-18) |
| Mobile mic deferred to V2 | Never recorded | ✅ |

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
| Recording reported only once the recorder is running | *Recording* state and Stop enabled only on `MediaRecorder` `start`; one-off warm-up first (2026-11-17) | ✅ (1 run: first video frame at 0.14 s, no early gap; see §1.2) |
| Finalizing state until the file is ready | Yes | 🟢 |
| Completed only after a successful save | Yes, but a save with a **write error** (truncated "partial" file) is still shown as Completed | 🟡 **C6** |
| Best-effort finalization/recovery on error | Rescue to `CamShare-unsaved-*`; partial files kept | 🟢 |
| No Pause/Resume | None | 🟢 |
| New recording after Completed, separate files | Yes | 🟢 |
| Close during recording: Cancel keeps recording; Stop & Close closes only after a successful save, shows the error otherwise | Yes | 🟢 |

### 2.8 Application behaviour [§2.8]

| Requirement | Current code | V1 |
|---|---|---|
| Keeps recording while minimized | `backgroundThrottling: false` + stall-based fallback timer (2026-11-17) | 🟢 **Works in one run:** ~28 fps while minimized (was 1 fps, measured); screen content kept updating (user visual check). With the camera connected (2026-11-18, ~37 s minimized): recording and camera continued at **25.8 fps**, below the internal O4 threshold of 28. Not yet validated against O4 criteria (≥ 10 min minimized, ≥ 28 fps, no gap > 500 ms) |
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

None of these has been formally passed. Each must pass **separately on Windows
and macOS** before the Canvas approach is called production-ready. The Windows
column lists the partial evidence so far (short, user-driven development-build
runs on one PC; details in §1.2).

| # | Criterion | Windows | macOS |
|---|---|---|---|
| 1 | 1080p Screen + Camera recording | 🟡 partial: 1920×1080 recordings of 179 s and 118 s (2026-11-18), ~29–30 fps outside minimize | ❓ not run (not buildable yet) |
| 2 | PiP move/resize during recording | 🟡 partial: drag/resize phase recorded at 30.00 fps, no gap > 50 ms (2026-11-18, 1 run) | ❓ |
| 3 | Camera disconnect and reconnect | 🟡 partial: recording continued, camera returned at the same PiP position (2026-11-18, 1 run); the status text didn't show the interruption | ❓ |
| 4 | ≥ 30-minute recording | ❓ not run | ❓ |
| 5 | Minimize and restore | 🟡 partial: recording continues; ~28 fps Screen only, 25.8 fps with the camera (≤ 37 s minimized) | ❓ |
| 6 | Switching to other applications | ❓ not separately tested | ❓ |
| 7 | CPU / GPU / memory / smoothness / dropped frames | ❓ not measured in the app (POC measurements only) | ❓ |

Pending decision: whether to keep `backgroundThrottling: false` (currently set
in `main.js`) depends on criteria 5–6.

---

## 4. V2 — Deferred (explicit only)

| Deferred feature | Present in current code? |
|---|---|
| Virtual webcam | No |
| Mobile microphone recording | No (removed 2026-11-18; C4 resolved) |
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
| **C1** | Screen Only goes through the Canvas Compositor | §2.2, §3 | `renderer.js` `startRecording`: `outStream = canvas.captureStream(0)` (frames pushed with `requestFrame()`) for every mode |
| **C2** | The compositor is the visible UI preview canvas, and the PiP handle is drawn into it | §2.3, §3 | `src/index.html` `#cv`, `renderFrame` |
| **C3** | MP4 is preferred over WebM VP8/VP9 when WebM/H.264 isn't supported | §2.4 | MIME list in `startRecording` |
| ~~**C4**~~ | **Resolved 2026-11-18.** Was: system audio and the phone mic were recorded, and "Audio OFF" wasn't video-only. Now PC mic only, video only when off (validated, see §1.2) | §2.5, §6 | `startScreen` / `startRecording` in `renderer.js`, `screen:select` in `main.js`, `getMediaStream` in `m.html` |
| **C5** | A camera disconnect during Preparing isn't detected; the recording proceeds | §2.7 | `startRecording` checks `camLive()` once |
| **C6** | A truncated (write-error) recording is shown as Completed | §2.7 | `mr.onstop` → `setState("completed", …)` with `partial` |
| **C7** | No transport-independent Camera Stream Manager | §3 | `pc.ontrack` sets `cv.srcObject` directly |

Smaller gaps (partial, not conflicts): no mic reselection or device picker
(device selection deferred from V1, decision 2026-11-18),
no on-phone foreground guidance, no re-offer after a WebRTC-only failure, an
invisible resize handle while recording, no macOS build or permissions, and
no graceful quality degradation.

## 6. Open questions

| ID | Question |
|---|---|
| Q1 | "WebRTC over Wi-Fi": is the internet-hosted signaling server (Render) acceptable for V1, or must pairing work on the LAN alone? Is a TURN relay (media over the internet) acceptable? |
| ~~Q2~~ | **Decided 2026-11-18:** V1 never records Windows system audio or the phone microphone. Audio OFF (default) = video only; Audio ON = PC default microphone only. |
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

## 7. Integration note (2026-11-19)

These docs describe the `v1-integration` branch: `origin/main` `c52ecfe` (phone pairing, camera-only and flip fixes) + the recording fixes (`0c380b8`) + A1 audio (`68719cb`), plus this documentation commit.
The recording-fixes commit also contains branding changes made before the
2026-11-17 review: deletion of the `brand/` folder (an old snapshot of the
app plus teal-palette logos) and of `src/assets/{camshare-logo,logo}.svg`;
new indigo icons and installer bitmaps; a gradient-stop change in
`src/index.html` and `server/public/index.html`; an updated
`server/public/camshare-logo.svg`; and formatting-only changes in
`server/server.js`. No current file references the deleted assets; they
remain in Git history at `6c3bf48`. Whether to keep those deletions is an
open decision.
