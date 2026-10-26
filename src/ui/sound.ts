// Optional interface sounds, synthesized with Web Audio (no audio files).
// Silent unless the "sounds" setting is on — it is off by default.
import { appSettings } from "../platform/settings";

export type Sound =
  | "bitOn"
  | "bitOff"
  | "select"
  | "group"
  | "remove"
  | "op"
  | "copy"
  | "error"
  | "add"
  | "toggle";

let audioContext: AudioContext | null = null;
let lastSelect = 0;

function audio(): AudioContext {
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") void audioContext.resume();

  return audioContext;
}

interface Tone {
  frequency: number;
  duration: number;
  endFrequency?: number; // glide to this frequency
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}

function tone(note: Tone, volume: number) {
  const context = audio();
  const start = context.currentTime + (note.delay ?? 0);
  const peak = (note.gain ?? 0.2) * volume;
  const oscillator = context.createOscillator();
  const amplitude = context.createGain();

  oscillator.type = note.type ?? "sine";
  oscillator.frequency.setValueAtTime(note.frequency, start);

  if (note.endFrequency)
    oscillator.frequency.exponentialRampToValueAtTime(
      note.endFrequency,
      start + note.duration,
    );

  amplitude.gain.setValueAtTime(0.0001, start);
  amplitude.gain.exponentialRampToValueAtTime(peak, start + 0.006);
  amplitude.gain.exponentialRampToValueAtTime(0.0001, start + note.duration);

  oscillator.connect(amplitude).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + note.duration + 0.03);
}

const SOUNDS: Record<Sound, Tone[]> = {
  bitOn: [{ frequency: 880, endFrequency: 1320, duration: 0.07, gain: 0.18 }],
  bitOff: [{ frequency: 660, endFrequency: 440, duration: 0.07, gain: 0.16 }],
  select: [{ frequency: 1800, duration: 0.025, gain: 0.05, type: "triangle" }],
  group: [
    { frequency: 660, duration: 0.12, gain: 0.15 },
    { frequency: 990, duration: 0.18, gain: 0.15, delay: 0.08 },
  ],
  remove: [
    {
      frequency: 520,
      endFrequency: 260,
      duration: 0.16,
      gain: 0.14,
      type: "triangle",
    },
  ],
  op: [
    {
      frequency: 300,
      endFrequency: 900,
      duration: 0.09,
      gain: 0.12,
      type: "triangle",
    },
  ],
  copy: [
    { frequency: 1200, duration: 0.05, gain: 0.1 },
    { frequency: 1600, duration: 0.07, gain: 0.1, delay: 0.06 },
  ],
  error: [{ frequency: 180, duration: 0.12, gain: 0.08, type: "square" }],
  add: [{ frequency: 520, endFrequency: 780, duration: 0.12, gain: 0.14 }],
  toggle: [{ frequency: 1000, duration: 0.03, gain: 0.07, type: "triangle" }],
};

/** Plays a sound if sounds are enabled. Never throws. */
export function play(kind: Sound, force = false) {
  if (!force && !appSettings.get("sounds")) return;

  const volume = appSettings.get("sound_volume");
  if (volume <= 0) return;

  if (kind === "select") {
    const now = performance.now();
    if (now - lastSelect < 35) return; // a fast drag shouldn't buzz

    lastSelect = now;
  }

  try {
    for (const note of SOUNDS[kind]) tone(note, volume);
    if (import.meta.env.DEV) ((window as any).__sounds ??= []).push(kind);
  } catch {
    /* audio unavailable: stay silent */
  }
}
