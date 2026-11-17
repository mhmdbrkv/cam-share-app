# Security Model

> **Current state.** ✅ = verified at runtime against a local server on
> 2026-11-17. Everything else is *code-traced*. This is a description of
> existing controls and known gaps, not a security audit.

## Trust model

- **The room ID is the only credential.** Anyone who has the pairing URL
  (`/?s=<room>`) can join that room. The ID is `crypto.randomUUID()` without
  dashes (122 random bits), generated per desktop launch and shown only as a
  QR code.
- Because a same-role join replaces the existing member (✅ close `4001`),
  someone who knows the room ID could take over the phone *or* desktop slot.
  The replaced client is told and does not retry. There is no confirmation
  step on the desktop before a phone's video is accepted.
- No user accounts, no authentication, no stored user data on the server.

## Media

- Camera video and audio travel over WebRTC (DTLS-SRTP encrypted) directly
  between the phone and the desktop, or through a TURN relay if configured.
  The signaling server never receives media.
- Recordings are written only to the local disk of the PC.

## Signaling server controls

| Control | Detail |
|---|---|
| Origin allow-list | ✅ WebSocket upgrades from origins outside `ALLOWED_ORIGINS` (default `PUBLIC_ORIGIN`, `file://`) get 403. Note: `Origin` is enforced by browsers; non-browser clients can send any value. |
| Join rate limit | ✅ 10 join attempts per IP per minute, invalid attempts included. Uses `X-Forwarded-For` only with `TRUST_PROXY=1`. |
| Resource caps | `MAX_CONNECTIONS` (default 200), `MAX_ROOMS` (default 100), 64 KB max message, one desktop + one phone per room. |
| Input validation | ✅ Room must match `^[a-f0-9]{32}$`; role must be `desktop`/`phone`; messages must be JSON objects; `sig.data` must be an object. The contents of `sig.data` are **not** validated and are relayed as-is to the peer. |
| Heartbeat | 30 s ping; dead sockets are terminated. |
| HTTP headers | ✅ `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (keeps the room ID out of Referer headers), `X-Frame-Options: DENY`, and a CSP whose `connect-src` is limited to `'self'` and the `PUBLIC_ORIGIN` host. The CSP allows `'unsafe-inline'` scripts and styles because the pages use inline code. |
| TURN credentials | ✅ Short-lived (10 min) HMAC credentials per join; static credentials are refused without `TURN_SECRET`. |
| Startup validation | ✅ Invalid `ICE_SERVERS` aborts startup. |

## Desktop app controls

| Control | Detail |
|---|---|
| Renderer isolation | `contextIsolation: true`, `nodeIntegration: false`. `sandbox` is not set explicitly (Electron ≥ 20 sandboxes renderers by default in this configuration). |
| Narrow IPC | Only the channels listed in [ARCHITECTURE.md §3.5](ARCHITECTURE.md#35-ipc-surface-windowapi--ipcmainhandle). `rec:start` accepts only `webm`/`mp4`. `file:show`/`file:url` only accept the most recently saved recording. |
| Content Security Policy | `<meta>` CSP in `src/index.html`: `default-src 'self'`; `connect-src` limited to the Render origin; media from `file:`/`blob:`; images `data:`. |
| File safety | Recordings are never overwritten (hard link or `COPYFILE_EXCL`); startup cleanup only deletes files matching `.camshare-<hex>[.indexed].tmp`. |
| Screen capture | Goes through the in-app picker (`setDisplayMediaRequestHandler`); only screens are offered. |

## Known gaps (not implemented)

- No `will-navigate` / `setWindowOpenHandler` guards in `main.js`.
- No code signing for the Windows installer.
- No desktop-side approval of an incoming phone connection.
- No automated security tests, dependency audit, or CI.
- `ALLOWED_ORIGINS` includes `file://`, which any local HTML file opened in
  a browser also sends.

## Reporting

No security contact or disclosure policy is defined in the repository.
