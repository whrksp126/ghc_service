/**
 * 테트리스 **UI 전용** 상수 (설계서 §T6/§T7).
 * 규칙·수치는 `types.ts`(백엔드와 KEEP IN SYNC)가 원본이고, 여기에는 화면에만 쓰는
 * 색/라벨/연출 길이만 둔다. 엔진(`engine.ts`, `srs.ts`)은 절대 참조하지 않는다.
 */
import {
  B2B_BONUS, COMBO_TABLE, GARBAGE_BASE, PERFECT_CLEAR_BONUS, PIECE_COLORS,
  CELL_ACTIVE_BASE, CELL_GARBAGE, CELL_GHOST, ROWS,
  type ClearKind, type PieceId, type TetrisMode,
} from './types';

/** 쓰레기 줄 색 — 어떤 조각 색과도 겹치지 않는 무채색이어야 "내가 쌓은 것"과 구분된다. */
export const GARBAGE_COLOR = '#64748B';

/** 스택 최고 높이가 이 줄을 넘으면 위험(빨간 게이지 + 맥박). 설계서 §T6 위험선. */
export const DANGER_ROWS = 16;
/** 캔버스에 그리는 위험선의 **보이는 행 인덱스**(위에서부터). 20행 중 16줄 높이 = 위에서 4번째. */
export const DANGER_ROW_INDEX = ROWS - DANGER_ROWS;

/** 연출 길이(ms). 전부 짧다 — v4 "숫자는 떴다가 즉시 사라진다" 결정과 톤을 맞춘다. */
export const FX_MS = {
  clear: 190,     // 줄 섬광 → 수축
  trail: 160,     // 하드드롭 잔상
  lock: 70,       // 락 화이트 플래시
  rise: 140,      // 쓰레기 줄 밀려 올라옴
  shake: 90,      // 하드드롭 화면 진동
  badge: 900,     // TETRIS! / T-SPIN 배지
  screen: 260,    // 테트리스 전체 시안 플래시
} as const;

/** 셀 값 → 색. `toCells` 오버레이(9=그림자, 11..17=현재 조각)까지 한 곳에서 해석한다. */
export function colorOfCell(v: number): string | null {
  if (!v || v === CELL_GHOST) return null;
  if (v === CELL_GARBAGE) return GARBAGE_COLOR;
  if (v >= CELL_ACTIVE_BASE) return PIECE_COLORS[v - CELL_ACTIVE_BASE] ?? null;
  return PIECE_COLORS[v] ?? null;
}
export const isActiveCell = (v: number) => v >= CELL_ACTIVE_BASE;
export const isGhostCell = (v: number) => v === CELL_GHOST;

/** 줄 지움 종류 → 대형 배지 문구. single/double/triple 은 배지를 띄우지 않는다(잡음). */
export const CLEAR_BADGE: Record<ClearKind, string | null> = {
  single: null, double: null, triple: null, tetris: 'TETRIS!',
  tsm: 'T-SPIN MINI!', tss: 'T-SPIN SINGLE!', tsd: 'T-SPIN DOUBLE!', tst: 'T-SPIN TRIPLE!',
};
/** 가이드 표에 쓰는 한국어 라벨 */
export const CLEAR_LABEL: Record<ClearKind, string> = {
  single: '1줄', double: '2줄', triple: '3줄', tetris: '테트리스(4줄)',
  tsm: 'T-스핀 미니', tss: 'T-스핀 1줄', tsd: 'T-스핀 2줄', tst: 'T-스핀 3줄',
};

export type BadgeTone = 'cyan' | 'purple' | 'gold' | 'pink';
/** 테트리스=시안, T-스핀=보라 (설계서 §T6.2 톤과 맞춘다) */
export function toneOfClear(kind: ClearKind): BadgeTone {
  if (kind === 'tetris') return 'cyan';
  return kind.startsWith('ts') ? 'purple' : 'pink';
}
export const BADGE_GRADIENT: Record<BadgeTone, string> = {
  cyan: 'linear-gradient(180deg,#A5F3FC 0%,#25F4EE 55%,#0891B2 100%)',
  purple: 'linear-gradient(180deg,#E9D5FF 0%,#A855F7 55%,#6D28D9 100%)',
  gold: 'linear-gradient(180deg,#FEF3C7 0%,#FACC15 55%,#D97706 100%)',
  pink: 'linear-gradient(180deg,#FDA4AF 0%,#FE2C55 55%,#BE123C 100%)',
};

