/**
 * 방 안 미니게임 BGM (WebAudio 합성, 오디오 자산 없음) — sounds.ts 와 같은 규칙.
 *
 * 왜 합성인가: 이 프로젝트는 mp3/ogg 를 번들에 넣지 않는다(용량 + 저작권). 실존 게임 테마곡은
 * 절대 옮기지 않고, 분위기만 맞춘 **창작 루프**를 코드로 생성한다.
 *
 * 왜 lookahead 스케줄러인가: setTimeout 으로 음을 직접 울리면 탭이 백그라운드로 가는 순간
 * 타이머가 1초 단위로 throttle 돼 박자가 무너진다. 25ms 마다 깨어나 `ctx.currentTime` 기준으로
 * 앞을 미리 예약하면 박자는 오디오 클럭이 책임지므로 흔들리지 않는다.
 */
import { useUIStore } from '../stores/uiStore';
import { getAudioCtx } from './sounds';

export type BgmTrack = 'shisen' | 'tetris' | 'result';

/** 효과음 마스터(0.35)보다 확실히 작게 — 음악이 커지면 손맛(효과음)이 묻힌다. */
const BGM_GAIN = 0.12;
const STEPS_PER_BAR = 16;          // 16분음표 격자
const LOOKAHEAD_MS = 25;           // 스케줄러가 깨어나는 주기
const SCHEDULE_AHEAD = 0.1;        // 화면이 살아 있을 때 미리 예약할 길이(초)
/** 백그라운드 탭은 타이머가 ~1초로 throttle 된다 → 그만큼 더 길게 예약해 둬야 끊기지 않는다. */
const SCHEDULE_AHEAD_HIDDEN = 1.6;

// ---------------------------------------------------------------- 상태
let bus: GainNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let current: BgmTrack | null = null;
let nextTime = 0;                  // 다음 스텝을 울릴 오디오 클럭 시각
let step = 0;                      // 루프 안 스텝 인덱스
let intensity = 0;                 // 0..1 (테트리스 위기/레벨)
let live: AudioScheduledSourceNode[] = [];   // 예약된 소스 — 정지 시 확실히 끊기 위해 추적
let noiseBuf: AudioBuffer | null = null;

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

function track(node: AudioScheduledSourceNode) {
  live.push(node);
  node.onended = () => { live = live.filter((n) => n !== node); };
}

// ---------------------------------------------------------------- 음색
/** 배음 합 — 마림바/벨/글라스. sounds.ts 와 같은 5ms 어택 + 지수 디케이(클릭 노이즈 방지). */
function pluck(
  c: AudioContext, out: GainNode, t: number, freq: number, dur: number, gain: number,
  partials: Array<[number, number]> = [[1, 1], [4, 0.18], [9.2, 0.05]],
) {
  for (const [ratio, amp] of partials) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * ratio, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * amp), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + dur + 0.02);
    track(osc);
  }
}

const BELL: Array<[number, number]> = [[1, 1], [2.76, 0.3], [5.4, 0.1]];
const GLASS: Array<[number, number]> = [[1, 1], [3, 0.22], [6.1, 0.08]];

/** 베이스 — 삼각파 + 로우패스. 저음은 배음이 많으면 탁해진다. */
function bass(c: AudioContext, out: GainNode, t: number, freq: number, dur: number, gain: number) {
  const osc = c.createOscillator();
  const lp = c.createBiquadFilter();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t);
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.max(320, freq * 6), t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(lp); lp.connect(g); g.connect(out);
  osc.start(t); osc.stop(t + dur + 0.02);
  track(osc);
}

/** 리드 — 사각파를 로우패스로 깎아 90년대 칩튠 느낌. 살짝 sustain 이 있어 멜로디가 또렷하다. */
function lead(c: AudioContext, out: GainNode, t: number, freq: number, dur: number, gain: number) {
  const osc = c.createOscillator();
  const lp = c.createBiquadFilter();
  const g = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, t);
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(7000, freq * 5), t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.setValueAtTime(gain, t + dur * 0.55);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(lp); lp.connect(g); g.connect(out);
  osc.start(t); osc.stop(t + dur + 0.02);
  track(osc);
}

/** 패드 — 느린 어택/릴리스의 배경 화음. 아주 작게 깔아 공간감만 준다. */
function pad(c: AudioContext, out: GainNode, t: number, freq: number, dur: number, gain: number) {
  const osc = c.createOscillator();
  const lp = c.createBiquadFilter();
  const g = c.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, t);
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(900, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  osc.connect(lp); lp.connect(g); g.connect(out);
  osc.start(t); osc.stop(t + dur + 0.05);
  track(osc);
}

