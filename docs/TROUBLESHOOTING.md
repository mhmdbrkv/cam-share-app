# Troubleshooting

Status messages below are quoted from the current code (`src/renderer.js`,
`src/main.js`, `server/public/m.html`). Causes are *code-traced* unless
noted otherwise.

## Pairing and connection

| Symptom | Likely cause | What to do |
|---|---|---|
| Desktop shows "Waking up cloud server (takes ~30s on cold start)…" | The Render instance was asleep. | Wait. The app retries automatically (backoff up to 10 s). |
| Desktop stays on "Connecting to relay server…" | Server unreachable, or the desktop CSP doesn't allow the server's origin (see [CONFIGURATION.md](CONFIGURATION.md)). | Check the server URL in a browser; check DevTools console for CSP errors. |
| Phone page says "Camera access error: …" | Camera permission denied, or the page is not served over HTTPS. | Allow camera access; use the HTTPS URL from the QR code. |
| Phone shows "Camera streaming (connected)" but the desktop shows no PiP | Recording mode is **Screen only**, or the WebRTC connection is not `connected` on the desktop side. | Select **Screen + camera**. Check the desktop's "Phone: …" status. |
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
| No system audio in recordings | System audio (loopback) is requested **only on Windows**. On Windows, its availability depends on the system *(unverified across devices)*. |

## Recording and saving

| Message | Meaning |
|---|---|
| "Phone camera is not streaming" | Screen + camera mode was selected but the camera isn't live. Connect the phone or switch to Screen only. |
| "Only X GB free. Continue anyway?" | Less than 2 GB free in the save folder. |
| "Microphone unavailable. Continue without audio?" | **Also record PC microphone** is on but the mic couldn't be opened. |
| "Recording… (no audio source available)" | No screen audio, no mic, and no phone audio was available. The video is still recorded. |
| "Disk too slow: write backlog exceeded" | More than 256 MB of data is waiting to be written; the recording is stopped and saved as partial. Use a faster disk. |
| "Saved without seek support: …" | The WebM duration fix failed or there wasn't enough free space (needs about 1.1× the file size + 64 MB). The file plays but may not show its length or allow scrubbing. |
| "(partial: …)" after the file name | A write error happened; the saved file is truncated. |
| "Save failed: … Recorded data was kept at …\CamShare-unsaved-….webm" | Final save failed; the raw data was rescued under that name. |
| Leftover `.camshare-*.tmp` files | Left by a crash. They're cleaned at startup **only in the default folder** (`Videos\CamShare`). Delete them by hand from custom folders. |
| Save folder resets after restart | Expected: the chosen folder isn't persisted in the current build. |
