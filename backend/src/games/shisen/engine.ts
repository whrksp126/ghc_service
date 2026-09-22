// 사천성 순수 엔진 (docs/games/shisen-design.md §1). 외부 의존 없음 — types.ts만 import.
// KEEP IN SYNC with ghc_service/frontend/src/games/shisen/engine.ts
//
// 좌표 체계: 원 격자 idx = r*cols + c. 경로 탐색은 (cols+2)x(rows+2) 패딩 격자에서 한다
// (바깥 테두리 1칸을 지나갈 수 있으므로). 패딩 좌표 pr = r+1, pc = c+1.

import { Point } from '../types';

/** 결정적 PRNG. 같은 seed면 항상 같은 수열. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * 패딩 격자의 "빈칸 맵". 1 = 지나갈 수 있음.
 * 바깥 테두리는 항상 1, 안쪽은 cells[idx] === 0 일 때만 1.
 */
function buildFreeGrid(cells: number[], cols: number, rows: number): Uint8Array {
  const w = cols + 2;
  const h = rows + 2;
  const free = new Uint8Array(w * h).fill(1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r * cols + c] !== 0) free[(r + 1) * w + (c + 1)] = 0;
    }
  }
  return free;
}

/**
 * 꺾임 ≤ 2회 경로 탐색 (패딩 좌표). 시작/끝 칸은 free 값과 무관하게 항상 "막힌 칸"으로 취급하므로
 * 판 생성(빈칸 두 개를 잇는 경우)과 게임 중(타일 두 개를 잇는 경우) 모두 같은 함수를 쓸 수 있다.
 * 반환: 꼭짓점들의 패딩 인덱스 배열(길이 2~4) 또는 null.
 */
function findPathPadded(free: Uint8Array, w: number, h: number, pa: number, pb: number): number[] | null {
  if (pa === pb) return null;
  const ra = (pa / w) | 0;
  const ca = pa % w;
  const rb = (pb / w) | 0;
  const cb = pb % w;

  const isFree = (p: number) => p !== pa && p !== pb && free[p] === 1;
  /** r행에서 c1, c2 사이(양끝 제외)가 전부 빈칸인가 */
  const clearH = (r: number, c1: number, c2: number) => {
    const lo = Math.min(c1, c2) + 1;
    const hi = Math.max(c1, c2);
    for (let c = lo; c < hi; c++) if (!isFree(r * w + c)) return false;
    return true;
  };
  /** c열에서 r1, r2 사이(양끝 제외)가 전부 빈칸인가 */
  const clearV = (c: number, r1: number, r2: number) => {
    const lo = Math.min(r1, r2) + 1;
    const hi = Math.max(r1, r2);
    for (let r = lo; r < hi; r++) if (!isFree(r * w + c)) return false;
    return true;
  };

  // 1) 직선 (꺾임 0회)
  if (ra === rb && clearH(ra, ca, cb)) return [pa, pb];
  if (ca === cb && clearV(ca, ra, rb)) return [pa, pb];

  // 2) 꺾임 1회 — 코너 후보 2개
  const cornerA = ra * w + cb; // 가로 먼저
  if (isFree(cornerA) && clearH(ra, ca, cb) && clearV(cb, ra, rb)) return [pa, cornerA, pb];
  const cornerB = rb * w + ca; // 세로 먼저
  if (isFree(cornerB) && clearV(ca, ra, rb) && clearH(rb, ca, cb)) return [pa, cornerB, pb];

  // 3) 꺾임 2회 — 테두리를 포함한 모든 행/열을 훑는다
  if (ca !== cb) {
    for (let r = 0; r < h; r++) {
      if (r === ra || r === rb) continue; // 0~1회 꺾임 케이스에서 이미 처리됨
      const k1 = r * w + ca;
      const k2 = r * w + cb;
      if (!isFree(k1) || !isFree(k2)) continue;
      if (clearV(ca, ra, r) && clearH(r, ca, cb) && clearV(cb, r, rb)) return [pa, k1, k2, pb];
    }
  }
  if (ra !== rb) {
    for (let c = 0; c < w; c++) {
      if (c === ca || c === cb) continue;
      const k1 = ra * w + c;
      const k2 = rb * w + c;
      if (!isFree(k1) || !isFree(k2)) continue;
      if (clearH(ra, ca, c) && clearV(c, ra, rb) && clearH(rb, c, cb)) return [pa, k1, k2, pb];
    }
  }

  return null;
}

