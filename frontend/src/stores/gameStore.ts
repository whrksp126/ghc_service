import { create } from 'zustand';
import { COMBO_WINDOW_MS, type Board, type GameSnapshot, type PlayerState, type Point } from '../games/types';
import type {
  AttackEvent, MatchedEvent, PeerSelectEvent, ShuffledEvent, TilesEvent,
} from '../games/events';
import type { BoardPatch } from '../games/types';
import { patchOf } from '../games/events';
import { NUMBER_BASE, isKey } from '../games/types';
import { countMoves } from '../games/moves';
import { useAuthStore } from './authStore';
import * as engine from '../games/shisen/engine';
import { emitWithAck } from '../lib/socket';

/** 보드 컴포넌트가 소비하는 일회성 연출 이벤트. B2에서 종류가 늘어난다. */
export interface FxEvent {
  id: number;
  boardId: string;
  at: number;
  type: 'path' | 'pop' | 'invalid' | 'shuffle' | 'attack' | 'flash' | 'reveal' | 'unlock';
  /** path: 네온 경로 꼭짓점 */
  path?: Point[];
  /** pop / invalid: 대상 타일 인덱스 */
  cells?: number[];
  /** pop / invalid: 타일 심볼 id (제거 애니용 고스트 렌더) */
  symbol?: number;
  /** 경로·파티클 색 (플레이어 색) */
  color?: string;
  /** attack: 공격 정보(투사체 비행) */
  attack?: AttackEvent;
  /** pop: 이 제거의 콤보 — 5 이상이면 아레나가 살짝 흔들린다 */
  combo?: number;
  /** pop: 이번 제거로 얻은 점수(+N 플로팅 텍스트) */
  points?: number;
  /** attack/pop: 발신자 userId (투사체 출발 지점) */
  fromUserId?: string;
}

/** 서버 응답을 기다리는 예측 제거. 롤백을 위해 심볼/보드를 함께 들고 있는다. */
export interface PendingPick {
  a: number; b: number; sym: number; boardId: string;
  /** 같은 칸을 다른 사람이 먼저 지웠다(협동). 이 픽의 거절 응답은 **절대 타일을 되살리면 안 된다**. */
  superseded?: boolean;
  /** 먼저 지운 사람의 색 — 거절 시 그 색으로 타일을 번쩍인다. */
  supersededColor?: string;
}

type Role = 'player' | 'spectator' | 'none';

interface GameStore {
  isPanelOpen: boolean;
  snapshot: GameSnapshot | null;

  // 로컬 UI 상태
  selectedIdx: number | null;
  /** 서버 응답 대기 중인 예측들(네트워크 지연 시 2개 이상일 수 있어 배열) */
  pendingPicks: PendingPick[];
  hintPair: [number, number] | null;
  peerSelect: Record<string, number | null>;
  /** 미니보드 확대 토글 (null = 기본 레이아웃) */
  focusBoardId: string | null;
  /** 키보드 커서 위치(내 보드 기준). null = 커서 없음 */
  cursorIdx: number | null;
  /** 물음표 엿보기(v3 W1): 내 첫 선택인 동안에만 심볼이 보인다. 실패·해제하면 즉시 다시 숨김 */
  peek: { idx: number; symbol: number } | null;
  /** 게임 팩 선택 완료(로컬 UI 단계) */
  packChosen: boolean;
  /** 방 로그 스트립 — 스냅샷 차이로 클라가 직접 만든다 */
  roomLog: Array<{ id: number; at: number; text: string }>;
  fxQueue: FxEvent[];

  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  applySnapshot: (s: GameSnapshot | null) => void;
  /** @returns false = 상태 어긋남 → 호출자가 `game:sync` 해야 함 */
  applyMatched: (e: MatchedEvent) => boolean;
  applyShuffled: (e: ShuffledEvent) => boolean;
  applyAttack: (e: AttackEvent) => boolean;
  applyPeerSelect: (e: PeerSelectEvent) => void;
  /** 물음표 공개 / 자물쇠 해제 — 둘 다 타일 값을 채워 넣고 뒤집기 연출을 남긴다 */
  applyTiles: (e: TilesEvent, kind: 'reveal' | 'unlock') => boolean;

  /** HUD 옆에 1.2초 떴다 사라지는 짧은 안내("1번부터 지워야 해요") */
  notice: { text: string; at: number } | null;
  setNotice: (text: string | null) => void;
  /** 아레나 상단 배너(재배치 안내 등) — 2.5초 */
  banner: { text: string; at: number } | null;
  setBanner: (text: string | null) => void;

