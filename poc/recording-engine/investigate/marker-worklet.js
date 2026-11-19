"use strict";
// AudioWorklet marker generator for the offline A/V experiment (synthetic audio only).
// On {cmd:"fire"} it starts a 100 ms, 1 kHz, 0.5-amplitude tone at the FIRST sample of the next
// render quantum and posts {n, frame, time} where frame/time are the AudioWorkletGlobalScope
// currentFrame/currentTime of that first tone sample, sent from inside process(), i.e. at the
// moment the tone is rendered.
class MarkerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = 0;
    this.remaining = 0;
    this.phase = 0;
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === "fire") this.pending++;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const len = out[0].length;
    if (this.pending > 0 && this.remaining <= 0) {
      this.pending--;
      this.n++;
      this.remaining = Math.round(sampleRate * 0.1);
      this.phase = 0;
      this.port.postMessage({ n: this.n, frame: currentFrame, time: currentTime });
    }
    for (let i = 0; i < len; i++) {
      let v = 0;
      if (this.remaining > 0) {
        v = 0.5 * Math.sin(this.phase);
        this.phase += (2 * Math.PI * 1000) / sampleRate;
        this.remaining--;
      }
      for (let ch = 0; ch < out.length; ch++) out[ch][i] = v;
    }
    return true;
  }
}
registerProcessor("marker", MarkerProcessor);
