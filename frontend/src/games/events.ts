/**
 * 소켓 델타/ack 페이로드 타입 (프론트 전용).
 * `games/types.ts`는 백엔드가 소유·복제하는 계약 파일이라 이벤트 모양은 여기에 따로 둔다
 * (설계서 §3.2 + v2 §V3의 `game:revealed` / `game:unlocked`).
 */
import type { AttackType, Point } from './types';

export interface AttackEvent {
  seq: number; from: string; to: string; boardId: string;
  type: AttackType; until: number; hidden?: number[];
}

export interface MatchedEvent {
  seq: number;
  /** 'system' = 막힘 해소 자동 제거(설계서 v2 §V3) */
  userId: string;
  boardId: string;
  a: number; b: number; path: Point[];
  combo: number; score: number; remaining: number;
  movesLeft?: number;
  board?: BoardPatch;
  attack?: AttackEvent;
}

export interface ShuffledEvent {
  seq: number; boardId: string; cells: number[]; cause: 'stuck' | 'attack';
  movesLeft?: number;
  board?: BoardPatch;
}

export interface PeerSelectEvent { userId: string; idx: number | null }

/**
 * 델타에 실려 오는 보드 메타 패치(A5). 아직 안 실려 오는 서버와도 호환되도록 전부 옵셔널로 읽는다.
 */
export interface BoardPatch {
  remaining?: number; nextNumber?: number; keysLeft?: number; movesLeft?: number;
}
export function patchOf(e: unknown): BoardPatch | undefined {
  const p = (e as { board?: BoardPatch } | null)?.board;
  return p && typeof p === 'object' ? p : undefined;
}

/** `game:revealed`(물음표 공개) / `game:unlocked`(자물쇠 해제) 공용 모양 */
export interface TilesEvent {
  seq: number; boardId: string; tiles: { idx: number; symbol: number }[];
  movesLeft?: number;
  board?: BoardPatch;
}

export type PickReason =
  | 'same' | 'symbol' | 'gone' | 'nopath' | 'frozen' | 'phase'
  | 'locked' | 'order' | 'hidden' | 'wall';

export type PickAck = { ok: true; path: Point[] } | { ok: false; reason: PickReason };
export type HintAck = { ok: true; pair: [number, number] } | { ok: false; reason: 'none' };
export type RevealAck = { ok: true; symbol: number } | { ok: false; reason: PickReason };

/**
 * 기권 여부. v2 `types.ts`에서 `PlayerState.forfeited`가 빠져 있어서(백엔드 A2 재작성 중
 * 누락된 것으로 보임) 옵셔널로 안전하게 읽는다. 필드가 돌아오면 그대로 동작한다.
 */
export function isForfeited(p: object | undefined | null): boolean {
  return !!p && (p as { forfeited?: boolean }).forfeited === true;
}