  setSelected: (idx: number | null) => void;
  setHintPair: (pair: [number, number] | null) => void;
  setFocusBoard: (boardId: string | null) => void;
  setCursor: (idx: number | null) => void;
  setPeek: (peek: { idx: number; symbol: number } | null) => void;
  setPackChosen: (v: boolean) => void;
  pushLog: (text: string) => void;

  /** 예측 제거: 즉시 두 타일을 비우고 pendingPick 등록 */
  predictPick: (boardId: string, a: number, b: number, path: Point[], color: string) => void;
  /** 서버 거절 → 타일 복구 (superseded/gone이면 복구하지 않는다) */
  rollbackPick: (pick: PendingPick) => void;
  /** 복구 없이 예측만 버린다(타일은 이미 사라진 게 맞는 경우) */
  dropPending: (pick: PendingPick, flashColor?: string) => void;
  takePending: (a: number, b: number) => PendingPick | null;

  pushFx: (fx: Omit<FxEvent, 'id' | 'at'>) => void;
  consumeFx: (id: number) => void;

  me: () => PlayerState | undefined;
  role: () => Role;
  myBoard: () => Board | undefined;
  reset: () => void;
}

let nextFxId = 1;

/** 다음 제거의 콤보 예측(콤보 창 2초). 예측 연출·사운드가 서버와 같은 값을 쓰도록. */
export function predictedCombo(p: PlayerState | undefined): number {
  if (!p) return 1;
  return Date.now() - p.lastMatchAt <= COMBO_WINDOW_MS ? p.combo + 1 : 1;
}

/** 불변 갱신 헬퍼 — 보드 하나만 갈아끼운다. */
function withBoard(s: GameSnapshot, boardId: string, fn: (b: Board) => Board): GameSnapshot {
  const board = s.boards[boardId];
  if (!board) return s;
  return { ...s, boards: { ...s.boards, [boardId]: fn(board) } };
}

/** 이미 만료된 효과를 떨어낸 boards 사본. */
function pruneEffects(boards: Record<string, Board>): Record<string, Board> {
  const now = Date.now();
  const out: Record<string, Board> = {};
  for (const [id, b] of Object.entries(boards)) {
    out[id] = b.effects.length > 0
      ? { ...b, effects: b.effects.filter((e) => e.until > now) }
      : b;
  }
  return out;
}


/**
 * 보드 메타(nextNumber / keysLeft / movesLeft) 갱신.
 * 서버 패치(A5의 `event.board`)가 있으면 그게 진실이고, 없으면 **로컬로 유도**한다 —
 * 그래야 내 예측 제거 직후에도 `canPick`이 "1번부터 지워야 해요"로 막히지 않는다.
 * `removed`는 이번에 사라진 타일의 원래 값(숫자/열쇠 판단용).
 */
function withMeta(
  b: Board,
  opts: { removed?: number; unlocked?: boolean; patch?: Partial<BoardPatch> },
): Board {
  let nextNumber = b.nextNumber;
  let keysLeft = b.keysLeft;

  const removed = opts.removed;
  if (removed !== undefined && removed >= NUMBER_BASE) {
    const n = removed - NUMBER_BASE;
    if (nextNumber === n) nextNumber = b.cells.includes(NUMBER_BASE + n + 1) ? n + 1 : 0;
  }
  // 열쇠 쌍을 지웠거나 해제 이벤트가 오면 남은 열쇠 쌍이 하나 줄어든다(색 종류별 1쌍).
  if ((removed !== undefined && isKey(removed)) || opts.unlocked) keysLeft = Math.max(0, keysLeft - 1);

  const next: Board = { ...b, nextNumber, keysLeft };
  next.movesLeft = countMoves(next);

  // 서버 값이 함께 왔으면 덮어쓴다(권위).
  const p = opts.patch;
  if (p) {
    if (typeof p.remaining === 'number') next.remaining = p.remaining;
    if (typeof p.nextNumber === 'number') next.nextNumber = p.nextNumber;
    if (typeof p.keysLeft === 'number') next.keysLeft = p.keysLeft;
    if (typeof p.movesLeft === 'number') next.movesLeft = p.movesLeft;
  }
  return next;
}

function myUserId(): string | null {
  return useAuthStore.getState().userId;
}