/**
 * 두 칸 a, b가 빈칸만 지나는 꺾임 ≤ 2회 경로로 이어지는지. 이어지면 꼭짓점 좌표(원 격자 기준,
 * 바깥 테두리는 -1 또는 cols/rows)를 반환한다. 심볼 일치 여부는 검사하지 않는다(호출자 책임) —
 * 판 생성에서 빈칸 두 개를 잇는 데도 같은 함수를 쓰기 때문.
 */
export function findPath(cells: number[], cols: number, rows: number, a: number, b: number): Point[] | null {
  const total = cols * rows;
  if (a === b) return null;
  if (a < 0 || b < 0 || a >= total || b >= total) return null;
  const w = cols + 2;
  const free = buildFreeGrid(cells, cols, rows);
  const pa = (((a / cols) | 0) + 1) * w + (a % cols) + 1;
  const pb = (((b / cols) | 0) + 1) * w + (b % cols) + 1;
  const raw = findPathPadded(free, w, rows + 2, pa, pb);
  if (!raw) return null;
  const pts: Point[] = [];
  for (const p of raw) {
    const pt = { r: ((p / w) | 0) - 1, c: (p % w) - 1 };
    const last = pts[pts.length - 1];
    if (last && last.r === pt.r && last.c === pt.c) continue; // 방어적 중복 제거
    pts.push(pt);
  }
  return pts;
}

/** 지금 제거 가능한 같은 심볼 쌍 하나. 없으면 null(= 막힘). */
export function findAnyPair(cells: number[], cols: number, rows: number): [number, number] | null {
  const w = cols + 2;
  const h = rows + 2;
  const free = buildFreeGrid(cells, cols, rows);
  const bySymbol = new Map<number, number[]>();
  for (let i = 0; i < cells.length; i++) {
    const s = cells[i];
    if (s === 0) continue;
    const list = bySymbol.get(s);
    if (list) list.push(i);
    else bySymbol.set(s, [i]);
  }
  const toPadded = (idx: number) => (((idx / cols) | 0) + 1) * w + (idx % cols) + 1;
  for (const list of bySymbol.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (findPathPadded(free, w, h, toPadded(list[i]), toPadded(list[j]))) {
          return [list[i], list[j]];
        }
      }
    }
  }
  return null;
}

/** 남은 타일 수. */
export function countRemaining(cells: number[]): number {
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) n++;
  return n;
}

/**
 * 남은 타일의 "위치"는 유지하고 심볼만 재배치. 최소 1쌍은 제거 가능함이 보장될 때까지 재시도한다.
 * (기하학적으로 불가능한 잔여 배치면 재시도 상한 후 마지막 결과를 그대로 반환 — 호출자가 로깅)
 */
export function shuffleRemaining(cells: number[], cols: number, rows: number, rng: () => number): number[] {
  const positions: number[] = [];
  const symbols: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 0) {
      positions.push(i);
      symbols.push(cells[i]);
    }
  }
  if (positions.length === 0) return cells.slice();

  let next = cells.slice();
  for (let attempt = 0; attempt < 200; attempt++) {
    const shuffled = shuffleInPlace(symbols.slice(), rng);
    next = cells.slice();
    for (let i = 0; i < positions.length; i++) next[positions[i]] = shuffled[i];
    if (findAnyPair(next, cols, rows)) return next;
  }
  return next;
}

// --- 판 생성 (§1.3 역재생) ---

/**
 * 현재 빈칸들 중 "빈칸만 지나서" 이어지는 쌍 하나를 고른다. 반환은 empties 배열 안의 인덱스 쌍.
 *
 * 순수 무작위로 고르면 빈칸이 흩어져 "사방이 막힌 외톨이 빈칸"이 생기고, 거의 항상 마지막 몇 쌍에서
 * 후보가 말라 재시작하게 된다(14x8에서 50회 재시도 전부 실패). 그래서 제약이 가장 심한 칸(= 상하좌우
 * 빈칸 이웃이 가장 적은 칸)을 먼저 소진시킨다. 초반에는 전부 이웃 4개라 사실상 무작위이고, 후반에만
 * 위험한 칸을 우선 처리해 막다른 길을 피한다. 짝(q)은 후보 전수 열거 후 균등 추출이라 멀리 떨어진
 * 칸도 그대로 선택된다(= 같은 심볼이 항상 붙어 있는 밋밋한 판이 되지 않음).
 */
