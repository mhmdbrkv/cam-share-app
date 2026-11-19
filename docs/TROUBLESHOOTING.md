# Troubleshooting

Status messages below are quoted from the current code (`src/renderer.js`,
`src/main.js`, `server/public/m.html`). Causes are *code-traced* unless
noted otherwise.

## Pairing and connection

| Symptom | Likely cause | What to do |
|---|---|---|
| Desktop shows "Waking up cloud server (takes ~30s on cold start)…" | The Render instance was asleep. | Wait. The app retries automatically (backoff up to 10 s). |
| Desktop stays on "Connecting to relay server…" | Server unreachable, or the desktop CSP doesn't allow the server's origin (see [CONFIGURATION.md](CONFIGURATION.md)). | Check the server URL in a browser; check DevTools console for CSP errors. |
| Phone shows "Waiting for the computer… scan the QR code shown in CamShare." | The computer isn't in this phone page's pairing session yet. Common causes: CamShare isn't open or is still connecting to the server; the phone page is a **stale pairing link** (every CamShare launch creates a new session, so a page or QR code from an earlier launch never pairs); CamShare was closed or lost its server connection; or the phone's own server connection dropped. | Scan the QR code shown in the **current** CamShare window. The message disappears as soon as the computer joins the same session. After a short network drop or server restart, both sides reconnect automatically (the phone retries with backoff up to 30 s, the desktop up to 10 s) and the message clears without rescanning. It stays hidden while the camera is already streaming to the computer. |
| Phone page says "Camera access error: …" | Camera permission denied, or the page is not served over HTTPS. | Allow camera access; use the HTTPS URL from the QR code. |
| Phone shows "Camera streaming (connected)" but the desktop shows no PiP | Recording mode is **Screen only**, or the WebRTC connection is not `connected` on the desktop side. | Select **Screen + camera**. Check the desktop's "Phone: …" status. |
| Phone shows "Could not switch camera: …" or "Camera stopped: … Reload this page to reconnect." | Flip Camera couldn't open the other camera. Phones that allow only one open camera are handled automatically (CamShare stops the current camera and retries); this message means the other camera still couldn't start, e.g. it's in use by another app or doesn't exist. After "Could not switch camera", the previous camera keeps streaming. | Close other apps using the camera and try again. After "Camera stopped", reload the phone page (or rescan the QR code) and tap **Connect Camera**. |
| Phone status stays at `connecting` then `failed` | Restrictive NAT/firewall; STUN alone isn't enough. | Configure a TURN relay (`ICE_SERVERS` + `TURN_SECRET`). |
| "Another CamShare window took over this session" (desktop) / "Another device took over this camera session." (phone) | A second client joined the same room with the same role (close code `4001`). | Expected after re-scanning on another device. Rescan the QR to reconnect. |
| Repeated disconnects, and joins rejected after many reconnects | Join rate limit (10 per IP per minute, shared by every client behind the same IP, invalid attempts included). | Wait a minute. Make sure `TRUST_PROXY=1` is set on Render so the limit applies per client, not per proxy. |
| Phone screen turns off and the stream stops | Wake Lock not supported or denied by the phone's browser. | Keep the phone page in the foreground; adjust the phone's auto-lock. Streaming from a locked phone or a backgrounded browser is **not supported in V1**. |
| Recording stops or stutters after the PC locks or sleeps | Lock-screen and system-sleep continuity is **not supported in V1**. | Keep the PC awake and unlocked while recording. |

## Screen capture

| Symptom | Cause / action |
|---|---|
| "Screen selection cancelled. Select screen to retry." | Picker was cancelled. Click **Select screen**. |
| "Screen capture ended. Select a screen to continue." | The capture track ended (display disconnected, etc.). Select a screen again. |
| "Screen capture ended; saving recording…" | The track ended during recording; the recording is saved automatically. |
| Only whole screens are offered, not windows | By design in the current code (`types: ["screen"]`). |
| No system audio in recordings | By design: V1 never records system audio. Only the PC microphone is recorded, when **Record PC microphone** is checked. |

## Recording and saving

| Message | Meaning |
|---|---|
| "Phone camera is not streaming" | Screen + camera mode was selected but the camera isn't live. Connect the phone or switch to Screen only. |
| "Only X GB free. Continue anyway?" | Less than 2 GB free in the save folder. |
| "Microphone unavailable. Continue without audio?" | **Record PC microphone** is on but the Windows default microphone couldn't be opened (no mic, or microphone access is off in Windows privacy settings). |
| "Recording… (no audio: microphone unavailable)" | You chose to continue without the microphone. The video is recorded without audio. |
| No audio in a recording | Expected when **Record PC microphone** is unchecked (the default): recordings are video only. |
| Wrong microphone recorded | CamShare uses the Windows default input device; there's no picker in V1. Change the default in Windows sound settings. |
| "Disk too slow: write backlog exceeded" | More than 256 MB of data is waiting to be written; the recording is stopped and saved as partial. Use a faster disk. |
| "Saved without seek support: …" | Adding the duration and seek index to the WebM failed, or there wasn't enough free space (needs about 1.1× the file size + 64 MB). The file plays, but players such as Windows Media Player may not show its length or allow seeking. Browsers and VLC usually can. |
| "(partial: …)" after the file name | A write error happened; the saved file is truncated. |
| "Save failed: … Recorded data was kept at …\CamShare-unsaved-….webm" | Final save failed; the raw data was rescued under that name. |
| Leftover `.camshare-*.tmp` files | Left by a crash. They're cleaned at startup **only in the default folder** (`Videos\CamShare`). Delete them by hand from custom folders. |
| Save folder resets after restart | Expected: the chosen folder isn't persisted in the current build. |
