# CamShare V1 — Approved Product Specification

> This is the **approved target** for CamShare V1, recorded from the project's
> planning discussions on 2026-11-17. It describes intended behaviour, **not**
> what is implemented. For the current state and the gap analysis, see
> [PROJECT-STATUS.md](PROJECT-STATUS.md). Change this file only when a product
> decision changes, and record the decision.

## 1. Product goal

CamShare is a **Windows and macOS** desktop application that records the
computer screen together with a smartphone camera shown as a movable and
resizable Picture-in-Picture (PiP) overlay.

- The output is **one combined video file** containing both the screen and
  the phone camera.
- The phone connects through a **QR code and WebRTC over Wi-Fi**.
- The phone uses a **mobile browser**. No native phone app is required in V1.

## 2. V1 scope

### 2.1 Platforms and connection

- Windows is the immediate implementation target.
- macOS is also a V1 target, but must **not** be marked verified until tested.
- Phone connection: QR code + WebRTC over Wi-Fi; the mobile browser provides
  the camera stream.
- The phone screen must stay awake and the browser page must stay in the
  foreground during use.
- No USB/UVC connection path in V1.

### 2.2 Recording modes

| Mode | Requirement |
|---|---|
| **Screen Only** | Records the screen on its own. Must **not** depend on the phone, WebRTC, the Camera Stream Manager, or the Canvas Compositor. |
| **Screen + Camera** | Records the screen with the phone camera embedded as PiP in the same file. Both the screen and the phone camera must be ready **before** recording starts. |

### 2.3 PiP

- The camera appears in both the app preview and the final recording.
- The user can move and resize the PiP **before and during** recording.
- Preview and recording use the **same composition source and settings**.
- PiP controls and app UI must **not** appear in the recorded output.
- If the phone camera disconnects during recording, recording continues with
  screen only. When the camera reconnects, it returns with its previous PiP
  position and size.

### 2.4 Quality

- Automatic settings in V1: resolution, FPS, video bitrate, audio bitrate,
  and codec.
- Resolution: target **1080p**, preserving the screen's aspect ratio. Never
  upscale screens smaller than 1080p.
- Frame rate: target **30 FPS**.
- Format: prefer **WebM** initially, but select a MediaRecorder format/codec
  that the actual Electron build and system support.
- 60 FPS is deferred (V2).

### 2.5 Audio

- **Optional PC microphone only.**
  - Audio ON: include the PC microphone.
  - Audio OFF: video only.
- If the microphone is unavailable: notify the user and offer **reselection**,
  or continuing without audio after confirmation.
- The default microphone is selected automatically. An optional microphone
  selection in settings applies to new recordings.
- Mobile microphone recording is deferred (V2).

### 2.6 Output and storage

- Default folder: `Videos/CamShare`; the user can choose another folder.
- Unique date/time-based filenames; never overwrite a previous recording.
- After recording, show: video preview, filename/location, **Open Folder**,
  and **New Recording**.
- No in-app recordings library in V1.
- No fixed duration limit; recording continues while resources and storage
  allow.
- Warn when free disk space is below **2 GB**; the user may continue after
  confirming.
- No periodic disk-space checks during recording.

### 2.7 Recording lifecycle

States: `Idle → Preparing → Recording → Finalizing → Completed`, plus `Error`.

- Camera disconnects during **Preparing** → cancel setup, return to **Idle**.
- Camera disconnects during **Recording** → keep recording the screen.
- On Stop, show a saving/finalizing state until the file is fully prepared.
- Enter **Completed** only after the file is saved successfully.
- On errors, make a best-effort attempt to finalize or recover the data
  already recorded.
- No Pause/Resume in V1.
- A new recording can start after Completed; each recording is a separate
  file.
- Closing the app during recording asks for confirmation:
  - **Cancel**: keep recording.
  - **Stop & Close**: stop, finalize, and close only after saving succeeds.
    If saving fails, show the error and do **not** close automatically.

### 2.8 Application behaviour

- Recording continues while the CamShare window is minimized.
- Recording continues when the user switches to another application.
- Continuity through the lock screen or system sleep is **not guaranteed and
  is unsupported in V1**. (This is not a V2 feature.)