export const useGameStore = create<GameStore>()((set, get) => ({
  isPanelOpen: false,
  snapshot: null,
  selectedIdx: null,
  pendingPicks: [],
  hintPair: null,
  peerSelect: {},
  focusBoardId: null,
  cursorIdx: null,
  peek: null,
  packChosen: false,
  roomLog: [],
  notice: null,
  banner: null,
  fxQueue: [],

  openPanel: () => set({ isPanelOpen: true }),
  closePanel: () => set({ isPanelOpen: false }),
  togglePanel: () => set((s) => ({ isPanelOpen: !s.isPanelOpen })),

  applySnapshot: (s) =>
    set((prev) => ({
      // 스냅샷의 boards(=effects 포함)를 **통째로 교체**한다. 로컬에 남은 옛 효과와 절대 합치지
      // 않고, 이미 지난 효과는 들어오자마자 버린다(서버가 아직 정리 전일 수 있다).
      snapshot: s ? { ...s, boards: pruneEffects(s.boards) } : null,
      // 스냅샷은 권위 — 예측/선택 상태를 모두 버린다.
      pendingPicks: [],
      selectedIdx: s && s.phase === 'playing' ? prev.selectedIdx : null,
      peek: s && s.phase === 'playing' ? prev.peek : null,
      hintPair: null,
      peerSelect: s ? prev.peerSelect : {},
      focusBoardId: s ? prev.focusBoardId : null,
    })),

  applyMatched: (e) => {
    const s = get().snapshot;
    if (!s) return false;
    if (e.seq <= s.seq) return true;            // 늦게 온 델타 → 무시
    if (e.seq > s.seq + 1) return false;        // seq 구멍 → 재동기화
    // 내 것이고 예측이 걸려 있으면 "확정"(연출은 이미 돌았다). 예측이 없으면(같은 유저의 다른
    // 기기에서 지웠거나 예측이 스냅샷으로 날아간 경우) 서버 값을 그대로 적용하고 연출도 돌린다.
    const pending = e.userId === myUserId() ? get().takePending(e.a, e.b) : null;
    const predicted = pending !== null;
    // 예측으로 이미 비워졌으면 pendingPick이 원래 값을 들고 있다.
    const removedValue = get().snapshot?.boards[e.boardId]?.cells[e.a] || pending?.sym;
    // 협동: 같은 칸을 노린 내 예측이 남아 있으면 "이미 지워진 것"으로 표시해 둔다.
    // (그래야 뒤늦게 오는 `ok:false, reason:'gone'` 응답이 타일을 되살리지 않는다 — 데이터 오염 방지)
    const before = get().snapshot?.players.find((p) => p.userId === e.userId);
    const gained = Math.max(0, e.score - (before?.score ?? 0));
    const winnerColor = before?.color;
    const clashed = get().pendingPicks.some(
      (p) => p.boardId === e.boardId && (p.a === e.a || p.a === e.b || p.b === e.a || p.b === e.b),
    );
    if (clashed) {
      set((prev) => ({
        pendingPicks: prev.pendingPicks.map((p) =>
          p.boardId === e.boardId && (p.a === e.a || p.a === e.b || p.b === e.a || p.b === e.b)
            ? { ...p, superseded: true, supersededColor: winnerColor }
            : p,
        ),
      }));
    }
    set((prev) => {
      if (!prev.snapshot) return prev;
      let next = withBoard(prev.snapshot, e.boardId, (b) => {
        const cells = b.cells.slice();
        cells[e.a] = 0;
        cells[e.b] = 0;
        return withMeta(
          { ...b, cells, remaining: e.remaining },
          { removed: removedValue, patch: patchOf(e) ?? { movesLeft: e.movesLeft } },
        );
      });
      next = {
        ...next,
        seq: e.seq,
        players: next.players.map((p) =>
          p.userId === e.userId
            ? {
                ...p,
                score: e.score,
                combo: e.combo,
                maxCombo: Math.max(p.maxCombo, e.combo),
                pairsCleared: p.pairsCleared + 1,
                lastMatchAt: Date.now(),
              }
            : p,
        ),
      };
      return { snapshot: next };
    });
    if (!predicted) {
      const player = get().snapshot?.players.find((p) => p.userId === e.userId);
      get().pushFx({ type: 'path', boardId: e.boardId, path: e.path, color: player?.color });
      get().pushFx({
        type: 'pop', boardId: e.boardId, cells: [e.a, e.b], color: player?.color,
        combo: e.combo, points: gained, fromUserId: e.userId,
      });
      // 상대가 내 첫 선택 표시를 지우지 못한 채 지웠을 수 있다.
      if (get().peerSelect[e.userId] === e.a || get().peerSelect[e.userId] === e.b) {
        set((prev) => ({ peerSelect: { ...prev.peerSelect, [e.userId]: null } }));
      }
    }
    return true;
  },

  applyShuffled: (e) => {
    const s = get().snapshot;
    if (!s) return false;
    if (e.seq <= s.seq) return true;
    if (e.seq > s.seq + 1) return false;
    set((prev) => {
      if (!prev.snapshot) return prev;
      const next = withBoard(prev.snapshot, e.boardId, (b) =>
        withMeta({ ...b, cells: e.cells.slice() }, { patch: patchOf(e) ?? { movesLeft: e.movesLeft } }));
      return { snapshot: { ...next, seq: e.seq }, selectedIdx: null, hintPair: null, pendingPicks: [] };
    });
    get().pushFx({ type: 'shuffle', boardId: e.boardId });
    return true;
  },

  applyAttack: (e) => {
    const s = get().snapshot;
    if (!s) return false;
    if (e.seq <= s.seq) return true;
    if (e.seq > s.seq + 1) return false;
    // 같은 효과를 두 번 적용하지 않는다(재전송·재동기화). 같은 종류가 겹치면 더 늦게 끝나는 쪽만 남긴다.
    const already = get().snapshot?.boards[e.boardId]?.effects
      .some((x) => x.type === e.type && x.until === e.until);
    set((prev) => {
      if (!prev.snapshot) return prev;
      const now = Date.now();
      const next = withBoard(prev.snapshot, e.boardId, (b) => {
        const others = b.effects.filter((x) => x.type !== e.type && x.until > now);
        const sameType = b.effects.filter((x) => x.type === e.type && x.until > now);
        const merged = sameType.reduce(
          (best, x) => (x.until > best.until ? x : best),
          { type: e.type, until: e.until, hidden: e.hidden },
        );
        return { ...b, effects: [...others, merged] };
      });
      return { snapshot: { ...next, seq: e.seq } };
    });
    // 투사체 연출은 한 번만.
    if (!already) get().pushFx({ type: 'attack', boardId: e.boardId, attack: e, fromUserId: e.from });
    return true;
  },

  applyTiles: (e, kind) => {
    const s = get().snapshot;
    if (!s) return false;
    if (e.seq <= s.seq) return true;
    if (e.seq > s.seq + 1) return false;
    set((prev) => {
      if (!prev.snapshot) return prev;
      const next = withBoard(prev.snapshot, e.boardId, (b) => {
        const cells = b.cells.slice();
        for (const t of e.tiles) cells[t.idx] = t.symbol;
        return withMeta(
          { ...b, cells },
          { unlocked: kind === 'unlock', patch: patchOf(e) ?? { movesLeft: e.movesLeft } },
        );
      });
      return { snapshot: { ...next, seq: e.seq } };
    });
    get().pushFx({ type: kind, boardId: e.boardId, cells: e.tiles.map((t) => t.idx) });
    return true;
  },

  applyPeerSelect: (e) => set((prev) => ({ peerSelect: { ...prev.peerSelect, [e.userId]: e.idx } })),

  setNotice: (text) => set({ notice: text ? { text, at: Date.now() } : null }),
  setBanner: (text) => set({ banner: text ? { text, at: Date.now() } : null }),

  // 선택이 바뀌면 엿보던 물음표는 즉시 다시 숨긴다(W1).
  setSelected: (idx) => set((prev) => ({
    selectedIdx: idx,
    peek: prev.peek && prev.peek.idx === idx ? prev.peek : null,
  })),
  setHintPair: (pair) => set({ hintPair: pair }),
  setFocusBoard: (boardId) => set({ focusBoardId: boardId }),
  setCursor: (idx) => set({ cursorIdx: idx }),
  setPeek: (peek) => set({ peek }),
  setPackChosen: (v) => set({ packChosen: v }),
  pushLog: (text) => set((prev) => ({
    roomLog: [...prev.roomLog.slice(-40), { id: nextFxId++, at: Date.now(), text }],
  })),

  predictPick: (boardId, a, b, path, color) => {
    const s = get().snapshot;
    const board = s?.boards[boardId];
    if (!s || !board) return;
    const sym = board.cells[a];
    set({
      snapshot: withBoard(s, boardId, (bd) => {
        const cells = bd.cells.slice();
        cells[a] = 0;
        cells[b] = 0;
        // 숫자/열쇠 진행도를 즉시 반영해야 다음 쌍을 바로 고를 수 있다.
        return withMeta({ ...bd, cells, remaining: Math.max(0, bd.remaining - 2) }, { removed: sym });
      }),
      selectedIdx: null,
      peek: null,
      hintPair: null,
      pendingPicks: [...get().pendingPicks, { a, b, sym, boardId }],
    });
    get().pushFx({ type: 'path', boardId, path, color });
    const combo = predictedCombo(get().me());
    get().pushFx({
      type: 'pop', boardId, cells: [a, b], symbol: sym, color,
      combo, points: 10 + 5 * Math.min(9, combo - 1), fromUserId: myUserId() ?? undefined,
    });
  },

  dropPending: (pick, flashColor) => {
    set({
      pendingPicks: get().pendingPicks.filter((p) => !(p.a === pick.a && p.b === pick.b && p.boardId === pick.boardId)),
    });
    get().pushFx({
      type: 'flash',
      boardId: pick.boardId,
      cells: [pick.a, pick.b],
      color: flashColor ?? pick.supersededColor ?? '#FFFFFF',
    });
  },

  rollbackPick: (pick) => {
    const s = get().snapshot;
    // 먼저 지워진 게 확실한 픽은 절대 되살리지 않는다.
    if (!s || pick.superseded) { get().dropPending(pick); return; }
    set({
      snapshot: withBoard(s, pick.boardId, (bd) => {
        const cells = bd.cells.slice();
        // 서버가 이미 다른 이유로 비웠을 수 있으니 빈칸일 때만 되돌린다.
        if (cells[pick.a] === 0) cells[pick.a] = pick.sym;
        if (cells[pick.b] === 0) cells[pick.b] = pick.sym;
        let remaining = 0;
        for (const v of cells) if (v > 0) remaining++;
        return withMeta({ ...bd, cells, remaining }, {});
      }),
      pendingPicks: get().pendingPicks.filter((p) => !(p.a === pick.a && p.b === pick.b)),
    });
    get().pushFx({ type: 'invalid', boardId: pick.boardId, cells: [pick.a, pick.b] });
  },

  takePending: (a, b) => {
    const hit = get().pendingPicks.find(
      (p) => (p.a === a && p.b === b) || (p.a === b && p.b === a),
    );
    if (!hit) return null;
    set({ pendingPicks: get().pendingPicks.filter((p) => p !== hit) });
    return hit;
  },

  pushFx: (fx) =>
    set((prev) => ({
      // 오래된 연출이 쌓이지 않도록 상한(렉 방지). 소비는 보드 컴포넌트가 한다.
      fxQueue: [...prev.fxQueue.slice(-40), { ...fx, id: nextFxId++, at: Date.now() }],
    })),
  consumeFx: (id) => set((prev) => ({ fxQueue: prev.fxQueue.filter((f) => f.id !== id) })),

  me: () => {
    const uid = myUserId();
    return get().snapshot?.players.find((p) => p.userId === uid);
  },
  role: () => {
    const s = get().snapshot;
    const uid = myUserId();
    if (!s || !uid) return 'none';
    if (s.players.some((p) => p.userId === uid)) return 'player';
    if (s.spectators.some((p) => p.userId === uid)) return 'spectator';
    return 'none';
  },
  myBoard: () => {
    const s = get().snapshot;
    const meState = get().me();
    if (!s) return undefined;
    if (s.mode === 'coop') return s.boards['shared'] ?? Object.values(s.boards)[0];
    return meState ? s.boards[meState.boardId] : undefined;
  },

  reset: () =>
    set({
      snapshot: null,
      selectedIdx: null,
      pendingPicks: [],
      hintPair: null,
      peerSelect: {},
      focusBoardId: null,
      cursorIdx: null,
      peek: null,
      packChosen: false,
      roomLog: [],
      notice: null,
      banner: null,
      fxQueue: [],
    }),
}));

// 개발용 디버그 훅 (E2E 자동 플레이 스크립트가 상태·엔진에 접근)
if (import.meta.env.DEV) {
  (window as unknown as { __ghcGame?: unknown }).__ghcGame = { store: useGameStore, engine, emit: emitWithAck };
}
