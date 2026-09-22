/**
 * v3(W1/W2) 클라이언트 보강 레이어.
 * `games/types.ts`는 백엔드가 소유하므로, W2가 아직 안 내려온 동안에도 동작하도록
 * 상수·헬퍼를 여기에 두고 **관대하게(tolerant)** 읽는다. 값은 설계서 W2와 동일하다.
 */
import type { GameOptions, PlayerItems, PlayerState } from './types';
import {
  EMPTY, KEY_BASE, KEY_COLORS, LOCK_BASE, MAX_KEY_TYPES, MYSTERY, NUMBER_BASE, WALL,
} from './types';

export type Difficulty = 1 | 2 | 3 | 4 | 5;
export const DIFFICULTIES: Difficulty[] = [1, 2, 3, 4, 5];
export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  1: '아주 쉬움', 2: '쉬움', 3: '보통', 4: '어려움', 5: '아주 어려움',
};

/** v2 레거시 인코딩(자물쇠 98 / 열쇠 100)도 함께 인식한다(구 서버 호환). */
export const isLockValue = (v: number) => v === 98 || (v > LOCK_BASE && v <= LOCK_BASE + MAX_KEY_TYPES);
export const isKeyValue = (v: number) => v === 100 || (v > KEY_BASE && v <= KEY_BASE + MAX_KEY_TYPES);
export const isMysteryValue = (v: number) => v === MYSTERY;
export const isNumberValue = (v: number) => v > NUMBER_BASE;
export const isWallValue = (v: number) => v === WALL;
export const isTileValue = (v: number) => v !== EMPTY;

/** 자물쇠/열쇠의 종류 k (1..3). 종류 개념이 없던 레거시 값은 1로 본다. */
export function keyTypeOf(v: number): number {
  if (v === 98 || v === 100) return 1;
  if (v > LOCK_BASE && v <= LOCK_BASE + MAX_KEY_TYPES) return v - LOCK_BASE;
  if (v > KEY_BASE && v <= KEY_BASE + MAX_KEY_TYPES) return v - KEY_BASE;
  return 0;
}
export function keyColor(k: number): string {
  return KEY_COLORS[Math.max(0, Math.min(KEY_COLORS.length - 1, k - 1))];
}

/** 아이템 3종. 구 서버(hintsLeft만 있는 v2.1)도 견딘다. */
export function itemsOf(p: PlayerState | undefined | null): PlayerItems {
  const raw = p as unknown as { items?: Partial<PlayerItems>; hintsLeft?: number } | null | undefined;
  return {
    hint: raw?.items?.hint ?? raw?.hintsLeft ?? 0,
    shuffle: raw?.items?.shuffle ?? 0,
    wand: raw?.items?.wand ?? 0,
  };
}

export function difficultyOf(o: GameOptions | undefined): Difficulty {
  const d = (o as unknown as { difficulty?: number } | undefined)?.difficulty;
  return (d && d >= 1 && d <= 5 ? d : 3) as Difficulty;
}

/** 해제 이벤트의 열쇠 종류(없으면 1). */
export function keyTypeOfEvent(e: unknown): number {
  const k = (e as { keyType?: number } | null)?.keyType;
  return typeof k === 'number' && k > 0 ? k : 1;
}

/** 실시간 순위: 레이스 = 완주 → 남은 패 오름차순, 쟁탈전 = 지운 쌍 내림차순. */
export function rankOf(
  players: PlayerState[],
  mode: 'race' | 'coop',
  remainingOf: (p: PlayerState) => number,
  userId: string | null,
): number {
  const sorted = [...players].sort((a, b) => {
    if (mode === 'coop') return b.pairsCleared - a.pairsCleared || b.score - a.score;
    if (a.finishedAt !== null || b.finishedAt !== null) {
      if (a.finishedAt === null) return 1;
      if (b.finishedAt === null) return -1;
      return a.finishedAt - b.finishedAt;
    }
    return remainingOf(a) - remainingOf(b) || b.score - a.score;
  });
  const i = sorted.findIndex((p) => p.userId === userId);
  return i < 0 ? sorted.length : i + 1;
}

/** 맵 가이드 문구 (W3 우측 컬럼) */
export const MAP_GUIDE: Record<string, { name: string; desc: string }> = {
  random: { name: '랜덤', desc: '매 판 아래 모양 중 하나가 무작위로 뽑혀요.' },
  rect: { name: '직사각형', desc: '격자를 꽉 채운 기본 판. 정석적인 사천성.' },
  diamond: { name: '다이아몬드', desc: '가운데가 넓고 위아래가 좁아 바깥쪽부터 풀기 좋아요.' },
  frame: { name: '액자', desc: '테두리 두 겹과 가운데 덩어리. 안쪽이 늦게 열려요.' },
  towers: { name: '쌍둥이 탑', desc: '좌우 탑과 가운데 몸통. 탑 위쪽이 병목이에요.' },
  pyramid: { name: '피라미드', desc: '아래가 넓은 삼각형. 위에서부터 무너뜨려요.' },
  cross: { name: '십자', desc: '길이 좁아 꺾임 2회 제한이 까다로워요.' },
  blob: { name: '얼룩', desc: '좌우대칭 랜덤 얼룩. 판마다 결이 달라요.' },
};

export const SPECIAL_GUIDE: Array<{ key: string; title: string; desc: string }> = [
  { key: 'mystery', title: '물음표', desc: '클릭하면 잠깐 엿볼 수 있어요. 실패하면 다시 가려집니다.' },
  { key: 'numbers', title: '숫자 순서', desc: '1번부터 차례대로만 지울 수 있어요.' },
  { key: 'keys', title: '자물쇠·열쇠', desc: '같은 색 열쇠 쌍을 지우면 그 색 자물쇠가 열려요.' },
  { key: 'walls', title: '벽', desc: '지울 수 없고 길도 막아요.' },
];
