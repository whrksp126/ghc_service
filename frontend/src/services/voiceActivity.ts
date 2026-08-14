import { create } from 'zustand';

/**
 * Discord-style voice activity detection. Each audio track (local mic + remote
 * participants) is tapped by a Web Audio AnalyserNode; a single timer loop computes a
 * smoothed RMS level per participant key (`${userId}:${deviceId}`) and publishes it to
 * a Zustand store. UI (FeedCard glow + waveform, dock ring) subscribes per key.
 *
 * The analyser only reads the track — it is never connected to the audio destination —
 * so it adds no playback / echo. Remote audio is still played by the <audio> sinks.
 *
 * PERF: this store drives React re-renders, so the loop is deliberately frugal:
 *  - a 80ms setInterval (not rAF) → 12 wakeups/sec instead of one per display frame
 *    (a 120Hz laptop panel was running this callback 120×/sec just to throttle itself),
 *  - paused entirely while the tab is hidden (what rAF used to do for free),
 *  - levels are QUANTIZED and the store is only written when something actually changed,
 *    so a silent room produces ZERO store writes → zero renders. Before this, near-zero
 *    noise floor jitter re-rendered RoomPage (and every tile) ~12×/sec forever.
 */

interface VoiceState {
  levels: Record<string, number>;
  setLevels: (levels: Record<string, number>) => void;
}

export const useVoiceStore = create<VoiceState>()((set) => ({
  levels: {},
  setLevels: (levels) => set({ levels }),
}));

/** RMS above this counts as "speaking". */
export const SPEAKING_THRESHOLD = 0.045;

interface Entry {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  /** Un-quantized smoothed RMS. The decay must run on this, not on the published (quantized)
   *  value — feeding a rounded number back into the decay makes it round back up and stick. */
  level: number;
}

let ctx: AudioContext | null = null;
const entries = new Map<string, Entry>();
let timer: number | null = null;
let visibilityBound = false;

// Quantization has to stay finer than the user-tunable gate threshold (THRESHOLD_MIN = 0.005),
// so the most sensitive setting still opens the gate.
/** Store writes are quantized to this step so noise-floor jitter can't re-render the UI. */
const LEVEL_STEP = 0.01;
/** Anything below this reads as silence and is pinned to exactly 0 (one stable value). */
const SILENCE_FLOOR = 0.004;

function quantize(v: number): number {
  if (v < SILENCE_FLOOR) return 0;
  return Math.round(v / LEVEL_STEP) * LEVEL_STEP;
}

function ensureCtx(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tick() {
  if (entries.size === 0) { stopLoop(); return; }

  const prev = useVoiceStore.getState().levels;
  const next: Record<string, number> = {};
  let changed = false;
  for (const [key, e] of entries) {
    e.analyser.getByteTimeDomainData(e.data);
    let sum = 0;
    for (let i = 0; i < e.data.length; i++) {
      const v = (e.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / e.data.length);
    // Fast attack, slow decay so the indicator doesn't strobe between syllables.
    e.level = Math.max(rms, e.level * 0.8);
    const level = quantize(e.level);
    next[key] = level;
    if (prev[key] !== level) changed = true;
  }
  // A key disappearing also counts as a change (detachVoice handles removal, but a stale
  // key here would otherwise be republished forever).
  if (!changed && Object.keys(prev).length !== entries.size) changed = true;
  if (changed) useVoiceStore.getState().setLevels(next);
}

function startLoop() {
  if (timer !== null || entries.size === 0) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  timer = window.setInterval(tick, 80);
}

function stopLoop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Hidden tab → stop sampling entirely (this is what rAF gave us for free). */
function bindVisibility() {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop();
    else startLoop();
  });
}

export function attachVoice(key: string, track: MediaStreamTrack | null) {
  if (!key || !track || track.kind !== 'audio') return;
  detachVoice(key);
  try {
    const c = ensureCtx();
    const source = c.createMediaStreamSource(new MediaStream([track]));
    const analyser = c.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    entries.set(key, { source, analyser, data: new Uint8Array(new ArrayBuffer(analyser.fftSize)), level: 0 });
    bindVisibility();
    startLoop();
  } catch {
    /* AudioContext unavailable — skip silently */
  }
}

export function detachVoice(key: string) {
  const e = entries.get(key);
  if (e) {
    try { e.source.disconnect(); } catch { /* already gone */ }
    entries.delete(key);
    if (entries.size === 0) stopLoop();
  }
  const cur = useVoiceStore.getState().levels;
  if (key in cur) {
    const { [key]: _drop, ...rest } = cur;
    useVoiceStore.getState().setLevels(rest);
  }
}
