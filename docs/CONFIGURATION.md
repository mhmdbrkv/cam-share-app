# Configuration

> **Current state** as implemented in `server/server.js`, `src/main.js`,
> `src/renderer.js`, and `src/index.html`. ✅ = verified at runtime on
> 2026-11-17 against a local server; everything else is *code-traced*.

## Signaling server (`server/server.js`)

All configuration is through environment variables. No `.env` loader is
used (`.env*` files are git-ignored but nothing reads them).

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listen port. |
| `PUBLIC_ORIGIN` | `https://cam-share-app.onrender.com` | Public origin of the server. Used as (a) the default allowed WebSocket `Origin`, (b) the `connect-src` host in the CSP header of served pages (✅), and (c) the base for URL parsing. Must be a valid URL or the server fails at startup. |
| `ALLOWED_ORIGINS` | `${PUBLIC_ORIGIN},file://` | Comma-separated allow-list for the WebSocket `Origin` header. Trailing `/` is stripped. ⚠️ Setting this **replaces** the default, so you must list `file://` yourself or the desktop app will be rejected. |
| `TRUST_PROXY` | unset | When exactly `1`, the first `X-Forwarded-For` entry is used as the client IP for join rate limiting. Enable only behind a trusted proxy (Render); otherwise clients can spoof it. |
| `MAX_CONNECTIONS` | `200` | Global open-WebSocket cap (HTTP 503 above it). Non-numeric values become `NaN`, which **disables** the cap. |
| `MAX_ROOMS` | `100` | Cap on concurrent rooms (close `1013` when creating a new room above it). Non-numeric values disable the cap. |
| `ICE_SERVERS` | Google STUN ×3 (✅) | JSON array of `RTCIceServer` objects sent to clients. Validated at startup: must be a non-empty array; each `urls` must be a string or a non-empty string array; `username`/`credential`, if present, must be strings. Invalid JSON or shape → startup error. |
| `TURN_SECRET` | unset | TURN REST shared secret. When set, each join receives freshly minted credentials on every entry whose URLs include `turn:`/`turns:` (✅). Required if any `ICE_SERVERS` entry contains `username`/`credential` (✅ startup error otherwise). |
| `TURN_USERNAME` | `camshare` | Middle part of the generated TURN username. Not mentioned in the previous README. |

Fixed values (not configurable): join rate limit of 10 attempts / IP / 60 s,
64 KB max message size, 30 s heartbeat, 10-minute TURN credential lifetime.

### TURN credentials (✅ verified)

With `TURN_SECRET` set, the server generates per join:

```
username   = "<unix expiry = now + 600>:<TURN_USERNAME>:<16 random hex>"
credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
```

This is the standard TURN REST API scheme (for example coturn
`use-auth-secret`). Do not put static TURN credentials in `ICE_SERVERS`.
Example:

```json
[{"urls":["turn:turn.example.com:3478"]}]
```

Compatibility with any specific TURN provider is **unverified**.

## Desktop app

| Setting | Where | Effect |
|---|---|---|
| `SERVER_URL` env var | `src/main.js` (`cfg:get`) | Overrides the signaling/pairing server. Default `https://cam-share-app.onrender.com`. |
| `SERVER_URL` constant | `src/renderer.js` line 1 | Initial value only. **It is always overwritten** by the value from `cfg:get` (which always returns a value), so editing it alone has no effect. |
| CSP `connect-src` | `src/index.html` `<meta>` | Hard-codes `https://cam-share-app.onrender.com` and `wss://cam-share-app.onrender.com`. Any other server is blocked by the CSP unless this is edited too. |
| Save folder | UI **Change folder** | Defaults to `<Videos>/CamShare`. Not persisted between launches. |
| Recording mode, PC mic, PiP size | UI | Not persisted between launches. |

### Pointing the desktop app at a different server

To change the server, **both** of these are needed *(code-traced, not
tested)*:

1. Provide the URL: set `SERVER_URL` in the app's environment, or change the
   default in `src/main.js`. For an installed build, an environment variable
   is impractical, so a source change plus rebuild is effectively required.
2. Add the new `https://` and `wss://` origins to `connect-src` in
   `src/index.html`.

On the server side, set `PUBLIC_ORIGIN` to the new domain (and include
`file://` if you set `ALLOWED_ORIGINS`).

## Hard-coded external references

| Value | Location |
|---|---|
| `https://cam-share-app.onrender.com` | `src/main.js`, `src/renderer.js`, `src/index.html` CSP, `server/server.js` default |
| Google STUN `stun{,1,2}.l.google.com:19302` | `server/server.js`, `src/renderer.js` initial value, `server/public/m.html` initial value (2 entries) |
| `github.com/mhmdbrkv/cam-share-app` (repo + release download) | `server/public/index.html` |
| `appId: com.mhmdbrkv.camshare` | `package.json` `build` |
