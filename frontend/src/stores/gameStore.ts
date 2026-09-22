import { create } from 'zustand';
import type {
  AttackEvent, Board, GameSnapshot, MatchedEvent, PeerSelectEvent, PlayerState, Point, ShuffledEvent,
} from '../games/types';
import { useAuthStore } from './authStore';
import * as engine from '../games/shisen/engine';

/** 보드 컴포넌트가 소비하는 일회성 연출 이벤트. B2에서 종류가 늘어난다. */
export interface FxEvent {
  id: number;
  boardId: string;
  at: number;
  type: 'path' | 'pop' | 'invalid' | 'shuffle' | 'attack' | 'flash';
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

  setSelected: (idx: number | null) => void;
  setHintPair: (pair: [number, number] | null) => void;
  setFocusBoard: (boardId: string | null) => void;
  setCursor: (idx: number | null) => void;

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
    const predicted = e.userId === myUserId() && get().takePending(e.a, e.b) !== null;
    // 협동: 같은 칸을 노린 내 예측이 남아 있으면 "이미 지워진 것"으로 표시해 둔다.
    // (그래야 뒤늦게 오는 `ok:false, reason:'gone'` 응답이 타일을 되살리지 않는다 — 데이터 오염 방지)
    const winnerColor = get().snapshot?.players.find((p) => p.userId === e.userId)?.color;
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
        return { ...b, cells, remaining: e.remaining };
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
        combo: e.combo, fromUserId: e.userId,
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
      const next = withBoard(prev.snapshot, e.boardId, (b) => ({ ...b, cells: e.cells.slice() }));
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

  applyPeerSelect: (e) => set((prev) => ({ peerSelect: { ...prev.peerSelect, [e.userId]: e.idx } })),

  setSelected: (idx) => set({ selectedIdx: idx }),
  setHintPair: (pair) => set({ hintPair: pair }),
  setFocusBoard: (boardId) => set({ focusBoardId: boardId }),
  setCursor: (idx) => set({ cursorIdx: idx }),

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
        return { ...bd, cells, remaining: Math.max(0, bd.remaining - 2) };
      }),
      selectedIdx: null,
      hintPair: null,
      pendingPicks: [...get().pendingPicks, { a, b, sym, boardId }],
    });
    get().pushFx({ type: 'path', boardId, path, color });
    get().pushFx({
      type: 'pop', boardId, cells: [a, b], symbol: sym, color,
      combo: (get().me()?.combo ?? 0) + 1, fromUserId: myUserId() ?? undefined,
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
        for (const v of cells) if (v !== 0) remaining++;
        return { ...bd, cells, remaining };
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
      fxQueue: [],
    }),
}));

// 개발용 디버그 훅 (E2E 자동 플레이 스크립트가 상태·엔진에 접근)
if (import.meta.env.DEV) {
  (window as unknown as { __ghcGame?: unknown }).__ghcGame = { store: useGameStore, engine };
}
