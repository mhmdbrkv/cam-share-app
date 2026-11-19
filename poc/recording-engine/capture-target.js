"use strict";
// CamShare Recording Engine POC: capture-target decision (pure function, unit-tested).
//
// Given the window sources listed by desktopCapturer, the identity reported by the synthetic
// test-window process, and the title the RECORDER generated for this run, decide which single
// source may be granted. Returns { ok: true, src } or { ok: false, reason, details }.
// The caller must deny the request whenever ok !== true. There is no fallback of any kind.
//
// Identity (all required):
//   - source id has the window form "window:<HWND>:<n>" (screen sources can never match)
//   - <HWND> equals the native handle reported for the test window
//   - the HWND inside the test window's getMediaSourceId() equals that same handle
//   - exactly one listed source has that HWND
//   - that source's name equals the recorder-generated title, and the title is unique
const WINDOW_ID = /^window:(\d+):\d+$/;
const TITLE = /^CamShare POC pattern [0-9a-f]{16}$/;

function decideCaptureSource({ sources, target, expectedTitle }) {
  const no = (reason, details = {}) => ({ ok: false, reason, details });
  if (!Array.isArray(sources)) return no("sources is not an array");
  if (typeof expectedTitle !== "string" || !TITLE.test(expectedTitle)) return no("expected title missing or malformed");
  if (!target || typeof target !== "object") return no("no capture target registered");
  const { mediaSourceId, hwnd, title } = target;
  if (typeof hwnd !== "string" || !/^\d+$/.test(hwnd)) return no("target HWND missing or malformed");
  const idm = typeof mediaSourceId === "string" ? WINDOW_ID.exec(mediaSourceId) : null;
  if (!idm) return no("target media source id is not a window id");
  if (idm[1] !== hwnd) return no("HWND in media source id does not match the native window handle");
  if (title !== expectedTitle) return no("test window reported a different title than the recorder generated");
  const hwndOf = (s) => {
    const m = s && typeof s.id === "string" ? WINDOW_ID.exec(s.id) : null;
    return m ? m[1] : null;
  };
  const matches = sources.filter((s) => hwndOf(s) === hwnd);
  if (matches.length !== 1) return no("target window HWND not found exactly once among window sources", { matches: matches.length, windowSourcesListed: sources.length });
  const src = matches[0];
  if (src.name !== expectedTitle) return no("target window title mismatch", { titleMatched: false });
  const sameTitle = sources.filter((s) => s && s.name === expectedTitle).length;
  if (sameTitle !== 1) return no("expected title is not unique among window sources", { sameTitle });
  return { ok: true, src };
}

module.exports = { decideCaptureSource, WINDOW_ID, TITLE };
