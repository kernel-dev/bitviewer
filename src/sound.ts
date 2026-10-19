// Optional interface sounds, synthesized with Web Audio (no audio files).
// Silent unless the "sounds" setting is on — it is off by default.
import { S } from "./settings";

export type Sound = "bitOn" | "bitOff" | "select" | "group" | "remove" | "op" | "copy" | "error" | "add" | "toggle";

let ctx: AudioContext | null = null;
let lastSelect = 0;

function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

interface Tone {
  freq: number;
  dur: number;
  to?: number; // glide to this frequency
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}

function tone(t: Tone, volume: number) {
  const c = audio();
  const start = c.currentTime + (t.delay ?? 0);
  const peak = (t.gain ?? 0.2) * volume;
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = t.type ?? "sine";
  osc.frequency.setValueAtTime(t.freq, start);
  if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + t.dur);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(peak, start + 0.006);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + t.dur);
  osc.connect(amp).connect(c.destination);
  osc.start(start);
  osc.stop(start + t.dur + 0.03);
}

const SOUNDS: Record<Sound, Tone[]> = {
  bitOn: [{ freq: 880, to: 1320, dur: 0.07, gain: 0.18 }],
  bitOff: [{ freq: 660, to: 440, dur: 0.07, gain: 0.16 }],
  select: [{ freq: 1800, dur: 0.025, gain: 0.05, type: "triangle" }],
  group: [
    { freq: 660, dur: 0.12, gain: 0.15 },
    { freq: 990, dur: 0.18, gain: 0.15, delay: 0.08 },
  ],
  remove: [{ freq: 520, to: 260, dur: 0.16, gain: 0.14, type: "triangle" }],
  op: [{ freq: 300, to: 900, dur: 0.09, gain: 0.12, type: "triangle" }],
  copy: [
    { freq: 1200, dur: 0.05, gain: 0.1 },
    { freq: 1600, dur: 0.07, gain: 0.1, delay: 0.06 },
  ],
  error: [{ freq: 180, dur: 0.12, gain: 0.08, type: "square" }],
  add: [{ freq: 520, to: 780, dur: 0.12, gain: 0.14 }],
  toggle: [{ freq: 1000, dur: 0.03, gain: 0.07, type: "triangle" }],
};

/** Plays a sound if sounds are enabled. Never throws. */
export function play(kind: Sound, force = false) {
  if (!force && !S.get("sounds")) return;
  const volume = S.get("sound_volume");
  if (volume <= 0) return;
  if (kind === "select") {
    const now = performance.now();
    if (now - lastSelect < 35) return; // a fast drag shouldn't buzz
    lastSelect = now;
  }
  try {
    for (const t of SOUNDS[kind]) tone(t, volume);
    if (import.meta.env.DEV) ((window as any).__sounds ??= []).push(kind);
  } catch {
    /* audio unavailable: stay silent */
  }
}