/** 하이햇/셰이커 — 노이즈 버퍼는 컨텍스트당 한 번만 만든다(매 스텝 생성하면 GC 가 튄다). */
function hat(c: AudioContext, out: GainNode, t: number, gain: number, dur = 0.045, hp = 6000) {
  if (!noiseBuf) {
    const frames = Math.floor(c.sampleRate * 0.5);
    noiseBuf = c.createBuffer(1, frames, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < frames; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.setValueAtTime(hp, t);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(out);
  src.start(t); src.stop(t + dur + 0.02);
  track(src);
}

/** 킥 — 하강 사인. 테트리스 그루브의 바닥. */
function kick(c: AudioContext, out: GainNode, t: number, gain: number) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(46, t + 0.1);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  osc.connect(g); g.connect(out);
  osc.start(t); osc.stop(t + 0.2);
  track(osc);
}

// ---------------------------------------------------------------- 트랙 데이터
/** 사천성: D 장조 펜타토닉(D E F# A B) — 반음이 없어 오래 들어도 귀가 피로하지 않다. */
const PENTA = [0, 2, 4, 7, 9];
const SHISEN_BARS = 8;
/** 마디별 [베이스 루트(midi), 패드 화음(midi 3음)] — D / A / Bm / G 순환 */
const SHISEN_CHORDS: Array<{ root: number; pad: number[] }> = [
  { root: 38, pad: [62, 66, 69] },   // D
  { root: 45, pad: [61, 64, 69] },   // A
  { root: 47, pad: [62, 66, 71] },   // Bm
  { root: 43, pad: [59, 62, 67] },   // G
  { root: 38, pad: [62, 66, 69] },   // D
  { root: 45, pad: [61, 64, 69] },   // A
  { root: 43, pad: [59, 62, 67] },   // G
  { root: 45, pad: [61, 64, 68] },   // A(sus 느낌)
];
/** 마디별 멜로디 [스텝, 펜타토닉 인덱스, 옥타브]. 4마디마다 프레이즈가 바뀐다(= 지겹지 않게). */
const SHISEN_MELODY: Array<Array<[number, number, number]>> = [
  [[0, 0, 0], [6, 1, 0], [10, 2, 0]],
  [[0, 3, 0], [8, 2, 0], [12, 1, 0]],
  [[2, 4, 0], [6, 3, 0], [10, 2, 0], [14, 1, 0]],
  [[0, 0, 0], [8, 2, 0], [12, 4, -1]],
  [[0, 2, 0], [4, 3, 0], [10, 4, 0]],
  [[0, 1, 0], [6, 2, 0], [12, 0, 1]],
  [[2, 3, 0], [6, 4, 0], [10, 3, 0], [14, 2, 0]],
  [[0, 1, 0], [6, 0, 0], [12, 3, -1]],
];

/** 테트리스: A 단조. 마디별 [베이스 루트, 3화음 오프셋] — Am Am Dm E / Am F G E */
const TETRIS_BARS = 8;
const TETRIS_CHORDS: Array<{ root: number; triad: number[] }> = [
  { root: 45, triad: [0, 3, 7] },    // Am
  { root: 45, triad: [0, 3, 7] },
  { root: 50, triad: [0, 3, 7] },    // Dm
  { root: 52, triad: [0, 4, 7] },    // E
  { root: 45, triad: [0, 3, 7] },    // Am
  { root: 53, triad: [0, 4, 7] },    // F
  { root: 55, triad: [0, 4, 7] },    // G
  { root: 52, triad: [0, 4, 7] },    // E
];
/** A 자연단음계 오프셋 */
const MINOR = [0, 2, 3, 5, 7, 8, 10, 12];
/** 마디별 멜로디 [스텝, 음계 인덱스, 길이(스텝)] — 앞 4마디 질문 / 뒤 4마디 대답 */
const TETRIS_MELODY: Array<Array<[number, number, number]>> = [
  [[0, 4, 4], [4, 2, 2], [6, 3, 2], [8, 4, 2], [10, 2, 2], [12, 0, 4]],
  [[0, 1, 2], [2, 2, 2], [4, 3, 4], [8, 2, 2], [12, 1, 4]],
  [[0, 3, 2], [2, 5, 2], [4, 4, 4], [8, 3, 2], [10, 2, 2], [12, 3, 4]],
  [[0, 2, 4], [4, 1, 2], [6, 2, 2], [8, 4, 6]],
  [[0, 7, 4], [4, 5, 2], [6, 4, 2], [8, 5, 2], [10, 4, 2], [12, 2, 4]],
  [[0, 5, 2], [2, 4, 2], [4, 3, 4], [8, 4, 2], [12, 5, 4]],
  [[0, 6, 2], [2, 5, 2], [4, 4, 4], [8, 6, 2], [10, 4, 2], [12, 2, 2], [14, 4, 2]],
  [[0, 4, 4], [4, 3, 2], [6, 2, 2], [8, 0, 8]],
];

/** 결과: C 장조 짧은 4마디 루프 — 승패와 무관하게 "정리되는" 느낌만 준다. */
const RESULT_BARS = 4;
const RESULT_CHORDS = [
  { root: 48, tones: [60, 64, 67] },   // C
  { root: 55, tones: [59, 62, 67] },   // G
  { root: 57, tones: [60, 64, 69] },   // Am
  { root: 53, tones: [60, 65, 69] },   // F
];

// ---------------------------------------------------------------- 스케줄
function barsOf(t: BgmTrack): number {
  return t === 'shisen' ? SHISEN_BARS : t === 'tetris' ? TETRIS_BARS : RESULT_BARS;
}

/** 한 스텝(16분음표)의 길이(초). 테트리스만 강도에 따라 최대 +25% 빨라진다. */
function stepDur(t: BgmTrack): number {
  const bpm = t === 'shisen' ? 84 : t === 'result' ? 100 : 140 * (1 + 0.25 * intensity);
  return 60 / bpm / 4;
}

function scheduleShisen(c: AudioContext, out: GainNode, s: number, t: number) {
  const bar = Math.floor(s / STEPS_PER_BAR);
  const k = s % STEPS_PER_BAR;
  const ch = SHISEN_CHORDS[bar % SHISEN_CHORDS.length];
  const spb = stepDur('shisen') * STEPS_PER_BAR;

  // 베이스: 루트(1박) + 5도(3박) — 아주 느슨하게
  if (k === 0) bass(c, out, t, mtof(ch.root), spb * 0.5, 0.5);
  if (k === 8) bass(c, out, t, mtof(ch.root + 7), spb * 0.4, 0.34);

  // 패드: 두 마디에 한 번만 갈아 낀다(자주 바뀌면 산만하다)
  if (k === 0 && bar % 2 === 0) {
    for (const m of ch.pad) pad(c, out, t, mtof(m), spb * 2, 0.055);
  }

  // 멜로디: 마림바
  for (const [ms, deg, oct] of SHISEN_MELODY[bar % SHISEN_MELODY.length]) {
    if (ms !== k) continue;
    const midi = 62 + PENTA[deg] + 12 * oct;
    pluck(c, out, t, mtof(midi), 0.9, 0.34);
    // 프레이즈 끝(4·8마디)은 한 옥타브 위 글라스를 얹어 변주를 준다
    if (bar % 4 === 3 && ms >= 10) pluck(c, out, t + 0.03, mtof(midi + 12), 1.1, 0.1, GLASS);
  }

  // 셰이커: 뒷박에만 아주 작게
  if (k % 8 === 4) hat(c, out, t, 0.035, 0.05, 7000);
}

function scheduleTetris(c: AudioContext, out: GainNode, s: number, t: number) {
  const bar = Math.floor(s / STEPS_PER_BAR);
  const k = s % STEPS_PER_BAR;
  const ch = TETRIS_CHORDS[bar % TETRIS_CHORDS.length];
  const d = stepDur('tetris');
  const hot = intensity;   // 0..1

  // 아르페지오 베이스: 8분음표 기본, 위험해지면 16분음표로 조여든다
  const arp = [0, 7, 12, 7, 0, 12, 7, 12];
  if (k % 2 === 0 || hot > 0.6) {
    const idx = (k >> 1) % arp.length;
    bass(c, out, t, mtof(ch.root + arp[idx]), d * (hot > 0.6 ? 1.1 : 1.8), 0.42);
  }

  // 킥 + 하이햇
  if (k === 0 || k === 8) kick(c, out, t, 0.28);
  if (k % 4 === 2) hat(c, out, t, 0.05);
  if (hot > 0.35 && k % 2 === 0) hat(c, out, t, 0.035);
  if (hot > 0.75 && k % 2 === 1) hat(c, out, t, 0.022, 0.03);

  // 화음 스탭 — 뒷박 찌르기
  if (k === 6 || k === 14) {
    for (const off of ch.triad) pluck(c, out, t, mtof(ch.root + 12 + off), d * 2, 0.12, GLASS);
  }

  // 멜로디(리드) + 강도가 오르면 한 옥타브 위를 겹쳐 조인다
  for (const [ms, deg, len] of TETRIS_MELODY[bar % TETRIS_MELODY.length]) {
    if (ms !== k) continue;
    const midi = 69 + MINOR[deg];
    lead(c, out, t, mtof(midi), d * len * 0.92, 0.2);
    if (hot > 0.5) lead(c, out, t, mtof(midi + 12), d * len * 0.6, 0.07);
  }
}

function scheduleResult(c: AudioContext, out: GainNode, s: number, t: number) {
  const bar = Math.floor(s / STEPS_PER_BAR);
  const k = s % STEPS_PER_BAR;
  const ch = RESULT_CHORDS[bar % RESULT_CHORDS.length];
  const spb = stepDur('result') * STEPS_PER_BAR;

  if (k === 0) {
    bass(c, out, t, mtof(ch.root), spb * 0.6, 0.32);
    for (const m of ch.tones) pad(c, out, t, mtof(m), spb, 0.04);
  }
  // 벨 아르페지오 — 마디마다 방향이 바뀌어 단조롭지 않다
  const order = bar % 2 === 0 ? ch.tones : [...ch.tones].reverse();
  if (k % 4 === 0) {
    const m = order[(k / 4) % order.length] + 12;
    pluck(c, out, t, mtof(m), 0.7, 0.16, BELL);
  }
}

function scheduleStep(t: BgmTrack, s: number, when: number) {
  const c = getAudioCtx();
  if (!c || !bus) return;
  if (t === 'shisen') scheduleShisen(c, bus, s, when);
  else if (t === 'tetris') scheduleTetris(c, bus, s, when);
  else scheduleResult(c, bus, s, when);
}

function tick() {
  const c = getAudioCtx();
  if (!c || !current || !bus) return;
  const total = barsOf(current) * STEPS_PER_BAR;

  // 백그라운드 복귀 등으로 예약 시점이 과거가 됐다면 **밀린 스텝을 몰아 울리지 않고 버린다**.
  // 다음 마디 첫 박부터 다시 잡아야 리듬이 어긋난 채로 이어지지 않는다.
  if (nextTime < c.currentTime) {
    nextTime = c.currentTime + 0.05;
    step = (Math.ceil(step / STEPS_PER_BAR) * STEPS_PER_BAR) % total;
  }

  const ahead = document.hidden ? SCHEDULE_AHEAD_HIDDEN : SCHEDULE_AHEAD;
  while (nextTime < c.currentTime + ahead) {
    scheduleStep(current, step, nextTime);
    nextTime += stepDur(current);
    step = (step + 1) % total;
  }
}

// ---------------------------------------------------------------- public API
/** 같은 트랙이면 무시한다(재시작 금지 — phase 가 바뀔 때마다 음악이 처음으로 돌아가면 최악). */
export function startBgm(t: BgmTrack): void {
  if (current === t) return;
  if (!useUIStore.getState().gameBgmOn) return;
  const c = getAudioCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => {});

  stopBgm(220);   // 다른 트랙이 돌고 있었다면 짧게 페이드 아웃(= 크로스페이드)

  bus = c.createGain();
  bus.gain.setValueAtTime(0.0001, c.currentTime);
  bus.gain.linearRampToValueAtTime(BGM_GAIN, c.currentTime + 0.35);
  // 효과음 마스터(0.35)와 **형제**로 붙인다. master 밑에 넣으면 두 번 감쇠돼 거의 안 들린다.
  bus.connect(c.destination);

  current = t;
  step = 0;
  nextTime = c.currentTime + 0.08;
  timer = setInterval(tick, LOOKAHEAD_MS);
  tick();
}