function pickConnectablePair(
  free: Uint8Array,
  w: number,
  h: number,
  empties: number[],
  rng: () => number
): [number, number] | null {
  const n = empties.length;
  if (n < 2) return null;

  const depthOf = (p: number) => {
    const r = (p / w) | 0;
    const c = p % w;
    return Math.min(r - 1, h - 2 - r, c - 1, w - 2 - c);
  };
  const degOf = (p: number) => {
    let d = 0;
    if (free[p - 1] === 1) d++;
    if (free[p + 1] === 1) d++;
    if (free[p - w] === 1) d++;
    if (free[p + w] === 1) d++;
    return d;
  };

  // 1) (자유도, 테두리로부터의 깊이)가 최소인 칸들 중 하나를 무작위로 — 저수지 샘플링
  let bestKey = Infinity;
  let tieCount = 0;
  let pi = -1;
  let minDeg = 5;
  for (let i = 0; i < n; i++) {
    const deg = degOf(empties[i]);
    const key = deg * 64 + depthOf(empties[i]);
    if (key < bestKey) {
      bestKey = key;
      minDeg = deg;
      tieCount = 1;
      pi = i;
    } else if (key === bestKey) {
      tieCount++;
      if (rng() * tieCount < 1) pi = i;
    }
  }
  if (pi < 0 || minDeg === 0) return null; // 사방이 막힌 빈칸 = 막다른 길

  // 2) p와 이어지는 후보 전수 열거. 놓았을 때 이웃 빈칸을 고립(자유도 0)시키지 않는 "안전한" 후보를
  //    우선 균등 추출하고, 안전한 게 하나도 없으면 아무 후보나 고른다.
  const p = empties[pi];
  let safeCount = 0;
  let safeKey = Infinity;
  let anyCount = 0;
  let adjCount = 0;
  let safeQi = -1;
  let anyQi = -1;
  let adjQi = -1;
  for (let j = 0; j < n; j++) {
    if (j === pi) continue;
    const q = empties[j];
    if (!findPathPadded(free, w, h, p, q)) continue;
    anyCount++;
    if (rng() * anyCount < 1) anyQi = j;
    // p, q를 채우면 이들의 이웃 빈칸 자유도가 줄어든다. 0이 되는 칸이 생기면 안전하지 않다.
    let safe = true;
    for (const c of [p - 1, p + 1, p - w, p + w, q - 1, q + 1, q - w, q + w]) {
      if (c === p || c === q || free[c] !== 1) continue;
      const isInner = c % w !== 0 && c % w !== w - 1 && c >= w && c < w * (h - 1);
      if (!isInner) continue; // 테두리는 채워지지 않으므로 고립될 일이 없다
      let d = degOf(c);
      if (c === p - 1 || c === p + 1 || c === p - w || c === p + w) d--;
      if (c === q - 1 || c === q + 1 || c === q - w || c === q + w) d--;
      if (d <= 0) {
        safe = false;
        break;
      }
    }
    if (safe) {
      const key = depthOf(q);
      if (key < safeKey) {
        safeKey = key;
        safeCount = 1;
        safeQi = j;
      } else if (key === safeKey) {
        safeCount++;
        if (rng() * safeCount < 1) safeQi = j;
      }
      const d = Math.abs(q - p);
      if (d === 1 || d === w) {
        adjCount++;
        if (rng() * adjCount < 1) adjQi = j;
      }
    }
  }
  // 끝물(빈칸이 몇 개 안 남음)에는 서로 붙은 칸을 우선한다. 그때는 판이 거의 꽉 차서 "빈칸만 지나는"
  // 긴 경로가 사라지고 인접 쌍/테두리 쌍만 남기 때문 — 이걸 미리 맞춰두면 막다른 길이 거의 없어진다.
  const qi = n <= ENDGAME_EMPTIES && adjQi >= 0 ? adjQi : safeQi >= 0 ? safeQi : anyQi;
  if (qi < 0) return null;
  return [pi, qi];
}