- Phone camera streaming is not guaranteed when the phone is locked or the
  browser is in the background.
- Keep the UI minimal.

## 3. Recording architecture

The recording engine uses Electron/Chromium APIs in V1.

| Logical component | Responsibility |
|---|---|
| Recording Controller | Coordinates the recording lifecycle |
| Screen Capture | Captures the desktop screen |
| Camera Stream Manager | Manages the incoming phone camera stream, independent of the transport |
| PiP Controller | Owns PiP position/size; handles drag and resize |
| Canvas Compositor | Combines screen and camera |
| MediaRecorder | Encodes the output stream |
| Recording Storage | Writes and finalizes the output file |

Composition rules:

- **Screen Only:** the screen `MediaStream` goes **directly** to
  MediaRecorder. No Canvas Compositor.
- **Screen + Camera:** the screen and camera are drawn into a dedicated Canvas
  Compositor, and `canvas.captureStream()` feeds MediaRecorder.
- The compositor is separate from the application UI.
- Preview and recording share the same composition source.
- If the camera disconnects, keep the canvas output alive and draw the screen
  only until the camera reconnects.

Canvas + MediaRecorder is the approved **initial** approach. Its stability and
performance must be proven in a proof of concept (§5). Consider WebCodecs only
if testing shows the initial approach is inadequate.

## 4. Electron process and storage architecture

| Process | Responsibilities |
|---|---|
| Main | Window and OS integration, screen-source handling, filesystem operations, app-close lifecycle |
| Renderer | UI, WebRTC, camera stream, PiP, compositor, preview, MediaRecorder |
| Preload | Narrow, secure IPC bridge via `contextBridge` |

- Keep `contextIsolation: true` and `nodeIntegration: false`.
- The Renderer sends recording chunks to Main over IPC.
- Main writes chunks progressively with a Node.js Writable stream.
- Handle backpressure from the start: bound the pending data, provide a
  ready/backpressure signal, and handle slow writes and disk errors.
- Write to a unique temporary file during recording. Rename it to the final
  filename only after recording ends and the output stream closes
  successfully.
- At startup, clean up only CamShare-owned stale temp files in the **default**
  folder.
- Crash recovery after an app restart is explicitly **out of V1 scope**.
- Validate recording operations and file destinations in Main.

## 5. Performance validation (proof-of-concept acceptance)

Before the Canvas-based approach is treated as production-ready, validate:

1. 1080p Screen + Camera recording.
2. PiP movement and resizing during recording.
3. Camera disconnect and reconnect.
4. At least **30 minutes** of recording.
5. Minimize and restore.
6. Switching to other applications.
7. CPU, GPU, memory, smoothness, and dropped frames.
8. Each of the above on **Windows and macOS separately**.

- High CPU/GPU usage alone must not automatically stop recording. Prioritise
  recording stability and gracefully lower quality if that is technically
  possible.
- No live performance dashboard is required.
- `backgroundThrottling: false` may be tested as an implementation option,
  but it is **not** an approved final solution until validated.

## 6. V2 / deferred scope

These are **explicitly** deferred, and only these:

- Virtual webcam
- Mobile microphone recording
- 60 FPS
- Pause/Resume
- In-app recordings library
- Crash recovery UI and recovering recordings after an app restart
- USB/UVC phone connection

Unsupported or unverified behaviour is not automatically V2. For example,
lock-screen and system-sleep continuity is **unsupported in V1** unless a
separate decision says otherwise.

## 7. Documentation rules

- Keep Current State, V1 Target, and V2 Deferred separate.
- Current State describes the inspected code, not what the spec expects.
- V1 Target describes the approved behaviour, even if it isn't implemented.
- V2 Deferred contains only explicitly deferred features.
- Use the statuses *verified*, *implemented (code-traced)*, *partial*,
  *not implemented*, and *unverified* accurately.
- Never mark macOS as verified without real testing.
- Never call Canvas recording production-ready before the §5 criteria pass.
- Where no decision has been made, record an open question; don't invent an
  answer.
