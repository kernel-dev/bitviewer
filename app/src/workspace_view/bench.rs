//! `--bench`: drives the window the way the web app's benchmark drives the
//! browser (bench/ at the repository root runs both): opening, fast
//! scrolling, jumps, one bit flip per frame and one undo per frame, timing
//! every frame. Prints the results (and writes them as JSON with
//! --bench-json), waits a moment so the runner can read the memory, quits.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use bitviewer_core::workspace::parse_workspace_file;
use gpui_kit::*;
use serde_json::{Map, Value as Json, json};

use super::WorkspaceView;

/// How the benchmark was asked for.
pub struct BenchOptions {
    /// The workspace file's text, opened once the window is up.
    pub text: String,
    pub json: Option<PathBuf>,
}

#[derive(Clone, Copy)]
enum Phase {
    /// Letting the empty window settle.
    Settle(u32),
    /// The file was opened at this moment; waiting for its first frame.
    Opened(Instant),
    Warmup(u32),
    Scroll(u32),
    Jumps(u32),
    Flips(u32),
    Undos(u32),
    Idle(Instant),
}

pub struct Bench {
    phase: Phase,
    options: BenchOptions,
    last_frame: Option<Instant>,
    frames: Vec<Duration>,
    results: Map<String, Json>,
    /// When the current phase started (each phase stops after 20 s, as the
    /// web benchmark's do).
    phase_started: Instant,
}

const PHASE_BUDGET: Duration = Duration::from_secs(20);

/// Frame time statistics, in milliseconds.
pub fn frame_stats(frames: &[Duration]) -> Json {
    let mut ms: Vec<f64> = frames.iter().map(|d| d.as_secs_f64() * 1000.0).collect();
    ms.sort_by(f64::total_cmp);
    if ms.is_empty() {
        return Json::Null;
    }
    let at = |q: f64| ms[((ms.len() as f64 - 1.0) * q).round() as usize];
    let round = |v: f64| (v * 100.0).round() / 100.0;
    json!({
        "frames": ms.len(),
        "avg_ms": round(ms.iter().sum::<f64>() / ms.len() as f64),
        "p50_ms": round(at(0.5)),
        "p95_ms": round(at(0.95)),
        "max_ms": round(*ms.last().unwrap()),
        // a frame over 34 ms shows as a visible hitch (two missed 60 Hz frames)
        "slow_frames": ms.iter().filter(|v| **v > 34.0).count(),
    })
}

impl Bench {
    pub fn new(options: BenchOptions) -> Self {
        Bench { phase: Phase::Settle(20), options, last_frame: None, frames: Vec::new(), results: Map::new(), phase_started: Instant::now() }
    }

    /// Records the frames of the phase that just ended under `key`.
    fn close(&mut self, key: &str) {
        self.phase_started = Instant::now();
        let frames = std::mem::take(&mut self.frames);
        self.results.insert(key.into(), frame_stats(&frames));
    }
}

impl WorkspaceView {
    pub(super) fn bench_step(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let now = Instant::now();
        let count = self.state.len();
        let bench = self.bench.as_mut().unwrap();
        if let Some(last) = bench.last_frame {
            bench.frames.push(now - last);
        }
        bench.last_frame = Some(now);

        // each frame does one step, like one user input per frame
        let next = match bench.phase {
            Phase::Settle(1) => {
                // open the file: parse it and show it (timed until the next frame)
                let started = Instant::now();
                let file = parse_workspace_file(&bench.options.text).expect("the benchmark file opens");
                self.replace_state(file.state);
                Phase::Opened(started)
            }
            Phase::Settle(left) => Phase::Settle(left - 1),
            Phase::Opened(started) => {
                // this frame starts after the first frame with content was drawn
                let open = started.elapsed().as_secs_f64() * 1000.0;
                bench.results.insert("open_ms".into(), json!((open * 10.0).round() / 10.0));
                bench.frames.clear();
                Phase::Warmup(60)
            }
            Phase::Warmup(1) => {
                bench.frames.clear();
                bench.phase_started = Instant::now();
                Phase::Scroll(240)
            }
            Phase::Warmup(left) => Phase::Warmup(left - 1),
            Phase::Scroll(left) => {
                self.list.scroll_by(px(400.0)); // a fast wheel flick, every frame
                if left == 1 || bench.phase_started.elapsed() > PHASE_BUDGET {
                    bench.close("scroll");
                    Phase::Jumps(6)
                } else {
                    Phase::Scroll(left - 1)
                }
            }
            Phase::Jumps(left) => {
                let targets = [count / 2, count - 1, 0, count / 3, count * 9 / 10, 0];
                self.reveal_value(targets[6 - left as usize]);
                if left == 1 { Phase::Flips(30) } else { Phase::Jumps(left - 1) }
            }
            Phase::Flips(left) => {
                if left == 30 {
                    bench.close("jump");
                }
                let top = self.top_value();
                self.flip_bit(top, (left % 8) as usize, cx);
                if left == 1 { Phase::Undos(20) } else { Phase::Flips(left - 1) }
            }
            Phase::Undos(left) => {
                if left == 20 {
                    bench.close("flip");
                }
                self.undo_step(cx);
                if left == 1 { Phase::Idle(Instant::now()) } else { Phase::Undos(left - 1) }
            }
            Phase::Idle(since) => {
                if !bench.results.contains_key("undo") {
                    bench.close("undo");
                    bench.results.insert("app".into(), json!("native"));
                    bench.results.insert("values".into(), json!(count));
                    bench.results.insert("cards_alive".into(), json!(self.cards.len()));
                    let report = Json::Object(bench.results.clone());
                    println!("{}", serde_json::to_string_pretty(&report).unwrap());
                    if let Some(path) = &bench.options.json {
                        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap()).ok();
                    }
                    // the runner reads the process memory while it idles
                    println!("BENCH-IDLE pid={}", std::process::id());
                }
                if since.elapsed() > Duration::from_secs(4) {
                    cx.quit();
                }
                Phase::Idle(since)
            }
        };
        self.bench.as_mut().unwrap().phase = next;
        window.request_animation_frame();
    }
}

#[cfg(test)]
mod tests {
    // not `use super::*`: that brings in GPUI's `test` macro, which shadows #[test]
    use super::frame_stats;
    use std::time::Duration;

    #[test]
    fn summarizes_frames() {
        let frames: Vec<Duration> = [5, 6, 7, 40].iter().map(|ms| Duration::from_millis(*ms)).collect();
        let stats = frame_stats(&frames);
        assert_eq!(stats["frames"], 4);
        assert_eq!(stats["max_ms"], 40.0);
        assert_eq!(stats["slow_frames"], 1);
        assert_eq!(stats["p50_ms"], 7.0);
    }
}
