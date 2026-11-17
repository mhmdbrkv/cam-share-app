# CamShare Architecture

> **Scope of this document:** the **current state** of the codebase as of
> 2026-11-17 (commit `6c3bf48` plus uncommitted working-tree changes).
> The approved target architecture is in
> [V1-SPECIFICATION.md §3–§4](V1-SPECIFICATION.md#3-recording-architecture).
> §7 below maps the two; the full gap analysis is in
> [PROJECT-STATUS.md](PROJECT-STATUS.md). Where behaviour has only been traced
> through code and not run, it is marked *(code-traced)*.

## 1. Overview

CamShare records a PC screen with a phone camera composited on top as a
picture-in-picture (PiP) overlay. It has three components:

| Component | Location | Runs on | Technology |
|---|---|---|---|
| Desktop recorder | `src/` | Windows PC (current platform) | Electron `^33.0.0` (33.4.11 installed / last built) |
| Signaling + web host | `server/server.js` | Any Node.js host with HTTPS (deployed on Render) | Node `http` + `ws` `^8.18.0` |
| Phone camera page | `server/public/m.html` | Phone browser | Plain HTML/JS, WebRTC, `getUserMedia` |
| Landing page | `server/public/index.html` | Any browser | Static HTML, links to GitHub release |

Media never passes through the server. The server only relays small JSON
signaling messages; the camera stream travels phone → desktop over a WebRTC
peer connection (direct, or via a TURN relay if one is configured).

```
 ┌──────────────┐   HTTPS GET /?s=<room>   ┌───────────────────────┐
 │ Phone browser│ ───────────────────────▶ │  server/server.js     │
 │  (m.html)    │ ◀──── WSS signaling ───▶ │  (Render)             │
 └──────┬───────┘                          │  - serves / and /?s=  │
        │                                  │  - relays join/sig    │
        │   WebRTC (video + mic audio)     └──────────▲────────────┘
        │   STUN / optional TURN                      │ WSS signaling
        ▼                                             │
 ┌─────────────────────────────────────────────────────┴─┐
 │ Electron desktop app                                   │
 │  renderer.js: screen capture + canvas compositor +     │
 │               MediaRecorder + WebRTC answerer          │
 │  main.js:     screen picker, file I/O, WebM fix-up     │
 └────────────────────────────────────────────────────────┘
```

## 2. Repository layout

```
.
├── package.json          # scripts, deps, electron-builder config (Windows NSIS only)
├── package-lock.json
├── README.md
├── CLAUDE.md             # instructions for AI assistants
├── docs/                 # this documentation
├── build/                # installer icon + NSIS sidebar bitmaps (buildResources)
├── src/                  # Electron app (packaged into the installer)
│   ├── main.js           # main process
│   ├── preload.js        # contextBridge → window.api
│   ├── renderer.js       # UI logic, compositor, recorder, WebRTC
│   ├── index.html        # desktop UI + CSP
│   └── assets/icon.png   # window icon
└── server/               # NOT packaged into the installer
    ├── server.js         # HTTP + WebSocket signaling server
    └── public/
        ├── index.html    # landing page (served at /)
        ├── m.html        # phone camera page (served at /?s=<room>)
        └── camshare-logo.svg  # present but NOT served (server only answers "/")
```

`dist/` (build output) and `node_modules/` are git-ignored. There are no tests,
linters, formatters, or CI configuration in the repository.

## 3. Desktop app (Electron)

### 3.1 Process model and security boundaries

- `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`,
  `backgroundThrottling: false` (`src/main.js`).
- The renderer has no Node access; it talks to the main process only through
  the `window.api` object exposed in `src/preload.js` (see §3.5).
- Single-instance lock: a second launch focuses the existing window.
- Chromium feature `CalculateNativeWinOcclusion` is disabled so the compositor
  keeps rendering when the window is covered.
- `backgroundThrottling: false` keeps `document.hidden` **false** while the
  window is minimized (measured 2026-11-17), even though
  `requestAnimationFrame` slows to about one tick per second. The fallback
  draw timer therefore can't rely on `document.hidden` (see §3.4).
  Chromium's `disable-background-timer-throttling` /
  `disable-renderer-backgrounding` switches were tried and had no effect, so
  they aren't used.

### 3.2 Startup sequence (`renderer.js` bottom IIFE)

1. `api.config()` → save directory and `serverUrl`.
2. Generate and display the pairing QR code locally (via the `qrcode` package
   in the main process). URL: `${SERVER_URL}/?s=${room}`.
3. `fetch(SERVER_URL, {mode: "no-cors"})` to wake a sleeping Render instance.
4. Open the signaling WebSocket and `join` as `desktop`.
5. Call `getDisplayMedia` to prompt for a screen.

The room ID is `crypto.randomUUID()` with dashes removed (32 lowercase hex
characters). It is generated fresh on every app launch and is not persisted.

### 3.3 Screen capture

- `session.setDisplayMediaRequestHandler` intercepts `getDisplayMedia`.
  `desktopCapturer.getSources({types: ["screen"]})` provides **screens only**
  (no individual windows); thumbnails are sent to the renderer, which shows a
  custom picker (`#screenPicker`).
- On Windows, if audio was requested, the handler returns
  `audio: "loopback"` (system audio). On other platforms no system audio is
  requested.
- Cancelling the picker, or the capture track ending, returns the UI to an
  error/idle state from which **Select screen** can be retried.
- If the screen track ends during recording, the recording is stopped and
  saved.

### 3.4 Compositor, recording, and saving

**Compositor** (`renderFrame` in `renderer.js`):
- Canvas size = screen size scaled to at most 1080 px tall (never upscaled),
  dimensions rounded down to even numbers.
- Driven by `requestAnimationFrame` with a phase-keeping 30 fps schedule
  (changed 2026-11-17, uncommitted):
  - each frame is drawn on the refresh nearest its 33.3 ms deadline, so the
    average is 30 fps at any refresh rate. The previous rule (`now − last ≥
    31.3 ms`) gave 28.8 fps at 144 Hz and 25 fps at 75 Hz;
  - frames are never drawn less than 25 ms apart; after a late refresh the
    schedule skips ahead instead of bursting.

  Plus a 30 Hz `setInterval` fallback, while recording, that draws
  whenever rAF is stalled: no tick for > 50 ms, or ticks > 50 ms apart.
  This is what keeps a minimized recording going. It never draws within
  25 ms of the previous frame (changed 2026-11-17, uncommitted; previously
  it drew only when `document.hidden`, which stays false while minimized,
  giving 1 fps).
- While recording, every drawn frame is pushed to the recorder explicitly with
  `requestFrame()` (see Recording).
- In **Screen + camera** mode, when the phone track is live and the peer
  connection is `connected`, the camera is drawn at the PiP rectangle with a
  3 px white border. Front-camera (`facingMode: "user"`) frames are mirrored.
- PiP position/size are stored as fractions of the canvas. Size is clamped to
  10–50 % of canvas width (slider, mouse wheel, or dragging the lower-right
  handle). The resize handle is drawn only in preview, never while recording.

**Recording** (`startRecording`):
- `canvas.captureStream(0)` plus `requestFrame()` after each draw (changed
  2026-11-17, uncommitted; previously `captureStream(30)`, whose own rate cap
  dropped frames). `MediaRecorder` at `videoBitsPerSecond: 8e6`, 1-second
  timeslices.
- **Cold start (changed 2026-11-17, uncommitted):**
  - The first recording in a session first runs a one-off warm-up: a
    throwaway recording of a 64×36 synthetic canvas, discarded, until its
    `start` event (≤ 4 s cap). This happens in *Preparing* ("Preparing
    recorder…"), before the temp file is created.
  - After `start()` the UI stays in *Preparing* ("Starting recorder…"). It
    switches to *Recording*, enabling Stop, only on `MediaRecorder`'s
    `start` event.
  - POC evidence: without the warm-up, 0.6–1.9 s of frames were lost after
    the first frame. With it: 0 frames lost, `onstart` after ~0.22 s
    (`poc/recording-engine/investigate/REPORT-fps-av.md` §6–7).
  - **Not yet verified in the app by a real recording.**
- MIME preference order (first supported wins):
  `video/webm;codecs=h264,opus` → `video/mp4;codecs=avc1,mp4a.40.2` →
  `video/mp4` → `video/webm;codecs=vp8,opus` → `video/webm;codecs=vp9,opus` →
  `video/webm`. The file extension follows the container (`.webm` / `.mp4`).
  Which MIME type Electron 33 actually selects on a given machine is
  **unverified**.
- **Audio mixing** via Web Audio `MediaStreamDestination`:
  - Screen/system audio (Windows loopback), if the screen stream has audio.
  - If **Also record PC microphone** is checked *and* the mic was obtained:
    PC mic is added and **the phone mic is not** (echo avoidance).
  - Otherwise, in Screen + camera mode: the phone mic (if the phone sent audio).
  - If the mic is requested but unavailable, the user is asked whether to
    continue without it.
- Low-disk check: warns if < 2 GB free in the save directory.
- **Backpressure:** each chunk is sent to the main process via `api.chunk()`,
  which resolves only after the write is flushed. If more than 256 MB is
  queued, the recording fails with "Disk too slow".

**Saving** (`main.js`, *code-traced*):
1. Chunks stream into a hidden temp file `.camshare-<12 hex>.tmp` inside the
   save directory.
2. On stop, for `.webm` files, `addWebmDuration` inserts an EBML `Duration`
   element into the `Info` section and writes `.camshare-<hex>.indexed.tmp`
   (MediaRecorder WebM has no duration, so players otherwise cannot scrub).
   It is skipped if free space is less than `size × 1.1 + 64 MB`. On failure,
   the un-indexed file is saved and the UI reports "Saved without seek
   support".
3. `publishFile` moves the result to `CamShare-YYYYMMDD-HHMMSS[-n].<ext>`
   without ever overwriting: hard-link + unlink, falling back to
   `copyFile(COPYFILE_EXCL)` (for exFAT/FAT32/network folders).
4. On a fatal save error, any recorded data is renamed to
   `CamShare-unsaved-<stamp>.<ext>` and the path is reported.
5. At startup, stale `.camshare-*.tmp` files are deleted — **only in the
   default save directory**, not in a custom folder chosen at runtime.

Default save directory: `<Videos>/CamShare` (`app.getPath("videos")`). A
folder chosen with **Change folder** lasts only until the app is closed; it
is not persisted.

Closing the window during a recording shows a dialog; **Stop & Close** stops
and saves before closing.

### 3.5 IPC surface (`window.api` → `ipcMain.handle`)

| `window.api` | Channel | Purpose / guards |
|---|---|---|
| `config()` | `cfg:get` | Returns `{dir, serverUrl}`; `serverUrl` = `process.env.SERVER_URL` or the Render default |
| `chooseDir()` | `dir:choose` | Folder dialog; ignored while recording |
| `prepare()` | `rec:prepare` | mkdir, writability check, free space (`low` if < 2 GB) |
| `start(ext)` | `rec:start` | Only `webm`/`mp4`; only one active recording |
| `chunk(buf)` | `rec:chunk` | Writes a chunk, resolves after flush |
| `stop()` | `rec:stop` | Finalize, add WebM duration, publish, returns `{file, partial, error, seekable, seekError}` |
| `abort()` | `rec:abort` | Destroys stream, deletes temp file |
| `showFile(f)` | `file:show` | Reveals in Explorer — only the last saved file |
| `fileUrl(f)` | `file:url` | `file://` URL for preview — only the last saved file |
| `qr(url)` | `qr` | QR code data URL (220 px) |
| `selectScreen(id)` / `cancelScreen()` | `screen:select` / `screen:cancel` | Resolve the pending display-media request |
| `onScreenSources(cb)` | event `screen:sources` | Main → renderer: list of screens + thumbnails |
| `onStopRequest(cb)` | event `stop-request` | Main → renderer: stop for Stop & Close |

### 3.6 Desktop UI state machine

`S.state` ∈ `idle`, `selecting`, `preparing`, `recording`, `finalizing`,
`completed`, `error`. **Record** is enabled only in `idle`/`completed`/`error`
with a live screen; **Stop** only in `recording`; screen and folder selection
are disabled while preparing/recording/finalizing.

## 4. Pairing and WebRTC

Full message reference: [SIGNALING_PROTOCOL.md](SIGNALING_PROTOCOL.md).

- The **phone is the offerer**, the desktop is the answerer.
- The phone page reads the room from `?s=`, connects to
  `wss://<same origin>`, and joins as `phone`. When the user taps
  **Connect Camera** it calls `getUserMedia` (ideal 1280×720, 30 fps, min 20;
  echo cancellation, noise suppression, AGC; falls back to video-only if
  audio is denied), requests a screen wake lock, and sends an offer.
- The phone re-offers whenever it receives `peer up` (for example after the
  desktop reconnects). Each offer carries a `negotiationId`; stale answers and
  ICE candidates are dropped on both sides.
- The phone sender is tuned to `degradationPreference: "maintain-framerate"`
  and `maxBitrate: 2.5 Mbps`.
- **Flip Camera** swaps `user` ↔ `environment` with `replaceTrack` (no
  renegotiation) when possible.
- ICE servers: both clients start with hard-coded Google STUN and replace it
  with the server's `config` message on join (which may include short-lived
  TURN credentials).
- Reconnects: the desktop retries signaling with exponential backoff
  (1.5 s → 10 s cap); the phone uses 2 s → 30 s. Close code `4001`
  ("replaced") stops retrying on the replaced client.

## 5. Signaling server

`server/server.js` is a single file with no framework:

- **HTTP:** only path `/`. `/?s=<32 hex>` → phone page; `/?s=<other>` → 400;
  `/` → landing page; any other path → 404 (so `camshare-logo.svg` is not
  reachable). Pages are read into memory at startup. Security headers are
  set on every response (see [SECURITY.md](SECURITY.md)).
- **WebSocket:** same port, `maxPayload` 64 KB, Origin allow-list, global
  connection cap, 30 s ping/pong heartbeat.
- **Rooms:** in-memory `Map<room, Set<ws>>`; at most one `desktop` and one
  `phone` per room (a new join with the same role replaces the old socket).
  State is lost on restart; there is no persistence and no horizontal scaling.

Configuration: [CONFIGURATION.md](CONFIGURATION.md). Deployment:
[DEPLOYMENT.md](DEPLOYMENT.md).

## 6. Build and packaging

- `npm run dist` → `electron-builder`, configured only for Windows
  (`win.target: nsis`, artifact `CamShare-Setup.exe`, assisted installer with
  a choice of install directory). There is **no `mac` or `linux` section**.
- Packaged files: `src/**/*` and `package.json` (the server is not included).
- No code signing is configured. The Windows SmartScreen behaviour of the
  unsigned installer is unverified.
- The landing page's download button points to
  `github.com/mhmdbrkv/cam-share-app/releases/latest/download/CamShare-Setup.exe`.

## 7. Current code vs. the approved V1 architecture

The V1 spec defines seven logical components and two composition paths. The
current code implements most responsibilities inside a single
`src/renderer.js`, not as separate modules.

| V1 component | Where it lives today | Fit |
|---|---|---|
| Recording Controller | `startRecording`, `setState` (`renderer.js`) | Matches in behaviour |
| Screen Capture | `startScreen` (`renderer.js`) + `setDisplayMediaRequestHandler` (`main.js`) | Matches |
| Camera Stream Manager | Not a component: `pc.ontrack` assigns the camera `<video>` directly | Coupled to WebRTC (conflict C7) |
| PiP Controller | `S.pip`, `pipRect`, `setPipSize`, canvas pointer handlers | Matches in behaviour |
| Canvas Compositor | `renderFrame` drawing into the visible `#cv` preview canvas | Not separate from the UI (conflict C2) |
| MediaRecorder | `startRecording` | Matches |
| Recording Storage | `rec:*` handlers in `main.js` | Matches (temp file, backpressure, final name after close) |

Composition paths:

```
V1 spec                                   Current code
-------                                   ------------
Screen Only:                              Screen Only:
  screen stream ──▶ MediaRecorder           screen ─▶ #cv canvas ─▶ captureStream(30) ─▶ MediaRecorder
                                                                   (conflict C1)
Screen + Camera:                          Screen + Camera:
  screen ┐                                  screen ┐
  camera ┴▶ dedicated compositor            camera ┴▶ #cv canvas (also the UI preview)
          ─▶ captureStream() ─▶ MR                   ─▶ captureStream(30) ─▶ MediaRecorder
```

The audio path also differs from V1 (system audio and phone mic are mixed in;
V1 is PC mic only). This is conflict C4. All conflicts and open questions are
in [PROJECT-STATUS.md §5–§6](PROJECT-STATUS.md#5-conflicts-between-the-code-and-the-v1-spec).

The Canvas + MediaRecorder approach is approved only as the **initial**
approach and is **not production-ready** until the proof-of-concept criteria
in [V1-SPECIFICATION.md §5](V1-SPECIFICATION.md#5-performance-validation-proof-of-concept-acceptance)
pass on Windows and macOS. `backgroundThrottling: false` (set in `main.js`) is
an option under test, not an approved final solution.
