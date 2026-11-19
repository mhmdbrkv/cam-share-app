// Presentation only. Reads what renderer.js already exposes (body[data-state], body[data-screen],
// the #cam / #st text and the mode/audio inputs) and updates the guided-setup steps, headings,
// hints and the recording timer. It never calls into or changes recording, audio, pairing or
// save logic, and it draws nothing on the canvas (so nothing here ends up in a recording).
(() => {
  const el = (id) => document.getElementById(id);
  const body = document.body;
  const ACTIVE = ["preparing", "recording", "finalizing"];

  const HEAD = {
    idle: ["Preview", "Arrange the camera, then press Record.", "Live preview"],
    selecting: ["Preview", "Choose a screen in the window that opened.", "Choosing screen"],
    error: ["Preview", "Something needs attention. See the message below.", "Live preview"],
    preparing: ["Getting ready…", "Starting the recorder.", "Starting"],
    recording: ["Recording", "You can still move and resize the camera.", "Rec"],
    finalizing: ["Saving…", "Finishing the file. Keep CamShare open.", "Saving"],
    completed: ["Done", "Your recording is saved on this PC.", "Saved"],
  };

  let timerStart = 0,
    timerId = null,
    lastState = null;

  const fmt = (ms) => {
    const s = Math.floor(ms / 1000),
      h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      pad = (n) => String(n).padStart(2, "0");
    return (h ? h + ":" + pad(m) : pad(m)) + ":" + pad(s % 60);
  };
  function tick() {
    el("ui-timer").textContent = fmt(performance.now() - timerStart);
  }

  function phoneState() {
    const t = el("cam").textContent.trim();
    if (t === "Phone: connected") return "connected";
    if (/disconnected|failed|closed|took over/i.test(t)) return "problem";
    return "waiting";
  }
  const mode = () =>
    (document.querySelector("input[name=mode]:checked") || {}).value || "cam";

  function render() {
    const state = body.dataset.state || "idle",
      screen = body.dataset.screen === "yes",
      phone = phoneState(),
      screenOnly = mode() === "screen";
    body.dataset.phone = phone;

    // Timer: starts when the recorder has really started (state "recording"), freezes while saving.
    if (state !== lastState) {
      if (state === "recording") {
        timerStart = performance.now();
        tick();
        clearInterval(timerId);
        timerId = setInterval(tick, 250);
        const micOn = el("aud").checked && !/no audio/i.test(el("st").textContent);
        el("ui-rec-detail").textContent =
          (mode() === "cam" ? "Screen + camera" : "Screen only") +
          " · Microphone " +
          (micOn ? "on" : "off");
      } else {
        clearInterval(timerId);
        timerId = null;
        if (state === "preparing") el("ui-timer").textContent = "00:00";
      }
      el("ui-rec-title").textContent =
        state === "finalizing" ? "Saving the recording" : "Recording in progress";
      lastState = state;
    }

    // Guided steps: 1 phone (optional in Screen only), 2 screen, 3 record.
    const pairDone = phone === "connected",
      steps = {
        pair: el("step-pair"),
        screen: el("step-screen"),
        record: el("step-record"),
      };
    const current = !pairDone && !screenOnly ? "pair" : !screen ? "screen" : "record";
    steps.pair.classList.toggle("done", pairDone);
    steps.screen.classList.toggle("done", screen);
    for (const [k, li] of Object.entries(steps))
      li.classList.toggle("current", k === current && !ACTIVE.includes(state));

    el("ui-pair-sub").textContent = pairDone
      ? "Phone camera connected"
      : screenOnly
        ? "Optional: not needed for Screen only"
        : "Scan the code with your phone's camera";
    el("ui-screen-sub").textContent = screen ? "Screen selected" : "Pick the display to record";
    el("ui-screen-label").textContent = screen ? "Change" : "Select";
    el("ui-record-sub").textContent = ACTIVE.includes(state)
      ? "You can still resize the camera"
      : "Check the options, then press Record";

    // Heading, badge and hint.
    const [title, sub, badge] = HEAD[state] || HEAD.idle;
    el("ui-title").textContent = title;
    el("ui-subtitle").textContent = sub;
    el("ui-badge-text").textContent =
      state === "idle" && !screen ? "No screen yet" : badge;

    // setState() without a message shows the bare state name ("idle", "finalizing"…); hide that
    // and let the hint below speak instead.
    const stText = el("st").textContent.trim();
    el("st").hidden = Object.prototype.hasOwnProperty.call(HEAD, stText) ||
      ["preparing", "finalizing"].includes(stText);
    let hint = "";
    if (["idle", "error", "selecting"].includes(state)) {
      if (!screen) hint = "Choose a screen to start.";
      else if (!screenOnly && !pairDone)
        hint = "Connect your phone first, or switch to Screen only.";
      else hint = "Ready to record.";
    } else if (state === "finalizing" && el("st").hidden) {
      hint = "Saving your recording…";
    }
    el("ui-hint").textContent = hint === stText ? "" : hint;

    body.classList.toggle(
      "has-warning",
      state === "completed" && el("st").textContent.trim() !== "Completed",
    );
  }

  new MutationObserver(render).observe(body, {
    attributes: true,
    attributeFilter: ["data-state", "data-screen"],
  });
  for (const id of ["cam", "st"])
    new MutationObserver(render).observe(el(id), {
      childList: true,
      characterData: true,
      subtree: true,
    });
  document
    .querySelectorAll("input[name=mode]")
    .forEach((input) => input.addEventListener("change", render));
  render();
})();