export const TETRIS_MODE_DESC: Record<TetrisMode, string> = {
  versus: '줄을 지워 상대에게 쓰레기 줄 보내기 — 마지막까지 살아남기',
  sprint: '목표 줄 수를 먼저 지우면 승리 — 모두 같은 조각 순서',
  survival: '바닥이 주기적으로 밀려 올라온다 — 버티는 사람이 승리',
};

/** 조작법 표 (설계서 §T5). */
export const KEY_GUIDE: Array<{ keys: string; label: string }> = [
  { keys: '← →', label: '좌우 이동' },
  { keys: '↓', label: '소프트 드롭' },
  { keys: 'Space', label: '하드 드롭' },
  { keys: '↑ / X', label: '시계 회전' },
  { keys: 'Z / Ctrl', label: '반시계 회전' },
  { keys: 'A', label: '180° 회전' },
  { keys: 'Shift / C', label: '홀드' },
  { keys: 'Esc', label: '조작 안내' },
];

/** 공격량 표 — GARBAGE_BASE 를 그대로 읽어 만들어서 규칙과 표시가 어긋나지 않게 한다. */
export const ATTACK_TABLE: Array<{ label: string; lines: number }> =
  (Object.keys(GARBAGE_BASE) as ClearKind[])
    .filter((k) => GARBAGE_BASE[k] > 0)
    .map((k) => ({ label: CLEAR_LABEL[k], lines: GARBAGE_BASE[k] }));

export const ATTACK_BONUS: Array<{ label: string; value: string }> = [
  { label: 'B2B (연속 테트리스·T스핀)', value: `+${B2B_BONUS}` },
  { label: `콤보 (최대 +${COMBO_TABLE[COMBO_TABLE.length - 1]})`, value: `+0~${COMBO_TABLE[COMBO_TABLE.length - 1]}` },
  { label: '퍼펙트 클리어', value: `+${PERFECT_CLEAR_BONUS}` },
];

/** 미리보기(HOLD/NEXT) 전용 조각 모양 — 회전 규칙은 엔진(SRS) 소관이고 여기는 rot 0 만 그린다. */
export const PIECE_SHAPE: Record<PieceId, Array<[number, number]>> = {
  1: [[0, 1], [1, 1], [2, 1], [3, 1]],   // I
  2: [[0, 0], [0, 1], [1, 1], [2, 1]],   // J
  3: [[2, 0], [0, 1], [1, 1], [2, 1]],   // L
  4: [[1, 0], [2, 0], [1, 1], [2, 1]],   // O
  5: [[1, 0], [2, 0], [0, 1], [1, 1]],   // S
  6: [[1, 0], [0, 1], [1, 1], [2, 1]],   // T
  7: [[0, 0], [1, 0], [1, 1], [2, 1]],   // Z
};

/**
 * 입체 타일 1개. 단색 사각형은 "손맛"이 전혀 없어서 위쪽 하이라이트 + 아래쪽 그림자를 넣는다.
 * 캔버스 3곳(내 보드/미니보드/미리보기)이 같은 함수를 쓰므로 모양이 절대 어긋나지 않는다.
 */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number, color: string,
  opts?: { alpha?: number; bright?: boolean },
): void {
  const bevel = Math.max(1, size * 0.17);
  ctx.save();
  if (opts?.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = opts?.bright ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.34)';
  ctx.fillRect(x, y, size, bevel);
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.fillRect(x, y, bevel, size);
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fillRect(x, y + size - bevel, size, bevel);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x + size - bevel, y, bevel, size);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  ctx.restore();
}

/** 그림자(고스트) — 채우지 않고 테두리만. 굳은 블록과 헷갈리면 안 된다. */
export function drawGhost(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.42)';
  ctx.lineWidth = Math.max(1, size * 0.1);
  ctx.strokeRect(x + size * 0.12, y + size * 0.12, size * 0.76, size * 0.76);
  ctx.restore();
}
