#!/usr/bin/env node
"use strict";
// Calibrates the synthetic GPU load (no capture, no recording): for each level, starts
// gpu-load.js, samples "\GPU Engine(*)\Utilization Percentage" with typeperf for 8 s after a 3 s
// settle, and reports all-process 3D utilisation (max over 3D engines per sample).
//   node poc/recording-engine/investigate/calibrate-load.js <outDir> [levels=2,3,4]
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"),
  path = require("path");
const OUT = process.argv[2];
const levels = (process.argv[3] || "2,3,4").split(",").map(Number);
const REPO = path.resolve(__dirname, "..", "..", "..");
const E = path.join(REPO, "node_modules", "electron", "dist", "electron.exe");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function load3d(csv) {
  const lines = fs.readFileSync(csv, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const parse = (l) => l.split('","').map((s) => s.replace(/^"|"$/g, ""));
  const head = parse(lines[0]);
  const cols = head.slice(1).map((h, i) => (/engtype_3D\)/.test(h) ? { i: i + 1, key: (/luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_\d+_eng_(\d+)/.exec(h) || []).slice(1).join("|") } : null)).filter(Boolean);
  const vals = lines.slice(1).map(parse).map((v) => {
    const per = {};
    for (const c of cols) {
      const x = Number(v[c.i]);
      if (Number.isFinite(x)) per[c.key] = (per[c.key] || 0) + x;
    }
    return Math.max(0, ...Object.values(per));
  });
  return { samples: vals.length, mean: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1), min: Math.min(...vals), max: Math.max(...vals) };
}
(async () => {
  const res = {};
  for (const L of levels) {
    const child = spawn(E, [path.join(__dirname, "gpu-load.js"), `--level=${L}`], { stdio: "ignore" });
    await sleep(3000);
    const csv = path.join(OUT, `calib-L${L}.csv`);
    spawnSync("typeperf", ["\\GPU Engine(*)\\Utilization Percentage", "-si", "1", "-sc", "8", "-o", csv, "-f", "CSV", "-y"], { windowsHide: true });
    child.kill();
    await sleep(1500);
    res[`L${L}`] = load3d(csv);
    console.log(`L${L}`, JSON.stringify(res[`L${L}`]));
  }
  fs.writeFileSync(path.join(OUT, "calibration.json"), JSON.stringify(res, null, 2));
})();
