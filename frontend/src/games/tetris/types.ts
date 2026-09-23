// KEEP IN SYNC with ghc_service/backend/src/games/tetris/types.ts
// 테트리스 공유 계약 (docs/games/tetris-design.md). 내용을 바꾸려면 설계서를 먼저 고친다.

/** 대전 방식 (사천성의 race/coop 자리) */
export type TetrisMode = 'versus' | 'sprint' | 'survival';
export const TETRIS_MODES: TetrisMode[] = ['versus', 'sprint', 'survival'];
export const TETRIS_MODE_LABEL: Record<TetrisMode, string> = {
  versus: '대전', sprint: '레이스', survival: '서바이벌',
};

export const COLS = 10;
export const ROWS = 20;           // 보이는 행
export const HIDDEN_ROWS = 2;     // 스폰용 버퍼(렌더 안 함). 내부 필드는 ROWS + HIDDEN_ROWS
export const FIELD_ROWS = ROWS + HIDDEN_ROWS;

/** 셀 인코딩: 0=빈칸, 1..7=조각 색(I S Z L J T O 순서 아님 — PIECES 인덱스), 8=쓰레기줄 */
export const CELL_EMPTY = 0;
export const CELL_GARBAGE = 8;
/** 프레임 전송에서만 쓰는 값 — 상대 미니보드에 "지금 떨어지는 조각"을 그리기 위한 오버레이 */
export const CELL_ACTIVE_BASE = 10;   // 10 + pieceId (11..17)
export const CELL_GHOST = 9;

/** 조각 id 1..7 = I, J, L, O, S, T, Z */
export type PieceId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const PIECE_NAMES = ['', 'I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const;
/** 가이드라인 색 (I=시안, J=파랑, L=주황, O=노랑, S=초록, T=보라, Z=빨강) */
export const PIECE_COLORS = ['', '#22D3EE', '#3B82F6', '#F97316', '#FACC15', '#22C55E', '#A855F7', '#EF4444'] as const;

export interface TetrisOptions {
  mode: TetrisMode;
  /** 레이스 목표 줄 수 */
  sprintLines: number;          // 20 | 40 | 100
  /** 시작 레벨(낙하 속도). 1=가장 느림 … 10 */
  startLevel: number;
  /** 몇 줄 지울 때마다 레벨 +1 (0 = 레벨 고정) */
  levelUpLines: number;
  hold: boolean;
  ghost: boolean;
  nextCount: number;            // 1..5
  /** 공격량 배수 — 0.5 / 1 / 1.5 / 2 */
  garbageMul: number;
  /** 서바이벌: 바닥에서 줄이 밀려 올라오는 주기(초). 0 = 없음 */
  riseSec: number;
  /** 제한 시간(초). 0 = 무제한 */
  timeLimitSec: number;
}

export const DEFAULT_TETRIS_OPTIONS: Record<TetrisMode, TetrisOptions> = {
  versus:   { mode: 'versus',   sprintLines: 40, startLevel: 1, levelUpLines: 10, hold: true, ghost: true, nextCount: 5, garbageMul: 1,   riseSec: 0,  timeLimitSec: 0 },
  sprint:   { mode: 'sprint',   sprintLines: 40, startLevel: 3, levelUpLines: 0,  hold: true, ghost: true, nextCount: 5, garbageMul: 0,   riseSec: 0,  timeLimitSec: 300 },
  survival: { mode: 'survival', sprintLines: 40, startLevel: 2, levelUpLines: 10, hold: true, ghost: true, nextCount: 5, garbageMul: 0.5, riseSec: 25, timeLimitSec: 0 },
};

export const TETRIS_LIMITS = {
  sprintLines: [20, 40, 100],
  startLevel: { min: 1, max: 10 },
  levelUpLines: [0, 5, 10, 20],
  nextCount: { min: 1, max: 5 },
  garbageMul: [0.5, 1, 1.5, 2],
  riseSec: [0, 15, 25, 40],
} as const;

/** 줄 지움 종류 — 공격량 표의 키 */
export type ClearKind =
  | 'single' | 'double' | 'triple' | 'tetris'
  | 'tsm' | 'tss' | 'tsd' | 'tst';   // T-spin mini / single / double / triple

/** 보낸 줄 수 기본표 (배수·B2B·콤보 전) */
export const GARBAGE_BASE: Record<ClearKind, number> = {
  single: 0, double: 1, triple: 2, tetris: 4,
  tsm: 0, tss: 2, tsd: 4, tst: 6,
};
/** 콤보 보너스 (index = combo, 넘치면 마지막 값) */
export const COMBO_TABLE = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
export const B2B_BONUS = 1;
export const PERFECT_CLEAR_BONUS = 10;
/** B2B 유지 대상(테트리스 + 모든 T스핀) */
export const B2B_KINDS: ClearKind[] = ['tetris', 'tsm', 'tss', 'tsd', 'tst'];

/** 점수표 (레벨 곱) */
export const SCORE_BASE: Record<ClearKind, number> = {
  single: 100, double: 300, triple: 500, tetris: 800,
  tsm: 100, tss: 800, tsd: 1200, tst: 1600,
};

/**
 * 한 플레이어의 판 스냅샷. 클라가 만들어 서버로 올리고, 서버가 모아서 모두에게 되돌린다.
 * cells 는 **보이는 20행만** (길이 200). 현재 조각과 그림자는 오버레이 값으로 합쳐서 보낸다.
 */
export interface TetrisFrame {
  userId: string;
  cells: number[];      // 길이 COLS*ROWS
  lines: number;
  score: number;
  level: number;
  combo: number;        // 0 = 콤보 없음
  b2b: number;          // 연속 B2B 횟수
  hold: number;         // 0 = 없음, 1..7
  next: number[];       // 다음 조각 id (최대 nextCount)
  pending: number;      // 내려올 예정인 쓰레기 줄
  alive: boolean;
  ko: number;           // 내가 떨어뜨린 사람 수(versus)
  /** 클라 로컬 시각(ms) — 서버는 신뢰하지 않고 순서 확인용으로만 본다 */
  t: number;
}

/** 클라 → 서버: 줄을 지웠다 */
export interface TetrisClearMsg {
  kind: ClearKind;
  lines: number;        // 실제로 지운 줄 수 1..4
  combo: number;
  b2b: boolean;
  perfect: boolean;
}
/** 서버 → 대상: 쓰레기 줄이 온다 */
export interface TetrisGarbageEvent {
  seq: number;
  to: string;
  from: string;
  amount: number;
  /** 구멍 열 위치 — 서버가 정해 줘야 모두가 같은 모양을 본다 */
  holes: number[];
}
/** 서버 → 전원: 공격 연출용(누가 누구에게 몇 줄) */
export interface TetrisSentEvent {
  seq: number; from: string; to: string; amount: number; kind: ClearKind; b2b: boolean; combo: number;
}
/** 서버 → 전원: 탈락/완주 */
export interface TetrisDownEvent {
  seq: number; userId: string; by: string | null; rank: number; reason: 'topout' | 'forfeit';
}
export interface TetrisFinishEvent {
  seq: number; userId: string; timeMs: number; lines: number;
}
/** 서버 → 전원(서바이벌): 바닥이 올라온다 */
export interface TetrisRiseEvent { seq: number; amount: number; holes: number[]; at: number; }

/** 서버 → 전원: 프레임 묶음 (8Hz) */
export interface TetrisFramesEvent { seq: number; frames: TetrisFrame[]; }

export type TetrisAck = { ok: true } | { ok: false; reason: string };
