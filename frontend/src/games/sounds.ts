/**
 * 게임 효과음 — WebAudio 합성 (mp3 자산 없음). 설계서 §6.4.
 * 마스터 볼륨 0.35, `uiStore.gameSoundOn`으로 on/off. 방 효과음(`lib/sounds.ts`)과 별도 채널.
 */
import { useUIStore } from '../stores/uiStore';

export type GameSoundName =
  | 'select'
  | 'match'
  | 'invalid'
  | 'hint'
  | 'attackSend'
  | 'attackHit'
  | 'shuffle'
  | 'tick'
  | 'go'
  | 'win'
  | 'lose'
  | 'finish';

const MASTER = 0.35;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let unlockBound = false;

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

/** 첫 유저 제스처에서 AudioContext를 resume. 게임 패널이 열릴 때 한 번 호출한다. */
export function initGameAudio(): void {
  const c = ensureCtx();
  if (!c) return;
  void c.resume().catch(() => {});
  if (unlockBound) return;
  unlockBound = true;
  const kick = () => {
    void ctx?.resume().catch(() => {});
    if (ctx?.state === 'running') {
      ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.removeEventListener(ev, kick));
    }
  };
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => document.addEventListener(ev, kick));
}

interface ToneOpts {
  freq: number;
  /** 초 단위 길이 */
  dur: number;
  type?: OscillatorType;
  gain?: number;
  /** 시작 지연(초) */
  at?: number;
  /** 주파수 스윕 목표 */
  to?: number;
}

function tone(bus: GainNode, c: AudioContext, o: ToneOpts) {
  const t0 = c.currentTime + (o.at ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + o.dur);
  // 짧은 어택 + 지수 릴리즈 = 딸깍거림 없는 블립
  const peak = Math.max(0.0001, o.gain ?? 0.6);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g);
  g.connect(bus);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

function noise(bus: GainNode, c: AudioContext, dur: number, gain = 0.5, at = 0) {
  const frames = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(g);
  g.connect(bus);
  src.start(c.currentTime + at);
}

/** 반음 단위 피치 이동 */
const semi = (base: number, n: number) => base * Math.pow(2, n / 12);

/**
 * 효과음 재생. 모든 연출은 실제 스토어 이벤트에서만 호출된다.
 * @param opts.combo match의 콤보(음이 반음씩 올라간다) / opts.gain 개별 볼륨 배수
 */
export function playGameSound(name: GameSoundName, opts?: { combo?: number; gain?: number }): void {
  if (!useUIStore.getState().gameSoundOn) return;
  const c = ensureCtx();
  if (!c || !master) return;
  if (c.state === 'suspended') void c.resume().catch(() => {});

  const bus = c.createGain();
  bus.gain.value = opts?.gain ?? 1;
  bus.connect(master);

  switch (name) {
    case 'select':
      tone(bus, c, { freq: 880, dur: 0.03, type: 'sine', gain: 0.5 });
      break;
    case 'match': {
      const combo = Math.max(1, Math.min(10, opts?.combo ?? 1));
      const base = semi(523.25, combo - 1);
      tone(bus, c, { freq: base, dur: 0.1, type: 'triangle', gain: 0.5 });
      tone(bus, c, { freq: semi(base, 4), dur: 0.14, type: 'triangle', gain: 0.45, at: 0.06 });
      if (combo >= 6) {
        // 화음 — 콤보가 높을수록 두툼하게
        tone(bus, c, { freq: semi(base, 7), dur: 0.16, type: 'sine', gain: 0.35, at: 0.06 });
        tone(bus, c, { freq: semi(base, 12), dur: 0.18, type: 'sine', gain: 0.25, at: 0.06 });
      }
      break;
    }
    case 'invalid':
      tone(bus, c, { freq: 120, dur: 0.08, type: 'square', gain: 0.35 });
      break;
    case 'hint':
      tone(bus, c, { freq: 1320, dur: 0.05, type: 'sine', gain: 0.4 });
      tone(bus, c, { freq: 1760, dur: 0.07, type: 'sine', gain: 0.4, at: 0.06 });
      break;
    case 'attackSend':
      tone(bus, c, { freq: 220, to: 1200, dur: 0.24, type: 'sawtooth', gain: 0.3 });
      break;
    case 'attackHit':
      noise(bus, c, 0.18, 0.4);
      tone(bus, c, { freq: 110, to: 55, dur: 0.24, type: 'sine', gain: 0.5 });
      break;
    case 'shuffle':
      [0, 1, 2, 3, 4, 5].forEach((i) => tone(bus, c, {
        freq: semi(660, (i % 2 === 0 ? 0 : 3) + i), dur: 0.05, type: 'triangle', gain: 0.3, at: i * 0.035,
      }));
      break;
    case 'tick':
      tone(bus, c, { freq: 660, dur: 0.05, type: 'square', gain: 0.3 });
      break;
    case 'go':
      tone(bus, c, { freq: 880, dur: 0.1, type: 'triangle', gain: 0.5 });
      tone(bus, c, { freq: 1320, dur: 0.18, type: 'triangle', gain: 0.5, at: 0.08 });
      break;
    case 'win':
      [523.25, 659.25, 783.99].forEach((f, i) => tone(bus, c, {
        freq: f, dur: 0.22, type: 'triangle', gain: 0.5, at: i * 0.11,
      }));
      break;
    case 'lose':
      tone(bus, c, { freq: 392, dur: 0.18, type: 'sine', gain: 0.45 });
      tone(bus, c, { freq: 294, dur: 0.3, type: 'sine', gain: 0.45, at: 0.16 });
      break;
    case 'finish':
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(bus, c, {
        freq: f, dur: 0.26, type: 'sine', gain: 0.45, at: i * 0.09,
      }));
      break;
  }
}
