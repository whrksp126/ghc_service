/**
 * 소켓 ack / 프론트 전용 보조 타입.
 * 델타 이벤트 본체는 백엔드가 소유한 `games/types.ts`를 그대로 재export 해서 드리프트를 막는다.
 */
import type { PickReason, Point } from './types';

export type {
  AttackEvent, BoardPatch, MatchedEvent, PeerSelectEvent, PickAck, PickReason,
  ShuffledEvent, UnlockedEvent, HintAck,
} from './types';

/** `game:unlocked` 페이로드 (v4에서 `game:revealed`는 프로토콜에서 삭제됨) */
export interface TilesEvent {
  seq: number; boardId: string; tiles: { idx: number; symbol: number }[];
  movesLeft?: number;
  keyType?: number;
  board?: { remaining?: number; nextNumber?: number; keysLeft?: number; movesLeft?: number };
}

/** v3: 물음표 엿보기 — 요청자에게만 심볼을 알려 주고 서버 상태는 그대로. */
export type PeekAck = { ok: true; symbol: number } | { ok: false; reason: PickReason };
/** 아이템 공통 ack */
export type ItemAck = { ok: true } | { ok: false; reason: 'none' };

export function patchOf(e: unknown): { remaining?: number; nextNumber?: number; keysLeft?: number; movesLeft?: number } | undefined {
  const p = (e as { board?: Record<string, number> } | null)?.board;
  return p && typeof p === 'object' ? p : undefined;
}

/** 기권 여부(필드가 없던 서버도 견딘다). */
export function isForfeited(p: object | undefined | null): boolean {
  return !!p && (p as { forfeited?: boolean }).forfeited === true;
}

export type { Point };
