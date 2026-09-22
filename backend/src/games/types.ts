// KEEP IN SYNC with ghc_service/frontend/src/games/types.ts
// 방 안 미니게임 공유 계약 (docs/games/shisen-design.md §2). 내용을 바꾸려면 설계서를 먼저 고친다.

export type GameId = 'shisen';                      // 추후 'tetris'
export type GameMode = 'race' | 'coop';
export type BoardSize = 's' | 'm' | 'l';
export type GamePhase = 'lobby' | 'countdown' | 'playing' | 'finished';
export type AttackType = 'freeze' | 'fog' | 'shuffle';

export interface GameOptions { boardSize: BoardSize; items: boolean; timeLimitSec: number; }
export const DEFAULT_OPTIONS: Record<GameMode, GameOptions> = {
  race: { boardSize: 'm', items: false, timeLimitSec: 300 },
  coop: { boardSize: 'l', items: false, timeLimitSec: 0 },
};
export const BOARD_DIMS: Record<BoardSize, { cols: number; rows: number }> = {
  s: { cols: 8, rows: 5 }, m: { cols: 12, rows: 6 }, l: { cols: 14, rows: 8 },
};
export const MAX_PLAYERS = 4;
export const COMBO_WINDOW_MS = 2000;
export const COUNTDOWN_MS = 3000;

export interface Point { r: number; c: number; }   // 원 격자 좌표. 바깥 테두리는 -1 / cols / rows
export interface Effect { type: AttackType; until: number; hidden?: number[]; }

export interface Board {
  id: string;            // race: userId, coop: 'shared'
  cols: number; rows: number;
  cells: number[];       // 0 = empty
  remaining: number;     // 남은 타일 수
  effects: Effect[];
}

export interface PlayerState {
  userId: string; nickname: string;
  color: string;         // 플레이어 색 (서버가 PLAYER_COLORS 순서대로 배정)
  boardId: string;
  score: number; combo: number; maxCombo: number;
  pairsCleared: number;
  lastMatchAt: number;   // ms epoch, 0 = 없음
  hintsLeft: number;
  finishedAt: number | null;   // race 완주 시각
  connected: boolean;    // 소켓 끊김(10s 유예 중) 표시용
  forfeited: boolean;    // playing 중 기권(관전 전환). players[]에는 남음
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

// --- 소켓 델타 이벤트 페이로드 (§3.2) ---
export interface AttackEvent {
  seq: number; from: string; to: string; boardId: string;
  type: AttackType; until: number; hidden?: number[];
}
export interface MatchedEvent {
  seq: number; userId: string; boardId: string;
  a: number; b: number; path: Point[];
  combo: number; score: number; remaining: number;
  attack?: AttackEvent;
}
export interface ShuffledEvent {
  seq: number; boardId: string; cells: number[]; cause: 'stuck' | 'attack';
}
export interface PeerSelectEvent { userId: string; idx: number | null; }
export type PickReason = 'same' | 'symbol' | 'gone' | 'nopath' | 'frozen' | 'phase';
export type PickAck = { ok: true; path: Point[] } | { ok: false; reason: PickReason };
export type HintAck = { ok: true; pair: [number, number] } | { ok: false; reason: 'none' };