/**
 * 반드시 풀리는 판 생성. 빈 판에서 시작해 "지금 빈칸만 지나 이어지는 두 칸"에 같은 심볼을 심는 것을
 * 반복한다(역재생). 역순으로 지우면 항상 끝까지 풀린다. 후보가 없으면 처음부터 재시작(상한 50).
 */
/**
 * findAnyPair를 반복 적용하는 "탐욕 풀이"로 끝까지 지워지는지. 역재생 생성은 "생성의 역순으로 지우면
 * 풀린다"만 보장하므로, 순서를 다르게 지우면 막힐 수 있다(그때는 §1.4 자동 셔플). 그래도 탐욕 순서로도
 * 풀리는 판만 내보내면 실제 플레이에서 강제 셔플이 훨씬 줄어든다 — 1판당 0.6ms라 그냥 검사한다.
 */
function isGreedySolvable(cells: number[], cols: number, rows: number): boolean {
  const work = cells.slice();
  let left = countRemaining(work);
  while (left > 0) {
    const pair = findAnyPair(work, cols, rows);
    if (!pair) return false;
    work[pair[0]] = 0;
    work[pair[1]] = 0;
    left -= 2;
  }
  return true;
}

const ENDGAME_EMPTIES = 16;
const BACKTRACK_DEPTH = 4;
const MAX_BACKTRACKS = 400;

export function generateBoard(cols: number, rows: number, rng: () => number): number[] {
  const total = cols * rows;
  if (total % 4 !== 0) throw new Error(`invalid board size ${cols}x${rows}: cells must be a multiple of 4`);
  const symbolCount = total / 4;
  const w = cols + 2;
  const h = rows + 2;

  for (let attempt = 0; attempt < 50; attempt++) {
    const cells = new Array<number>(total).fill(0);
    const free = new Uint8Array(w * h).fill(1);
    const empties: number[] = []; // 아직 심볼을 안 놓은 칸(패딩 인덱스)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) empties.push((r + 1) * w + (c + 1));
    }
    // 심볼 하나당 2쌍 = 4개. 쌍 단위 리스트를 섞어 배치 순서를 무작위화.
    const order: number[] = [];
    for (let s = 1; s <= symbolCount; s++) order.push(s, s);
    shuffleInPlace(order, rng);

    const toOrig = (pp: number) => (((pp / w) | 0) - 1) * cols + ((pp % w) - 1);
    const placed: { p: number; q: number }[] = [];
    let step = 0;
    let backtracks = 0;
    let ok = true;

    while (step < order.length) {
      const pair = pickConnectablePair(free, w, h, empties, rng);
      if (!pair) {
        // 막다른 길: 판 전체를 버리는 대신 최근 몇 쌍만 되돌리고 다시 뽑는다(선택이 무작위라 다른 결과가 나온다).
        if (placed.length === 0 || backtracks >= MAX_BACKTRACKS) {
          ok = false;
          break;
        }
        backtracks++;
        for (let k = 0; k < BACKTRACK_DEPTH && placed.length > 0; k++) {
          const last = placed.pop()!;
          free[last.p] = 1;
          free[last.q] = 1;
          empties.push(last.p, last.q);
          cells[toOrig(last.p)] = 0;
          cells[toOrig(last.q)] = 0;
          step--;
        }
        continue;
      }
      const [i, j] = pair;
      const p = empties[i];
      const q = empties[j];
      free[p] = 0;
      free[q] = 0;
      cells[toOrig(p)] = order[step];
      cells[toOrig(q)] = order[step];
      placed.push({ p, q });
      // empties에서 제거(큰 인덱스부터 swap-pop)
      const hi = Math.max(i, j);
      const lo = Math.min(i, j);
      empties[hi] = empties[empties.length - 1];
      empties.pop();
      empties[lo] = empties[empties.length - 1];
      empties.pop();
      step++;
    }
    if (ok && isGreedySolvable(cells, cols, rows)) return cells;
  }
  throw new Error(`generateBoard failed for ${cols}x${rows} after 50 attempts`);
}
