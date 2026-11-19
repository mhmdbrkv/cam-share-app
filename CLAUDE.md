# CLAUDE.md

CamShare: Electron (Windows) screen recorder with a phone camera PiP overlay,
paired through a Node `ws` signaling server on Render. Start with
[README.md](README.md).

## Where to look

- Approved V1 product spec (target behaviour, V2 deferrals):
  [docs/V1-SPECIFICATION.md](docs/V1-SPECIFICATION.md)
- Current state, V1 gap analysis, conflicts (C1–C7), open questions:
  [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md). **Read this before
  claiming or implementing any feature.**
- How it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Wire protocol: [docs/SIGNALING_PROTOCOL.md](docs/SIGNALING_PROTOCOL.md)
- Env vars and hard-coded URLs: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
- Deploy and release: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Security model: [docs/SECURITY.md](docs/SECURITY.md)
- User-facing errors: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

## Commands

- `npm start`: desktop app
- `npm run server`: signaling server (port `PORT` or 8080)
- `npm run dist`: Windows NSIS installer in `dist/`
- There are no test, lint, or CI scripts. Don't claim tests pass.

## Rules

- Use the versions in `package.json` (Electron `^33.0.0`). Don't assume
  newer Electron/Node APIs.
- Windows is the only current platform. macOS is a V1 target: never describe
  macOS as working unless it has actually been tested.
- Keep three states apart in docs and status reports: **Current**
  (implemented and checked), **V1 target**, and **V2 / deferred**. Code
  existing is not the same as verified; use the legend in PROJECT-STATUS.md.
- Don't implement V2-scoped features as part of V1 work. Only the features
  listed in V1-SPECIFICATION.md §6 are V2. "Unsupported" (for example
  lock-screen/sleep continuity) is not the same as V2.
- The Canvas + MediaRecorder approach is not production-ready until the
  POC criteria (V1-SPECIFICATION.md §5) pass on Windows and macOS.
  `backgroundThrottling: false` is under test, not an approved final
  solution.
- Where the spec doesn't decide something, add an open question to
  PROJECT-STATUS.md §6 instead of choosing an answer.
- Changing the server domain needs three coordinated edits: `SERVER_URL` in
  `src/main.js` (or env), the CSP `connect-src` in `src/index.html`, and
  `PUBLIC_ORIGIN` on the server. See CONFIGURATION.md.
- Keep the security posture: `contextIsolation` on, `nodeIntegration` off,
  new main-process capabilities only through narrow `ipcMain.handle`
  channels in `src/preload.js`.
- `server/` isn't packaged into the installer; `src/` is.
- Don't commit, push, rewrite history, or discard or restore working-tree
  changes unless the user asks.
- When behaviour changes, update `docs/PROJECT-STATUS.md` and the affected
  doc in the same change.
