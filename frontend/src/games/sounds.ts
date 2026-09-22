/**
 * 게임 효과음 v2 (WebAudio 합성, 자산 없음) — 설계서 §6.4 + v2.1.
 * 톤: 상큼·경쾌한 마림바/벨. 어택 5ms·지수 디케이로 클릭 노이즈 없이, 소리마다 2~3개 변형을
 * 랜덤 재생해 반복해도 지루하지 않게. 마스터 0.35, `uiStore.gameSoundOn`으로 on/off.
 */
import { useUIStore } from '../stores/uiStore';

export type GameSoundName =
  | 'select'
  | 'match'
  | 'invalid'
  | 'hint'
  | 'reveal'
  | 'unlock'
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

type Timbre = 'marimba' | 'bell' | 'glass';

/** 배음 비율 / 감쇠 — 마림바는 4배음이 살짝, 벨은 비정수 배음. */
const PARTIALS: Record<Timbre, Array<[ratio: number, gain: number, decay: number]>> = {
  marimba: [[1, 1, 1], [4, 0.22, 0.45], [9.2, 0.06, 0.25]],
  bell: [[1, 1, 1], [2.76, 0.35, 0.8], [5.4, 0.14, 0.55]],
  glass: [[1, 1, 1], [3, 0.3, 0.6], [6.1, 0.12, 0.4]],
};

/** 한 음. attack 5ms + 지수 디케이라 딸깍거림이 없다. */
function note(
  bus: GainNode, c: AudioContext,
  freq: number, at = 0, dur = 0.3, gain = 0.5, timbre: Timbre = 'marimba',
) {
  const t0 = c.currentTime + at;
  for (const [ratio, amp, decay] of PARTIALS[timbre]) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * ratio, t0);
    const peak = Math.max(0.0001, gain * amp);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * decay);
    osc.connect(g);
    g.connect(bus);
    osc.start(t0);
    osc.stop(t0 + dur * decay + 0.03);
  }
}

/** 우드블록/노이즈 타격음. */
function knock(bus: GainNode, c: AudioContext, at = 0, freq = 900, gain = 0.4, dur = 0.06) {
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(bus);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

function noiseBurst(bus: GainNode, c: AudioContext, dur = 0.18, gain = 0.35, at = 0) {
  const frames = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = gain;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  src.connect(lp); lp.connect(g); g.connect(bus);
  src.start(c.currentTime + at);
}

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** C 메이저 펜타토닉 — 콤보가 오를수록 위로 올라간다. */
const PENTA = [523.25, 587.33, 659.25, 783.99, 880];
function comboNote(combo: number): number {
  const i = Math.max(0, combo - 1);
  return PENTA[i % PENTA.length] * Math.pow(2, Math.floor(i / PENTA.length));
}

/** 콤보 티어(2·4·6·8)를 넘을 때 얹는 반짝임. */
function sparkle(bus: GainNode, c: AudioContext, at = 0) {
  note(bus, c, 2093, at, 0.22, 0.22, 'glass');
  note(bus, c, 3136, at + 0.04, 0.26, 0.16, 'glass');
}

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
      // 밝은 "틱" 3변형
      note(bus, c, pick([1174.66, 1318.51, 1396.91]), 0, 0.09, 0.32, 'marimba');
      break;

    case 'match': {
      const combo = Math.max(1, Math.min(12, opts?.combo ?? 1));
      const root = comboNote(combo);
      const timbre: Timbre = pick(['marimba', 'marimba', 'bell']);
      note(bus, c, root, 0, 0.3, 0.42, timbre);
      note(bus, c, root * Math.pow(2, 4 / 12), 0.055, 0.34, 0.36, timbre);
      if (combo >= 4) {
        // 3화음 — 두툼하게
        note(bus, c, root * Math.pow(2, 7 / 12), 0.055, 0.38, 0.3, timbre);
      }
      if (combo >= 2 && combo % 2 === 0) sparkle(bus, c, 0.09);
      break;
    }

    case 'invalid':
      // 거슬리지 않는 부드러운 "붑"
      note(bus, c, pick([196, 174.61]), 0, 0.16, 0.26, 'marimba');
      break;

    case 'hint':
      note(bus, c, 1318.51, 0, 0.2, 0.3, 'glass');
      note(bus, c, 1760, 0.07, 0.24, 0.26, 'glass');
      break;

    case 'reveal':
      // 반짝임
      note(bus, c, pick([1567.98, 1760]), 0, 0.18, 0.24, 'glass');
      note(bus, c, 2637, 0.05, 0.2, 0.14, 'glass');
      break;

    case 'unlock':
      [0, 4, 7, 12].forEach((semi, i) => note(bus, c, 659.25 * Math.pow(2, semi / 12), i * 0.06, 0.3, 0.3, 'bell'));
      break;

    case 'attackSend':
      [0, 3, 7, 10, 14].forEach((semi, i) => note(bus, c, 392 * Math.pow(2, semi / 12), i * 0.035, 0.18, 0.22, 'glass'));
      break;

    case 'attackHit':
      noiseBurst(bus, c, 0.2, 0.32);
      note(bus, c, 110, 0, 0.3, 0.4, 'marimba');
      break;

    case 'shuffle': {
      // 빠른 글리산도
      const up = Math.random() < 0.5;
      Array.from({ length: 10 }).forEach((_, i) => {
        const k = up ? i : 9 - i;
        note(bus, c, 523.25 * Math.pow(2, k / 12), i * 0.028, 0.12, 0.18, 'marimba');
      });
      break;
    }

    case 'tick':
      knock(bus, c, 0, pick([880, 820]), 0.32);
      break;

    case 'go':
      [523.25, 659.25, 783.99].forEach((f, i) => note(bus, c, f, i * 0.05, 0.3, 0.38, 'bell'));
      note(bus, c, 1046.5, 0.15, 0.5, 0.34, 'bell');
      break;

    case 'win':
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(bus, c, f, i * 0.09, 0.45, 0.4, 'bell'));
      break;

    case 'lose':
      note(bus, c, 392, 0, 0.3, 0.32, 'marimba');
      note(bus, c, 311.13, 0.15, 0.45, 0.3, 'marimba');
      break;

    case 'finish':
      [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => note(bus, c, f, i * 0.08, 0.4, 0.34, 'glass'));
      break;
  }
}
