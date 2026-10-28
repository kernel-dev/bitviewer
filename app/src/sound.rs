//! Interface sounds, synthesized (no audio files), as the web app's
//! ui/sound.ts: the same tones, each a glide with a 6 ms attack and an
//! exponential fade. Silent unless the "sounds" setting is on.

use std::cell::Cell;
use std::sync::OnceLock;
use std::sync::mpsc::{Sender, channel};
use std::time::Instant;

use crate::kit::App;

use crate::app_state;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sound {
    BitOn,
    BitOff,
    Select,
    Group,
    Remove,
    Op,
    Copy,
    Error,
    Add,
    Toggle,
}

#[derive(Clone, Copy)]
enum Wave {
    Sine,
    Triangle,
    Square,
}

#[derive(Clone, Copy)]
struct Tone {
    frequency: f32,
    /// Glides to this frequency.
    end: Option<f32>,
    duration: f32,
    gain: f32,
    wave: Wave,
    delay: f32,
}

const fn tone(frequency: f32, end: Option<f32>, duration: f32, gain: f32, wave: Wave, delay: f32) -> Tone {
    Tone { frequency, end, duration, gain, wave, delay }
}

fn tones(sound: Sound) -> Vec<Tone> {
    use Wave::*;
    match sound {
        Sound::BitOn => vec![tone(880.0, Some(1320.0), 0.07, 0.18, Sine, 0.0)],
        Sound::BitOff => vec![tone(660.0, Some(440.0), 0.07, 0.16, Sine, 0.0)],
        Sound::Select => vec![tone(1800.0, None, 0.025, 0.05, Triangle, 0.0)],
        Sound::Group => vec![tone(660.0, None, 0.12, 0.15, Sine, 0.0), tone(990.0, None, 0.18, 0.15, Sine, 0.08)],
        Sound::Remove => vec![tone(520.0, Some(260.0), 0.16, 0.14, Triangle, 0.0)],
        Sound::Op => vec![tone(300.0, Some(900.0), 0.09, 0.12, Triangle, 0.0)],
        Sound::Copy => vec![tone(1200.0, None, 0.05, 0.1, Sine, 0.0), tone(1600.0, None, 0.07, 0.1, Sine, 0.06)],
        Sound::Error => vec![tone(180.0, None, 0.12, 0.08, Square, 0.0)],
        Sound::Add => vec![tone(520.0, Some(780.0), 0.12, 0.14, Sine, 0.0)],
        Sound::Toggle => vec![tone(1000.0, None, 0.03, 0.07, Triangle, 0.0)],
    }
}

const RATE: u32 = 44_100;

/// The samples of `sound` at `volume` (as Web Audio would play them).
fn synthesize(sound: Sound, volume: f32) -> Vec<f32> {
    let notes = tones(sound);
    let length = notes.iter().map(|note| note.delay + note.duration + 0.03).fold(0.0, f32::max);
    let mut samples = vec![0.0f32; (length * RATE as f32) as usize + 1];
    for note in &notes {
        let peak = note.gain * volume;
        let start = (note.delay * RATE as f32) as usize;
        let count = ((note.duration + 0.03) * RATE as f32) as usize;
        let mut phase = 0.0f32;
        for i in 0..count {
            let t = i as f32 / RATE as f32;
            // exponential glide over the duration
            let frequency = match note.end {
                Some(end) if t < note.duration => note.frequency * (end / note.frequency).powf(t / note.duration),
                Some(end) => end,
                None => note.frequency,
            };
            phase = (phase + frequency / RATE as f32).fract();
            let wave = match note.wave {
                Wave::Sine => (phase * std::f32::consts::TAU).sin(),
                Wave::Triangle => 1.0 - 4.0 * (phase - 0.5).abs(),
                Wave::Square => {
                    if phase < 0.5 {
                        1.0
                    } else {
                        -1.0
                    }
                }
            };
            // 0.0001 → peak in 6 ms, then down to 0.0001 at the end (exponential)
            let attack = 0.006;
            let envelope = if t < attack {
                0.0001 * (peak / 0.0001).powf(t / attack)
            } else if t < note.duration {
                peak * (0.0001 / peak).powf((t - attack) / (note.duration - attack))
            } else {
                0.0001
            };
            if let Some(sample) = samples.get_mut(start + i) {
                *sample += wave * envelope;
            }
        }
    }
    samples
}

/// The audio thread: it owns the output device and plays what it is sent.
fn player() -> Option<&'static std::sync::Mutex<Sender<Vec<f32>>>> {
    static PLAYER: OnceLock<Option<std::sync::Mutex<Sender<Vec<f32>>>>> = OnceLock::new();
    PLAYER
        .get_or_init(|| {
            let (send, receive) = channel::<Vec<f32>>();
            std::thread::Builder::new()
                .name("sounds".into())
                .spawn(move || {
                    // audio unavailable: stay silent
                    let Ok((_stream, handle)) = rodio::OutputStream::try_default() else { return };
                    while let Ok(samples) = receive.recv() {
                        handle.play_raw(rodio::buffer::SamplesBuffer::new(1, RATE, samples)).ok();
                    }
                })
                .ok()
                .map(|_| std::sync::Mutex::new(send))
        })
        .as_ref()
}

thread_local! {
    static LAST_SELECT: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// Plays `sound` if sounds are on. Never fails.
pub fn play(sound: Sound, cx: &App) {
    if app_state::settings(cx).sounds {
        play_anyway(sound, cx);
    }
}

/// Plays `sound` even with sounds off (the test button in Settings).
pub fn play_anyway(sound: Sound, cx: &App) {
    let volume = app_state::settings(cx).sound_volume as f32;
    if volume <= 0.0 || !app_state::persists(cx) {
        return;
    }
    if sound == Sound::Select {
        // a fast drag shouldn't buzz
        let now = Instant::now();
        if LAST_SELECT.with(|last| last.get()).is_some_and(|last| now - last < std::time::Duration::from_millis(35)) {
            return;
        }
        LAST_SELECT.with(|last| last.set(Some(now)));
    }
    if let Some(player) = player()
        && let Ok(player) = player.lock()
    {
        player.send(synthesize(sound, volume)).ok();
    }
}

#[cfg(test)]
mod sound_tests {
    #[test]
    fn tones_have_their_length_and_stay_in_range() {
        let samples = super::synthesize(super::Sound::Group, 1.0);
        assert_eq!(samples.len(), ((0.08 + 0.18 + 0.03) * 44_100.0) as usize + 1);
        assert!(samples.iter().all(|s| s.abs() <= 0.31));
        assert!(samples.iter().any(|s| s.abs() > 0.05));
    }
}
