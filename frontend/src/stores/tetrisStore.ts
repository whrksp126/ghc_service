import { create } from 'zustand';
import * as engine from '../games/tetris/engine';
import { emitWithAck } from '../lib/socket';
import type {
  ClearKind, TetrisDownEvent, TetrisFinishEvent, TetrisFrame, TetrisFramesEvent,
} from '../games/tetris/types';
import type { BadgeTone } from '../games/tetris/ui';

/**
 * 테트리스 렌더용 스토어.
 *
 * **60fps 시뮬 상태는 여기 들어오지 않는다.** 엔진 상태는 `useTetrisGame` 의 ref 가 들고 있고
 * 캔버스가 ref 로 직접 그린다. 스토어에는 **값이 바뀔 때만** 쓰는 파생 HUD(줄/레벨/점수/
 * pending/배지)와 상대 프레임만 둔다. 매 프레임 set 하면 아레나 전체가 리렌더돼 손맛이 죽는다.
 */

/** 아레나 오버레이가 소비하는 일회성 연출 이벤트 (사천성 gameStore.fxQueue 와 같은 수명 규칙). */
export interface TetrisFx {
  id: number;
  at: number;
  type: 'clear' | 'attack' | 'garbage' | 'ko' | 'levelUp' | 'finish' | 'screen';
  /** clear/screen: 지운 줄 수 — 4줄이면 화면 전체 플래시 */
  lines?: number;
  kind?: ClearKind;
  /** attack/garbage: 보낸 사람 / 받는 사람 / 줄 수 */
  from?: string;
  to?: string;
  amount?: number;
  text?: string;
}

/** 화면에 늘 떠 있는 숫자들 — 바뀔 때만 갱신된다. */
export interface TetrisHud {
  lines: number;
  score: number;
  level: number;
  combo: number;
  b2b: number;
  /** 내려올 예정인 쓰레기 줄 (좌측 경고 바) */
  pending: number;
  hold: number;
  next: number[];
  alive: boolean;
  ko: number;
  /** 0..1 — 스택 최고 높이 / 20. 위험선을 넘으면 게이지가 빨개진다 */
  danger: number;
  /** 레이스 완주 기록(ms). null = 아직 */
  finishedMs: number | null;
}

const EMPTY_HUD: TetrisHud = {
  lines: 0, score: 0, level: 1, combo: 0, b2b: 0, pending: 0,
  hold: 0, next: [], alive: true, ko: 0, danger: 0, finishedMs: null,
};

interface TetrisStore {
  hud: TetrisHud;
  /** 상대 판 스냅샷 (8Hz). 내 것도 들어오지만 아레나에서 걸러 쓴다. */
  frames: Record<string, TetrisFrame>;
  fxQueue: TetrisFx[];
  /** 대형 배지 — 항상 1개만 떠 있고 즉시 사라진다(v4 결정 계승) */
  badge: { id: number; text: string; tone: BadgeTone } | null;
  /** 탈락한 사람들(연출/목록용) */
  kos: Array<{ userId: string; by: string | null; rank: number; at: number }>;
  /** 상단 안내 배너 — 2.5초 */
  banner: { text: string; at: number } | null;
  /** Esc 조작 안내 오버레이 (멀티라 실제 일시정지는 없다) */
  helpOpen: boolean;

  setHud: (patch: Partial<TetrisHud>) => void;
  applyFrames: (e: TetrisFramesEvent) => void;
  pushFx: (fx: Omit<TetrisFx, 'id' | 'at'>) => void;
  consumeFx: (id: number) => void;
  setBadge: (text: string, tone: BadgeTone) => void;
  clearBadge: (id: number) => void;
  pushKo: (e: TetrisDownEvent) => void;
  noteFinish: (e: TetrisFinishEvent, nickname: string) => void;
  setBanner: (text: string | null) => void;
  setHelpOpen: (v: boolean) => void;
  reset: () => void;
}

let nextId = 1;

/** next 배열은 매 락마다 내용이 같을 수 있으므로 얕은 비교로 리렌더를 막는다. */
function sameNext(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const useTetrisStore = create<TetrisStore>()((set, get) => ({
  hud: EMPTY_HUD,
  frames: {},
  fxQueue: [],
  badge: null,
  kos: [],
  banner: null,
  helpOpen: false,

  // 바뀐 게 하나도 없으면 set 자체를 하지 않는다(= 리렌더 0회). 8Hz로 불려도 공짜다.
  setHud: (patch) =>
    set((prev) => {
      const cur = prev.hud;
      let changed = false;
      for (const key of Object.keys(patch) as Array<keyof TetrisHud>) {
        const v = patch[key];
        if (v === undefined) continue;
        if (key === 'next') {
          if (!sameNext(cur.next, v as number[])) changed = true;
        } else if (cur[key] !== v) {
          changed = true;
        }
      }
      return changed ? { hud: { ...cur, ...patch } } : prev;
    }),

  applyFrames: (e) =>
    set((prev) => {
      const next = { ...prev.frames };
      for (const f of e.frames) next[f.userId] = f;
      return { frames: next };
    }),

  // 사천성 gameStore.pushFx 와 **같은 reaper 패턴**: 아무도 소비하지 않은 연출은 2.5초 뒤 정리.
  pushFx: (fx) =>
    set((prev) => {
      const cutoff = Date.now() - 2500;
      const live = prev.fxQueue.filter((f) => f.at > cutoff).slice(-40);
      return { fxQueue: [...live, { ...fx, id: nextId++, at: Date.now() }] };
    }),
  consumeFx: (id) => set((prev) => ({ fxQueue: prev.fxQueue.filter((f) => f.id !== id) })),

  setBadge: (text, tone) => set({ badge: { id: nextId++, text, tone } }),
  clearBadge: (id) => set((prev) => (prev.badge?.id === id ? { badge: null } : prev)),

  pushKo: (e) =>
    set((prev) => ({
      kos: [...prev.kos.filter((k) => k.userId !== e.userId), {
        userId: e.userId, by: e.by, rank: e.rank, at: Date.now(),
      }],
    })),

  noteFinish: (e, nickname) => {
    get().pushFx({ type: 'finish', from: e.userId, lines: e.lines });
    get().setBanner(`${nickname}님이 ${e.lines}줄 완주! (${(e.timeMs / 1000).toFixed(1)}초)`);
  },

  setBanner: (text) => set({ banner: text ? { text, at: Date.now() } : null }),
  setHelpOpen: (v) => set({ helpOpen: v }),

  reset: () => set({
    hud: EMPTY_HUD, frames: {}, fxQueue: [], badge: null, kos: [], banner: null, helpOpen: false,
  }),
}));

/**
 * 개발 빌드 전용 디버그 브리지.
 * `state`/`press` 는 `useTetrisGame` 이 마운트될 때 실제 구현으로 갈아 끼운다(엔진 상태와
 * 키 핸들러가 훅 안에 있으므로). Playwright 자동 플레이가 `window.__ghcTetris.press('left')`
 * 처럼 **진짜 키 핸들러**를 태워 플레이한다.
 */
export const tetrisDebug: {
  state: () => unknown;
  press: (key: string) => void;
} = { state: () => null, press: () => {} };

if (import.meta.env.DEV) {
  (window as unknown as { __ghcTetris?: unknown }).__ghcTetris = {
    store: useTetrisStore,
    engine,
    state: () => tetrisDebug.state(),
    press: (key: string) => tetrisDebug.press(key),
    emit: emitWithAck,
  };
}
