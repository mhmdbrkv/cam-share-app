# CamShare V1

## Run the desktop app

1. Run `npm install`.
2. Run `npm start` and choose a screen with **Select screen**. If screen capture
   is cancelled or ends, select a screen again to retry.

## Pair a phone

1. Deploy this repository to a Node.js host with HTTPS (for example Render).
   Set the build command to `npm install` and the start command to
   `npm run server`.
2. In CamShare, paste the deployed HTTPS URL under **Pair phone**, then click
   **Apply server**.
3. Scan the QR code on the phone and tap **Connect Camera**. Keep the phone page
   open while recording.

The server uses Google's public STUN service by default. Some networks require a
TURN relay. To configure one, set `ICE_SERVERS` on the server to a JSON array
containing your TURN service and credentials, for example:

```json
[{"urls":["turn:turn.example.com:3478"],"username":"user","credential":"password"}]
```

Treat TURN credentials as secrets and use provider-issued, short-lived
credentials when available. They are delivered to paired clients to establish
the media connection.

Build installers with `npm run dist`.
