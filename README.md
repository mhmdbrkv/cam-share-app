# CamShare V1

## Run the desktop app

1. Run `npm install`.
2. Run `npm start`, choose a display from the thumbnail picker, and select a
   screen to capture. If screen capture is cancelled or ends, select a screen
   again to retry.

## Pair a phone

1. Deploy this repository to a Node.js host with HTTPS (for example Render).
   Set the build command to `npm install` and the start command to
   `npm run server`.
2. CamShare connects to the configured Render server automatically and displays
   a QR code under **Pair phone**.
3. Scan the QR code on the phone and tap **Connect Camera**. Keep the phone page
   open while recording.

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
Also update `SERVER_URL` in `src/renderer.js` and the `connect-src` policy in
`src/index.html` to use that domain. On Render, set `TRUST_PROXY=1` so join
rate limits use Render's `X-Forwarded-For` client address; enable it only behind
a trusted proxy. Connection and room limits default to 200 and 100 and can be
adjusted with `MAX_CONNECTIONS` and `MAX_ROOMS`.

Recordings include Windows system audio when available. Screen + Camera mode
also includes the phone microphone when permission is granted; enable **Also
record PC microphone** to mix in the desktop microphone. WebM recordings are
finalized with duration metadata so players can seek through them. Drag the
PiP's lower-right corner on the preview or use the PiP size slider to resize it.

Build installers with `npm run dist`.

## Publish the Windows download

The Render landing page links to the latest GitHub release. Build the Windows
installer with `npm run dist`, then attach `dist/CamShare-Setup.exe` to a
published release in this repository. The landing page's download button will
then serve that installer.
