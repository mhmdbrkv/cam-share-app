"use strict";
// CamShare Recording Engine POC: measurement + privacy markers (POC-only, not app code).
//
// Barcode: 26 square cells in one row: [white ref][black ref][20 value bits, LSB first][4 check bits].
// Canary: a grid of 12x12 checker tiles (TL/BR white, TR/BL black) drawn on top of the synthetic
//         test window. Every captured frame must show every canary not covered by POC overlays;
//         a missing canary means the captured pixels are not the test window (privacy failure).
// The same constants and functions are re-implemented in analyze.js; keep them in sync.
(function (g) {
  const BITS = 20;
  const CHECK = 4;
  const CELLS = 2 + BITS + CHECK;
  function check(v) {
    let c = 0;
    for (let i = 0; i < BITS; i += 4) c ^= (v >>> i) & 0xf;
    return c;
  }
  function cells(value) {
    const v = value & 0xfffff;
    const out = [1, 0];
    for (let i = 0; i < BITS; i++) out.push((v >>> i) & 1);
    const c = check(v);
    for (let i = 0; i < CHECK; i++) out.push((c >>> i) & 1);
    return out;
  }
  function draw(ctx, x, y, cell, value) {
    const cs = cells(value);
    for (let i = 0; i < cs.length; i++) {
      ctx.fillStyle = cs[i] ? "#ffffff" : "#000000";
      ctx.fillRect(x + i * cell, y, cell, cell);
    }
  }
  // lum(x, y) -> 0..255 luminance at an integer pixel. Returns the decoded value or null.
  function read(lum, x0, y0, cell) {
    const half = Math.max(0, Math.floor(cell * 0.25));
    const lv = [];
    for (let i = 0; i < CELLS; i++) {
      const cx = Math.round(x0 + (i + 0.5) * cell),
        cy = Math.round(y0 + 0.5 * cell);
      let s = 0,
        n = 0;
      for (let y = cy - half; y <= cy + half; y++)
        for (let x = cx - half; x <= cx + half; x++) {
          s += lum(x, y);
          n++;
        }
      lv.push(s / n);
    }
    if (!(lv[0] - lv[1] > 60)) return null;
    const thr = (lv[0] + lv[1]) / 2;
    let v = 0;
    for (let i = 0; i < BITS; i++) if (lv[2 + i] > thr) v |= 1 << i;
    let c = 0;
    for (let i = 0; i < CHECK; i++) if (lv[2 + BITS + i] > thr) c |= 1 << i;
    return c === check(v) ? v : null;
  }

  // Canary grid, in captured-window physical pixels.
  const C_SIZE = 12,
    C_STEP = 64,
    C_OFF = 16;
  // Excluded rects [x, y, w, h]: output stamps + screen barcode (0..992 x 0..100) and the
  // synthetic camera preview inside the test window (40,860 320x180, plus a 4 px margin).
  const C_EXCL = [
    [0, 0, 992, 100],
    [36, 856, 328, 188],
  ];
  const CAM_PREVIEW = { x: 40, y: 860, w: 320, h: 180 };
  const overlaps = (x, y, s, r) => x < r[0] + r[2] && x + s > r[0] && y < r[1] + r[3] && y + s > r[1];
  function positions(W, H) {
    const out = [];
    for (let y = C_OFF; y + C_SIZE <= H; y += C_STEP)
      for (let x = C_OFF; x + C_SIZE <= W; x += C_STEP)
        if (!C_EXCL.some((r) => overlaps(x, y, C_SIZE, r))) out.push([x, y]);
    return out;
  }
  function drawCanaries(ctx, list, within) {
    const h = C_SIZE / 2;
    for (const [x, y] of list) {
      if (within && !overlaps(x, y, C_SIZE, within)) continue;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x, y, h, h);
      ctx.fillRect(x + h, y + h, h, h);
      ctx.fillStyle = "#000000";
      ctx.fillRect(x + h, y, h, h);
      ctx.fillRect(x, y + h, h, h);
    }
  }
  // true when the tile at (x, y) is the expected checker
  function testCanary(lum, x, y) {
    const q = (cx, cy) => (lum(cx, cy) + lum(cx + 1, cy) + lum(cx, cy + 1) + lum(cx + 1, cy + 1)) / 4;
    const tl = q(x + 2, y + 2),
      tr = q(x + 8, y + 2),
      bl = q(x + 2, y + 8),
      br = q(x + 8, y + 8);
    return tl > 150 && br > 150 && tr < 100 && bl < 100;
  }
  g.Barcode = { BITS, CHECK, CELLS, check, cells, draw, read };
  g.Canary = { SIZE: C_SIZE, STEP: C_STEP, OFF: C_OFF, EXCL: C_EXCL, CAM_PREVIEW, positions, draw: drawCanaries, test: testCanary, overlaps };
})(window);
