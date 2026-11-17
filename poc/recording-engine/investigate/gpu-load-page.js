"use strict";
// Busy synthetic drawing every rAF (gradients, many moving rects, text; blur shadows at higher
// levels) to load the GPU. Level comes from the page URL (?level=1..4).
const LEVEL = Math.max(1, Math.min(8, Number(new URLSearchParams(location.search).get("level")) || 1));
const c = document.getElementById("c");
const dpr = window.devicePixelRatio || 1;
// Levels 5-8: WebGL full-window quad with an expensive fragment shader (GPU-bound, not CPU-bound).
if (LEVEL >= 5) {
  const ITER = { 5: 48, 6: 96, 7: 192, 8: 384 }[LEVEL];
  c.width = Math.round(innerWidth * dpr);
  c.height = Math.round(innerHeight * dpr);
  c.style.width = innerWidth + "px";
  c.style.height = innerHeight + "px";
  const gl = c.getContext("webgl");
  const vs = "attribute vec2 p; void main(){ gl_Position = vec4(p,0.0,1.0); }";
  const fs = `precision highp float; uniform float t; uniform vec2 r;
    void main(){ vec2 uv = gl_FragCoord.xy / r; vec3 col = vec3(0.0); vec2 z = uv * 2.0 - 1.0;
      for (int i = 0; i < ${ITER}; i++) { z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + vec2(sin(t*0.001+float(i)*0.01), cos(t*0.0013)) * 0.6;
        col += 0.5 + 0.5*cos(vec3(0.0,2.0,4.0) + length(z) + float(i)*0.05); z = clamp(z, -4.0, 4.0); }
      gl_FragColor = vec4(col / float(${ITER}), 1.0); }`;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const ut = gl.getUniformLocation(prog, "t"),
    ur = gl.getUniformLocation(prog, "r");
  const glFrame = (t) => {
    gl.viewport(0, 0, c.width, c.height);
    gl.uniform1f(ut, t);
    gl.uniform2f(ur, c.width, c.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(glFrame);
  };
  requestAnimationFrame(glFrame);
  throw new Error("webgl load running"); // stop the 2D path below (intentional)
}
const RECTS = [0, 400, 1500, 3000, 5000][LEVEL];
const BLUR = [0, 0, 0, 8, 16][LEVEL];
const PASSES = [0, 1, 1, 2, 3][LEVEL];
const g = c.getContext("2d");
function size() {
  c.width = Math.round(innerWidth * dpr);
  c.height = Math.round(innerHeight * dpr);
  c.style.width = innerWidth + "px";
  c.style.height = innerHeight + "px";
}
size();
addEventListener("resize", size);
function frame(t) {
  const W = c.width,
    H = c.height;
  for (let pass = 0; pass < PASSES; pass++) {
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, `hsl(${(t / 20 + pass * 40) % 360} 50% 30%)`);
    grad.addColorStop(1, `hsl(${(t / 13 + 180) % 360} 50% 20%)`);
    g.fillStyle = grad;
    g.globalAlpha = pass ? 0.5 : 1;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    g.shadowBlur = BLUR;
    g.shadowColor = BLUR ? "rgba(0,0,0,0.6)" : "transparent";
    for (let i = 0; i < RECTS; i++) {
      const x = ((i * 97 + t * 0.3 * ((i % 7) + 1) + pass * 31) % (W + 80)) - 40;
      const y = ((i * 53 + t * 0.2 * ((i % 5) + 1) + pass * 17) % (H + 80)) - 40;
      g.fillStyle = `hsla(${(i * 37 + t / 10) % 360} 70% 55% / 0.6)`;
      g.fillRect(x, y, 60, 40);
    }
    g.shadowBlur = 0;
  }
  g.fillStyle = "#d8e0e8";
  g.font = `${Math.round(14 * dpr)}px Consolas, monospace`;
  for (let i = 0; i < 30; i++) g.fillText(`synthetic GPU load L${LEVEL} ${Math.round(t)} line ${i}`, 20, 30 + i * 20 * dpr);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