/** 페이드 아웃으로 끊는다 — 즉시 disconnect 하면 딸깍 노이즈가 난다. */
export function stopBgm(fadeMs = 400): void {
  if (timer) { clearInterval(timer); timer = null; }
  current = null;
  const c = getAudioCtx();
  const old = bus;
  bus = null;
  const dying = live;
  live = [];
  if (!c || !old) return;
  const t0 = c.currentTime;
  const fade = Math.max(0.03, fadeMs / 1000);
  try {
    old.gain.cancelScheduledValues(t0);
    old.gain.setValueAtTime(Math.max(0.0001, old.gain.value), t0);
    old.gain.exponentialRampToValueAtTime(0.0001, t0 + fade);
  } catch { /* 값 이상은 무시 — 어차피 아래에서 끊는다 */ }
  setTimeout(() => {
    try { old.disconnect(); } catch { /* noop */ }
    // 백그라운드용으로 멀리 예약해 둔 소스까지 확실히 끊는다.
    for (const n of dying) { try { n.stop(); } catch { /* 이미 끝난 노드 */ } }
  }, fadeMs + 60);
}

/** 0..1 — 테트리스 위기/레벨. 템포와 레이어 수에 바로 반영된다. */
export function setBgmIntensity(v: number): void {
  intensity = clamp01(v);
}

export function isBgmPlaying(): boolean {
  return current !== null;
}

if (import.meta.env.DEV) {
  // Playwright 검증용 — tetrisStore 의 __ghcTetris 와 같은 패턴.
  (window as unknown as { __ghcBgm?: unknown }).__ghcBgm = {
    track: () => current,
    playing: isBgmPlaying,
    intensity: () => intensity,
  };
}
