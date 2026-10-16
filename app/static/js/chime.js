// Chimes are generated with the Web Audio API, so there are no sound files.
// Each preset: waveform + notes as [frequency Hz, start offset s, length s].
// Keep the keys in step with CHIME_SOUNDS in app/routers/settings.py.
export const CHIMES = {
  bells: { name: "Bells", wave: "triangle", notes: [[1319, 0, 1.6], [1568, 0.22, 1.6], [2093, 0.44, 1.8]] },
  dingdong: { name: "Ding-dong", wave: "sine", notes: [[659, 0, 1.4], [523, 0.45, 1.8]] },
  marimba: { name: "Marimba", wave: "triangle", notes: [[523, 0, 0.45], [659, 0.12, 0.45], [784, 0.24, 0.45], [1047, 0.36, 0.8]] },
  chirp: { name: "Chirp", wave: "sine", notes: [[1760, 0, 0.35], [2217, 0.1, 0.35], [1760, 0.3, 0.35], [2217, 0.4, 0.6]] },
  harp: { name: "Harp", wave: "sine", notes: [[392, 0, 1.2], [494, 0.09, 1.2], [587, 0.18, 1.2], [784, 0.27, 1.2], [988, 0.36, 1.6]] },
  windchime: { name: "Wind chime", wave: "sine", notes: [[2349, 0, 1.4], [1976, 0.17, 1.4], [2637, 0.31, 1.4], [2093, 0.5, 1.8]] },
  xylophone: { name: "Xylophone", wave: "square", gain: 0.35, notes: [[1047, 0, 0.3], [1319, 0.15, 0.3], [1568, 0.3, 0.3], [1319, 0.45, 0.3], [1568, 0.6, 0.6]] },
  doorbell: { name: "Doorbell", wave: "sine", notes: [[784, 0, 1.0], [659, 0.5, 1.0], [784, 1.0, 1.0], [659, 1.5, 1.6]] },
  family: { name: "Family fanfare", wave: "triangle", notes: [[523, 0, 0.5], [659, 0.18, 0.5], [784, 0.36, 0.5], [1047, 0.6, 1.6], [784, 0.6, 1.6], [659, 0.6, 1.6]] },
};

let ctx = null;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

// Browsers only allow sound after the page has been touched (unless the kiosk
// is started with --autoplay-policy=no-user-gesture-required).
export function unlockAudio() {
  const a = audio();
  if (a && a.state === "suspended") a.resume();
}
export function audioReady() {
  const a = audio();
  return !!a && a.state === "running";
}

export const chimeLength = (key) => {
  const c = CHIMES[key] || CHIMES.bells;
  return Math.max(...c.notes.map(([, dt, len]) => dt + len * 0.5));
};

export function playChime(key, { remind = false, volume = 70, at = 0 } = {}) {
  const a = audio();
  if (!a) return;
  const c = CHIMES[key] || CHIMES.bells;
  const t0 = a.currentTime + 0.05 + at;
  const notes = remind ? c.notes.slice(0, 2) : c.notes;
  const chord = new Set(c.notes.map((n) => n[1])).size < c.notes.length;
  const peak = (remind ? 0.14 : 0.28) * (volume / 100) * (c.gain || 1) / (chord ? 2 : 1);
  for (const [f, dt, len] of notes) {
    const o = a.createOscillator(), g = a.createGain();
    o.type = c.wave;
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + dt);
    g.gain.linearRampToValueAtTime(peak, t0 + dt + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0006, t0 + dt + len);
    o.connect(g).connect(a.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + len + 0.05);
  }
}

// Several people's things starting together: each chime plays in turn.
export function playSequence(keys, opts = {}) {
  let at = 0;
  for (const k of keys) {
    playChime(k, { ...opts, at });
    at += chimeLength(k) + 0.35;
  }
}
