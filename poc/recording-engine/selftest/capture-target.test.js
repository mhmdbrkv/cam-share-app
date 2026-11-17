"use strict";
// Unit tests for capture-target.js. Pure Node, no Electron, no capture.
//   node poc/recording-engine/selftest/capture-target.test.js
const assert = require("assert");
const { decideCaptureSource } = require("../capture-target");

const TITLE = "CamShare POC pattern 0123456789abcdef";
const HWND = "394868";
const target = { mediaSourceId: `window:${HWND}:1`, hwnd: HWND, title: TITLE };
const ok = { id: `window:${HWND}:0`, name: TITLE };
const other = { id: "window:111:0", name: "Some other app" };
const screenSrc = { id: "screen:0:0", name: "Entire screen" };

const cases = [
  ["happy path: exactly one window with the HWND and the recorder's title", { sources: [other, ok], target, expectedTitle: TITLE }, true],
  ["screen source only -> deny", { sources: [screenSrc], target, expectedTitle: TITLE }, false],
  ["screen source + others, target missing -> deny (no fallback)", { sources: [screenSrc, other], target, expectedTitle: TITLE }, false],
  ["no sources -> deny", { sources: [], target, expectedTitle: TITLE }, false],
  ["sources not an array -> deny", { sources: null, target, expectedTitle: TITLE }, false],
  ["no target registered -> deny", { sources: [ok], target: null, expectedTitle: TITLE }, false],
  ["expected title missing -> deny", { sources: [ok], target, expectedTitle: undefined }, false],
  ["expected title malformed -> deny", { sources: [ok], target, expectedTitle: "CamShare POC pattern X" }, false],
  ["target reports a different title than the recorder generated -> deny", { sources: [ok], target: { ...target, title: "CamShare POC pattern ffffffffffffffff" }, expectedTitle: TITLE }, false],
  ["target media source id is a screen id -> deny", { sources: [ok], target: { ...target, mediaSourceId: "screen:0:0" }, expectedTitle: TITLE }, false],
  ["HWND in media source id != native handle -> deny", { sources: [ok], target: { ...target, mediaSourceId: "window:999:1" }, expectedTitle: TITLE }, false],
  ["HWND malformed -> deny", { sources: [ok], target: { ...target, hwnd: "0x6067" }, expectedTitle: TITLE }, false],
  ["matching HWND but wrong name -> deny", { sources: [{ ...ok, name: "Other" }], target, expectedTitle: TITLE }, false],
  ["two sources with the same HWND -> deny", { sources: [ok, { id: `window:${HWND}:2`, name: TITLE }], target, expectedTitle: TITLE }, false],
  ["right title on a different HWND only (look-alike) -> deny", { sources: [{ id: "window:222:0", name: TITLE }], target, expectedTitle: TITLE }, false],
  ["right window plus a look-alike title elsewhere -> deny (title not unique)", { sources: [ok, { id: "window:222:0", name: TITLE }], target, expectedTitle: TITLE }, false],
  ["HWND as a prefix of another HWND must not match", { sources: [{ id: `window:${HWND}1:0`, name: TITLE }], target, expectedTitle: TITLE }, false],
  ["screen source with the title as its name -> deny", { sources: [{ id: `screen:${HWND}:0`, name: TITLE }], target, expectedTitle: TITLE }, false],
  ["malformed source entries are ignored, not matched", { sources: [null, {}, { id: 5 }, ok], target, expectedTitle: TITLE }, true],
];

let pass = 0;
for (const [name, input, expectOk] of cases) {
  const r = decideCaptureSource(input);
  try {
    assert.strictEqual(r.ok, expectOk, `${name}: expected ok=${expectOk}, got ${JSON.stringify(r)}`);
    if (expectOk) {
      assert.ok(/^window:\d+:\d+$/.test(r.src.id), "granted source must be a window source");
      assert.strictEqual(r.src.id, ok.id);
    } else assert.ok(!("src" in r), "a denial must not carry a source");
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
