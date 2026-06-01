import { create } from 'zustand';

/**
 * Discord-style voice activity detection. Each audio track (local mic + remote
 * participants) is tapped by a Web Audio AnalyserNode; a single rAF loop computes a
 * smoothed RMS level per participant key (`${userId}:${deviceId}`) and publishes it to
 * a Zustand store. UI (FeedCard glow + waveform, dock ring) subscribes per key.
 *
 * The analyser only reads the track — it is never connected to the audio destination —
 * so it adds no playback / echo. Remote audio is still played by the <audio> sinks.
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
}

let ctx: AudioContext | null = null;
const entries = new Map<string, Entry>();
let raf: number | null = null;
let lastEmit = 0;

function ensureCtx(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function loop(ts: number) {
  raf = entries.size > 0 ? requestAnimationFrame(loop) : null;
  if (entries.size === 0) return;
  if (ts - lastEmit < 80) return; // ~12 store updates/sec
  lastEmit = ts;

  const prev = useVoiceStore.getState().levels;
  const next: Record<string, number> = {};
  for (const [key, e] of entries) {
    e.analyser.getByteTimeDomainData(e.data);
    let sum = 0;
    for (let i = 0; i < e.data.length; i++) {
      const v = (e.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / e.data.length);
    // Fast attack, slow decay so the indicator doesn't strobe between syllables.
    next[key] = Math.max(rms, (prev[key] || 0) * 0.8);
  }
  useVoiceStore.getState().setLevels(next);
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
    entries.set(key, { source, analyser, data: new Uint8Array(new ArrayBuffer(analyser.fftSize)) });
    if (raf === null) raf = requestAnimationFrame(loop);
  } catch {
    /* AudioContext unavailable — skip silently */
  }
}

export function detachVoice(key: string) {
  const e = entries.get(key);
  if (e) {
    try { e.source.disconnect(); } catch { /* already gone */ }
    entries.delete(key);
  }
  const cur = useVoiceStore.getState().levels;
  if (key in cur) {
    const { [key]: _drop, ...rest } = cur;
    useVoiceStore.getState().setLevels(rest);
  }
}
