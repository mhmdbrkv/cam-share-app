# CamShare V1

CamShare records your PC screen with your **phone camera as a movable
picture-in-picture overlay**. Scan a QR code on your phone, arrange the
camera on the live preview, and record. The video is saved on your PC.

- **Desktop app:** Electron (`^33.0.0`), currently **Windows only**.
- **Signaling server:** small Node.js + `ws` server (hosted on Render) that
  pairs the phone and the PC and serves the landing and phone pages.
- **Phone:** any modern mobile browser. No app install, no account.

Camera video goes directly from phone to PC over WebRTC. The server only
relays pairing messages.

> **Status:** v1.0.0 (Windows). CamShare V1 targets **Windows and macOS**. Windows is
> the current implementation target. macOS is **not supported or tested
> yet**. The approved V1 behaviour is in
> [docs/V1-SPECIFICATION.md](docs/V1-SPECIFICATION.md). What the code does
> today, and where it differs from V1, is tracked in
> [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md). The rest of this README
> describes the **current** build.

## Run the desktop app

Requirements: Node.js and npm, Windows.

1. Run `npm install`.
2. Run `npm start`, choose a display from the thumbnail picker, and select a
   screen to capture. If screen capture is cancelled or ends, select a screen
   again to retry.

By default the app connects to the production server at
`https://cam-share-app.onrender.com`.

## Pair a phone

1. Deploy this repository to a Node.js host with HTTPS (for example Render).
   Set the build command to `npm install` and the start command to
   `npm run server`. (HTTPS is required for phone camera access.)
2. CamShare connects to the configured Render server automatically and displays
   a QR code under **Pair your phone**.
3. Scan the QR code on the phone and tap **Connect Camera**. Keep the phone page
   open while recording. **Flip Camera** switches between the front and back
   cameras.

If the server was idle, the first connection can take about 30 seconds while
Render wakes it up.

## Recording

- **Recording modes:** *Screen only* or *Screen + camera*.
- **PiP:** drag the camera on the preview to move it. Resize it by dragging
  its lower-right corner, with the **Camera size** slider, or with the mouse
  wheel (10–50 % of the width).
- **Audio:** off by default, so recordings are video only.
  - Check **Record PC microphone** to record your Windows default
    microphone. That is the only audio CamShare records.
  - Windows system audio and the phone microphone are never recorded. The
    phone page asks for the camera only.
  - There is no microphone picker yet: to use a different microphone,
    change the default input device in Windows sound settings.
- **Files:** saved to `Videos\CamShare` as `CamShare-YYYYMMDD-HHMMSS.webm`
  (or `.mp4`, depending on what the recorder supports). Existing files are
  never overwritten. Use **Change folder** to pick another folder for the
  current session (the choice isn't remembered after restart).
- WebM recordings are finalized with the video duration and a seek index added,
  so players (including Windows Media Player) show the length and can seek.

## Server configuration

The server uses Google's public STUN service by default. Some networks require a
TURN relay. Configure `ICE_SERVERS` with the relay URL and set the provider's
TURN REST shared secret as `TURN_SECRET`:

```json
[{"urls":["turn:turn.example.com:3478"]}]
```

CamShare generates a TURN REST username and HMAC-SHA1 credential valid for ten
minutes separately for each room join. Do not put static TURN credentials in
`ICE_SERVERS`; the server rejects credentialed ICE configuration without
`TURN_SECRET`.

The signaling server checks the WebSocket `Origin`. By default, `PUBLIC_ORIGIN`
is `https://cam-share-app.onrender.com`, which is also the only browser origin
allowed (plus the desktop app's `file://` origin). Set `PUBLIC_ORIGIN` and, if
needed, comma-separated `ALLOWED_ORIGINS` when deploying on a different domain.
If you set `ALLOWED_ORIGINS`, include `file://` yourself, because it replaces
the default list.

On Render, set `TRUST_PROXY=1` so join rate limits use Render's
`X-Forwarded-For` client address; enable it only behind a trusted proxy.
Connection and room limits default to 200 and 100 and can be adjusted with
`MAX_CONNECTIONS` and `MAX_ROOMS`.

**Using a different domain for the desktop app:** set the server URL with
the `SERVER_URL` environment variable, or change its default in
`src/main.js`. Then add the new `https://` and `wss://` origins to the
`connect-src` policy in `src/index.html`. Changing `SERVER_URL` in
`src/renderer.js` alone has no effect, because the value from `src/main.js`
always overrides it.

All variables are listed in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Build the installer

Build the Windows installer with `npm run dist` (electron-builder, NSIS).
Output: `dist/CamShare-Setup.exe`. Only Windows is configured.

## Publish the Windows download

The Render landing page links to the latest GitHub release. Build the Windows
installer with `npm run dist`, then attach `dist/CamShare-Setup.exe` to a
published release in this repository. The landing page's download button will
then serve that installer.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Run the desktop app (`electron .`) |
| `npm run server` | Run the signaling server (`node server/server.js`, port `PORT` or 8080) |
| `npm run dist` | Build the Windows installer |

There are no test or lint scripts yet.

## Project structure

```
src/            Electron app: main.js, preload.js, renderer.js, index.html, assets/
server/         Signaling server (server.js) and pages (public/index.html, public/m.html)
build/          Installer icon and NSIS sidebar images
docs/           Project documentation
```

## Documentation

| Document | Contents |
|---|---|
| [docs/V1-SPECIFICATION.md](docs/V1-SPECIFICATION.md) | Approved V1 product specification (target behaviour) |
| [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) | Current state, V1 gap analysis, POC checklist, V2 deferred scope, conflicts, open questions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, recording pipeline, IPC |
| [docs/SIGNALING_PROTOCOL.md](docs/SIGNALING_PROTOCOL.md) | WebSocket messages, limits, close codes |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Environment variables and hard-coded values |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Render deployment, local runs, installer build, release |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust model, existing controls, known gaps |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Status messages and fixes |
