// KEEP IN SYNC with ghc_service/frontend/src/games/types.ts
// 방 안 미니게임 공유 계약 (docs/games/shisen-design.md §2 + v2 §V2). 내용을 바꾸려면 설계서를 먼저 고친다.

export type GameId = 'shisen';                      // 추후 'tetris'
export type GameMode = 'race' | 'coop';
export type BoardSize = 's' | 'm' | 'l';
export type GamePhase = 'lobby' | 'countdown' | 'playing' | 'finished';
export type AttackType = 'freeze' | 'fog' | 'shuffle';

// --- v2: 맵 모양 / 특수 타일 ---
export type MapShape = 'random' | 'rect' | 'diamond' | 'frame' | 'towers' | 'pyramid' | 'cross' | 'blob';
export const MAP_SHAPES: MapShape[] = ['random', 'rect', 'diamond', 'frame', 'towers', 'pyramid', 'cross', 'blob'];
export interface SpecialToggles { mystery: boolean; numbers: boolean; keys: boolean; walls: boolean; }

/** 소모품 아이템 (v3 §W1). 쟁탈전은 공유 카운트를 각 플레이어에 미러한다. */
export interface PlayerItems { hint: number; shuffle: number; wand: number; }

/** 1 = 가장 쉬움(같은 그림 많고 붙어 있음), 5 = 가장 어려움 (v3 §W1) */
export type Difficulty = 1 | 2 | 3 | 4 | 5;
export interface GameOptions {
  boardSize: BoardSize; mapShape: MapShape; specials: SpecialToggles;
  difficulty: Difficulty; tools: PlayerItems; items: boolean; timeLimitSec: number;
}
export const DEFAULT_OPTIONS: Record<GameMode, GameOptions> = {
  race: { boardSize: 'm', mapShape: 'random', specials: { mystery: false, numbers: false, keys: false, walls: false }, difficulty: 3, tools: { hint: 3, shuffle: 2, wand: 1 }, items: false, timeLimitSec: 300 },
  coop: { boardSize: 'l', mapShape: 'random', specials: { mystery: false, numbers: false, keys: false, walls: false }, difficulty: 3, tools: { hint: 5, shuffle: 3, wand: 2 }, items: false, timeLimitSec: 0 },
};
/** 아이템 횟수 설정 범위 (v4 §X2.3) */
export const TOOL_LIMITS: Record<keyof PlayerItems, { min: number; max: number }> = {
  hint: { min: 0, max: 9 }, shuffle: { min: 0, max: 9 }, wand: { min: 0, max: 3 },
};
// 격자(모양은 이 안에서 마스크) — 타일 수는 마스크가 정함(대략 s≈40, m≈72~80, l≈112~120)
export const BOARD_DIMS: Record<BoardSize, { cols: number; rows: number }> = {
  s: { cols: 10, rows: 6 }, m: { cols: 14, rows: 8 }, l: { cols: 18, rows: 10 },
};
// cells 인코딩
export const EMPTY = 0;
export const WALL = -1;          // 벽: 영구 점유. 선택 불가, 경로 차단, 셔플 대상 아님
export const MYSTERY = 99;       // 물음표(플레이스홀더): game:peek로 본인만 일회성 확인 (자동 공개 없음)
export const NUMBER_BASE = 200;  // 숫자 타일: NUMBER_BASE + n (n=1..K, 각 n 1쌍). n 순서대로만 제거 가능
export const isNormalSymbol = (v: number) => v >= 1 && v <= 28;

// 색깔 자물쇠·열쇠 (v3 §W1). 자물쇠는 색만 보이고 안의 심볼은 서버만 안다.
export const LOCK_BASE = 90;
export const KEY_BASE = 100;
export const MAX_KEY_TYPES = 3;
export const isLock = (v: number) => v > LOCK_BASE && v <= LOCK_BASE + MAX_KEY_TYPES;
export const isKey = (v: number) => v > KEY_BASE && v <= KEY_BASE + MAX_KEY_TYPES;
export const KEY_COLORS = ['#F87171', '#60A5FA', '#4ADE80'];
/** 판 크기별 열쇠 종류 수 (specials.keys 가 true일 때) */
export const KEY_TYPES_PER_SIZE: Record<BoardSize, number> = { s: 1, m: 2, l: 3 };


export const MAX_PLAYERS = 4;
export const COMBO_WINDOW_MS = 2000;
export const COUNTDOWN_MS = 3000;

export interface Point { r: number; c: number; }   // 원 격자 좌표. 바깥 테두리는 -1 / cols / rows
export interface Effect { type: AttackType; until: number; hidden?: number[]; }

