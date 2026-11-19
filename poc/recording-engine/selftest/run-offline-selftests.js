#!/usr/bin/env node
"use strict";
/*
 * Offline review self-tests for the POC privacy safeguards. NO desktop capture, NO real session.
 *   node poc/recording-engine/selftest/run-offline-selftests.js
 *
 * 1. capture-target.test.js           pure selector unit tests (Node)
 * 2. deny-request.js                  Electron: a denied display-media request yields no stream
 * 3. encoder-selftest.js              Electron: Chromium MediaRecorder encodes a SYNTHETIC canvas
 * 4. analyze.js on each variant       privacy verdict, exit code, image suppression
 * Outputs go to %USERPROFILE%\Videos\CamShare-POC\selftest-<timestamp>\ (outside the repository).
 */
const { spawnSync } = require("child_process");
const fs = require("fs"),
  path = require("path"),
  os = require("os");

const HERE = __dirname;
const REPO = path.resolve(HERE, "..", "..", "..");
const ELECTRON = path.join(REPO, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const p2 = (n) => String(n).padStart(2, "0");
const d = new Date();
const OUT = path.join(os.homedir(), "Videos", "CamShare-POC", `selftest-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`);
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

// 1. selector unit tests
const u = spawnSync(process.execPath, [path.join(HERE, "capture-target.test.js")], { encoding: "utf8" });
const um = /(\d+)\/(\d+) passed/.exec(u.stdout || "");
check("1. capture-target selector unit tests", u.status === 0, um ? `${um[1]}/${um[2]} cases` : u.stdout);

// 2. denied request -> no stream
const denyOut = path.join(OUT, "deny-request.jsonl");
spawnSync(ELECTRON, [path.join(HERE, "deny-request.js")], { env: { ...process.env, DENY_OUT: denyOut }, timeout: 45000, stdio: "ignore" });
let deny = null;
try {
  deny = fs.readFileSync(denyOut, "utf8").split("\n").filter(Boolean).map(JSON.parse).find((x) => x.final);
} catch {}
const df = deny && deny.final;
check("2a. denied display-media request: handler reached under the POC permission rule", df && df.handlerCalls === 1, df && { handlerCalls: df.handlerCalls, permissionRequests: df.permissionRequests });
check("2b. denied display-media request: page receives a rejection and no tracks", df && df.result && df.result.resolved === false && !df.result.pending, df && df.result);

// 3. Chromium MediaRecorder on a synthetic canvas
const encOut = path.join(OUT, "encoder");
const e = spawnSync(ELECTRON, [path.join(HERE, "encoder-selftest.js")], { env: { ...process.env, SELFTEST_OUT: encOut }, timeout: 150000, stdio: "ignore" });
check("3. encoder self-test completed (synthetic canvas, Chromium MediaRecorder)", e.status === 0, `exit ${e.status}`);

// 4. analyzer on each variant
const variants = ["A-clean", "B-foreign-15-frames", "C-foreign-1-frame", "D-no-instrumentation"];
const A = {};
for (const v of variants) {
  const dir = path.join(encOut, v);
  if (!fs.existsSync(path.join(dir, "summary.json"))) {
    check(`4. ${v}: run folder present`, false);
    continue;
  }
  const r = spawnSync(process.execPath, [path.join(HERE, "..", "analyze.js"), dir], { encoding: "utf8", timeout: 300000 });
  const adir = fs.readdirSync(dir).filter((f) => f.startsWith("analysis-")).map((f) => path.join(dir, f)).pop();
  const analysis = adir ? JSON.parse(fs.readFileSync(path.join(adir, "analysis.json"), "utf8")) : null;
  const imgs = adir ? fs.readdirSync(adir).filter((f) => /\.(png|jpe?g|bmp|gif|webp)$/i.test(f)) : [];
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
  A[v] = { exit: r.status, analysis, imgs, summary };
}
const pf = (v) => A[v] && A[v].analysis && A[v].analysis.metrics.content && A[v].analysis.metrics.content.value && A[v].analysis.metrics.content.value.privacy;
const crit = (v, id) => A[v] && A[v].analysis && (A[v].analysis.criteria.find((c) => c.id === id) || {}).result;

// A: clean
check("4A. clean: every frame passes (P.frames PASS)", crit("A-clean", "P.frames") === "PASS", pf("A-clean") && { failed: pf("A-clean").framesFailed, checked: pf("A-clean").framesChecked, canaries: pf("A-clean").canariesPerFrame });
check("4A. clean: privacy verdict PASS, exit 0", A["A-clean"] && A["A-clean"].exit === 0 && A["A-clean"].analysis.privacy.pass === true, A["A-clean"] && A["A-clean"].exit);
check("4A. clean: contact sheet generated (allowed only when privacy passes)", A["A-clean"] && A["A-clean"].imgs.includes("contact-sheet.png"), A["A-clean"] && A["A-clean"].imgs);
check("4A. clean: verifyCapture pixel checks pass on raw frame", A["A-clean"] && A["A-clean"].summary.pixelCheck.clean.failed === 0 && A["A-clean"].summary.pixelCheck.clean.code !== null, A["A-clean"] && A["A-clean"].summary.pixelCheck);
check("4A. verifyCapture pixel checks reject a raw frame with foreign content", A["A-clean"] && A["A-clean"].summary.pixelCheck.withForeign.failed > 0, A["A-clean"] && A["A-clean"].summary.pixelCheck.withForeign);

// B: 15 foreign frames
check("4B. 15 foreign frames: P.frames FAIL", crit("B-foreign-15-frames", "P.frames") === "FAIL", pf("B-foreign-15-frames") && { failed: pf("B-foreign-15-frames").framesFailed, foreignDrawn: A["B-foreign-15-frames"].summary.foreignDrawnFrames.length, runsPts: pf("B-foreign-15-frames").failedRunsPts });
check("4B. 15 foreign frames: run fails (exit 4, verdict FAIL)", A["B-foreign-15-frames"] && A["B-foreign-15-frames"].exit === 4 && A["B-foreign-15-frames"].analysis.privacy.pass === false, A["B-foreign-15-frames"] && A["B-foreign-15-frames"].exit);
check("4B. 15 foreign frames: NO image extracted", A["B-foreign-15-frames"] && A["B-foreign-15-frames"].imgs.length === 0, A["B-foreign-15-frames"] && (A["B-foreign-15-frames"].analysis.contactSheet || A["B-foreign-15-frames"].imgs));

// C: 1 foreign frame (only meaningful if Chromium encoded that frame)
const cvals = A["C-foreign-1-frame"] && A["C-foreign-1-frame"].analysis.metrics.content.value;
const cComp = cvals && cvals.comp;
const foreignC = A["C-foreign-1-frame"] && A["C-foreign-1-frame"].summary.foreignDrawnFrames[0];
const encodedForeign = cComp && foreignC !== undefined && foreignC >= cComp.first && foreignC <= cComp.last;
check("4C. single foreign frame was inside the encoded range", encodedForeign, cComp && { foreignFrame: foreignC, encodedRange: [cComp.first, cComp.last], missingFramesInFile: cComp.missing });
check("4C. single foreign frame: P.frames FAIL and exit 4", crit("C-foreign-1-frame", "P.frames") === "FAIL" && A["C-foreign-1-frame"].exit === 4, pf("C-foreign-1-frame") && { failed: pf("C-foreign-1-frame").framesFailed, runsPts: pf("C-foreign-1-frame").failedRunsPts });
check("4C. single foreign frame: NO image extracted", A["C-foreign-1-frame"] && A["C-foreign-1-frame"].imgs.length === 0, A["C-foreign-1-frame"] && A["C-foreign-1-frame"].imgs);

// D: instrumentation cost (bitrate) — measured, no pass/fail threshold
const kb = (v) => A[v] && A[v].analysis.metrics.timing && A[v].analysis.metrics.timing.value && A[v].analysis.metrics.timing.value.videoKbps;
const info = {
  mime: A["A-clean"] && A["A-clean"].summary.recStarted.mime,
  kbpsWithInstrumentation: kb("A-clean") && Math.round(kb("A-clean")),
  kbpsWithoutInstrumentation: kb("D-no-instrumentation") && Math.round(kb("D-no-instrumentation")),
  clean: A["A-clean"] && { genuineDecodeErrors: A["A-clean"].analysis.metrics.decode.value.genuineErrorLines, compDecodeShare: cvals && A["A-clean"].analysis.metrics.content.value.compDecodeShare, frames: A["A-clean"].analysis.metrics.timing.value.frames },
};
console.log("\nINFO (measured, no threshold):", JSON.stringify(info));
const passed = results.filter((r) => r.pass).length;
fs.writeFileSync(path.join(OUT, "selftest-report.json"), JSON.stringify({ when: new Date().toISOString(), electron: process.versions, results, info }, null, 2));
console.log(`\n${passed}/${results.length} checks passed · outputs: ${OUT}`);
process.exit(passed === results.length ? 0 : 1);