export interface Board {
  id: string;            // race: userId, coop: 'shared'
  cols: number; rows: number;
  cells: number[];       // 위 인코딩. 물음표/자물쇠는 플레이스홀더로 마스킹된 상태로 전송(공개는 peek 뿐)
  remaining: number;     // 벽 제외 남은 타일 수
  total: number;         // 시작 시 타일 수(벽 제외). 진행률 = (total - remaining) / total
  effects: Effect[];
  shape: Exclude<MapShape, 'random'>;   // 실제 결정된 모양(랜덤이면 서버가 고른 값)
  nextNumber: number;    // 숫자 순서 타일이 있으면 다음에 지워야 할 n, 없거나 끝났으면 0
  keysLeft: number;      // 남은 열쇠 쌍 수 (종류별 1쌍씩)
  movesLeft: number;     // v2.1: 지금 연결 가능한 쌍 수(서버 진실 기준, 물음표는 심볼을 아는 것으로 계산)
}

export interface PlayerState {
  userId: string; nickname: string;
  color: string;         // 플레이어 색 (서버가 PLAYER_COLORS 순서대로 배정)
  boardId: string;
  score: number; combo: number; maxCombo: number;
  pairsCleared: number;
  lastMatchAt: number;   // ms epoch, 0 = 없음
  items: PlayerItems;    // 남은 소모품 (힌트/재배치/여의봉)
  finishedAt: number | null;   // race 완주 시각
  connected: boolean;    // 소켓 끊김(10s 유예 중) 표시용
  forfeited: boolean;    // playing 중 기권(보드는 남지만 순위는 최하위 그룹)
  rank: number;          // 서버가 계산한 실시간 등수(동률은 같은 등수)
}

export interface ResultRow {
  rank: number; userId: string; nickname: string; color: string;
  score: number; timeMs: number | null; remaining: number; maxCombo: number; pairsCleared: number;
}

export interface ScoreboardRow { userId: string; nickname: string; wins: number; games: number; bestTimeMs: number | null; }

export interface GameSnapshot {
  gameId: GameId;
  phase: GamePhase;
  hostUserId: string;
  mode: GameMode;
  options: GameOptions;
  seed: number;
  startAt: number | null;      // countdown 시작 시 = now + COUNTDOWN_MS. playing 시작 시각
  endedAt: number | null;
  players: PlayerState[];      // 참가 순서
  boards: Record<string, Board>;
  spectators: { userId: string; nickname: string }[];
  results: ResultRow[] | null;
  scoreboard: ScoreboardRow[]; // 방 단위 누적(메모리)
  seq: number;                 // 판 상태가 바뀔 때마다 +1 (matched/shuffled/attack/state)
}

export const PLAYER_COLORS = ['#FE2C55', '#25F4EE', '#FACC15', '#A78BFA'];

// --- 소켓 델타 이벤트 페이로드 (§3.2 + v2 §V3) ---
/**
 * 델타를 받은 클라가 보드 규칙 상태를 바로 맞출 수 있게 같이 보내는 요약.
 * 부수효과(인접 공개·자물쇠 해제·막힘 재배치)까지 **전부 끝난 뒤**의 값이다.
 */
export interface BoardPatch {
  remaining: number; total: number; nextNumber: number; keysLeft: number; movesLeft: number;
}
export interface AttackEvent {
  seq: number; from: string; to: string; boardId: string;
  type: AttackType; until: number; hidden?: number[];
}
export interface MatchedEvent {
  seq: number;
  userId: string;       // 'system' = 막힘 해소 자동 제거(v2 §V3)
  boardId: string;
  a: number; b: number; path: Point[];
  combo: number; score: number; remaining: number; movesLeft: number;
  board: BoardPatch;
  byItem?: 'wand';      // 여의봉으로 지운 쌍
  attack?: AttackEvent;
}
export interface ShuffledEvent {
  seq: number; boardId: string; cells: number[]; cause: 'stuck' | 'attack' | 'item'; movesLeft: number;
  board: BoardPatch;
  userId?: string;      // cause:'item' 일 때 아이템을 쓴 사람
}
export interface PeerSelectEvent { userId: string; idx: number | null; }
/** game:unlocked — 그 색 열쇠 쌍 제거로 같은 색 자물쇠만 해제 */
export interface UnlockedEvent {
  seq: number; boardId: string; tiles: { idx: number; symbol: number }[]; movesLeft: number;
  board: BoardPatch;
  keyType: number;      // 1..MAX_KEY_TYPES
}
export type PickReason =
  | 'same' | 'symbol' | 'gone' | 'nopath' | 'frozen' | 'phase'
  | 'locked' | 'order' | 'wall';
export type PickAck = { ok: true; path: Point[] } | { ok: false; reason: PickReason };
export type HintAck = { ok: true; pair: [number, number] } | { ok: false; reason: 'none' };
/** game:peek — 물음표 일회성 엿보기(요청자에게만, 서버 상태 불변) */
export type PeekAck = { ok: true; symbol: number } | { ok: false; reason: PickReason };
/** game:shuffle / game:wand — 소모품 사용 */
export type ItemAck = { ok: true } | { ok: false; reason: 'none' | PickReason };
