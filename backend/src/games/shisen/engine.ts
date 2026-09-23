// 사천성 순수 엔진 v2 (docs/games/shisen-design.md §1 + v2 §V3/§V4). 외부 의존 없음 — types.ts만 import.
// KEEP IN SYNC with ghc_service/frontend/src/games/shisen/engine.ts
//
// 좌표 체계: 원 격자 idx = r*cols + c. 경로 탐색은 (cols+2)x(rows+2) 패딩 격자에서 한다
// (바깥 테두리 1칸을 지나갈 수 있으므로). 패딩 좌표 pr = r+1, pc = c+1.
// 마스크 밖 칸은 처음부터 EMPTY라 경로가 그냥 지나간다. WALL만 영구 차단.

import {
  BOARD_DIMS,
  BoardSize,
  Difficulty,
  EMPTY,
  GameOptions,
  KEY_BASE,
  LOCK_BASE,
  MAX_KEY_TYPES,
  MYSTERY,
  MapShape,
  NUMBER_BASE,
  PickReason,
  Point,
  WALL,
  isKey,
  isLock,
  isNormalSymbol,
} from '../types';

export type Shape = Exclude<MapShape, 'random'>;
const SHAPES: Shape[] = ['rect', 'diamond', 'frame', 'towers', 'pyramid', 'cross', 'blob'];
const SYMBOL_COUNT = 28; // symbols.ts 아이콘 수 (1..28)

/** canPick / findAnyMove 가 보는 판. 클라는 마스킹된 cells, 서버는 진실 cells를 넣는다. */
export interface PickView {
  cells: number[];
  cols: number;
  rows: number;
  nextNumber: number;
  keysLeft: number;
}

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

// --- 경로 탐색 -------------------------------------------------------------

/**
 * 패딩 격자의 "빈칸 맵". 1 = 지나갈 수 있음.
 * 바깥 테두리는 항상 1, 안쪽은 cells[idx] === EMPTY 일 때만 1(WALL 포함 그 외는 전부 차단).
 */
function buildFreeGrid(cells: number[], cols: number, rows: number): Uint8Array {
  const w = cols + 2;
  const h = rows + 2;
  const free = new Uint8Array(w * h).fill(1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r * cols + c] !== EMPTY) free[(r + 1) * w + (c + 1)] = 0;
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
 * 바깥 테두리는 -1 또는 cols/rows)를 반환한다. 심볼/규칙은 검사하지 않는다(canPick 담당) —
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

/** 남은 타일 수(벽·빈칸 제외). */
export function countRemaining(cells: number[]): number {
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] > 0) n++;
  return n;
}

// --- 규칙 판정 (클라·서버 공용) --------------------------------------------

const isNumberTile = (v: number) => v > NUMBER_BASE;
/** 지금 고를 수 있는 "종류"의 타일인가 (빈칸·벽·자물쇠·아직 안 뒤집힌 물음표 제외) */
const isPickableValue = (v: number, nextNumber: number) => {
  if (v <= EMPTY || v === WALL || v === MYSTERY || isLock(v)) return false;
  if (isNumberTile(v)) return v === NUMBER_BASE + nextNumber;
  return isNormalSymbol(v) || isKey(v);
};

/**
 * 두 칸을 제거할 수 있는지. null = 가능, 아니면 거절 사유.
 * cells에 무엇이 들어있는지로만 판단하므로 클라(마스킹된 판)와 서버(진실 판 + 마스킹 뷰) 양쪽에서 쓴다.
 */
export function canPick(view: PickView, a: number, b: number): PickReason | null {
  const { cells, cols, rows, nextNumber } = view;
  const total = cols * rows;
  if (a === b) return 'same';
  if (a < 0 || b < 0 || a >= total || b >= total) return 'gone';
  const va = cells[a];
  const vb = cells[b];
  if (va === WALL || vb === WALL) return 'wall';
  if (va === EMPTY || vb === EMPTY) return 'gone';
  if (isLock(va) || isLock(vb)) return 'locked';
  // v3: 물음표는 서버가 진실 심볼로 판정한다. 클라가 아직 엿보지 않은 칸(MYSTERY)은 예측 불가 → 'symbol'.
  if (va === MYSTERY || vb === MYSTERY) return 'symbol';
  if (va !== vb) return 'symbol';
  if (isNumberTile(va) && va !== NUMBER_BASE + nextNumber) return 'order';
  if (!isPickableValue(va, nextNumber)) return 'symbol';
  if (!findPath(cells, cols, rows, a, b)) return 'nopath';
  return null;
}

function scanMoves(view: PickView, firstOnly: boolean): [number, number][] {
  const { cells, cols, rows, nextNumber } = view;
  const w = cols + 2;
  const h = rows + 2;
  const free = buildFreeGrid(cells, cols, rows);
  const byValue = new Map<number, number[]>();
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (!isPickableValue(v, nextNumber)) continue;
    const list = byValue.get(v);
    if (list) list.push(i);
    else byValue.set(v, [i]);
  }
  const toPadded = (idx: number) => (((idx / cols) | 0) + 1) * w + (idx % cols) + 1;
  const out: [number, number][] = [];
  for (const list of byValue.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!findPathPadded(free, w, h, toPadded(list[i]), toPadded(list[j]))) continue;
        out.push([list[i], list[j]]);
        if (firstOnly) return out;
      }
    }
  }
  return out;
}

/** 지금 규칙상 제거 가능한 쌍 하나. 없으면 null(= 막힘). */
export function findAnyMove(view: PickView): [number, number] | null {
  const found = scanMoves(view, true);
  return found.length > 0 ? found[0] : null;
}

/** 지금 규칙상 제거 가능한 쌍 전부 (v2.1 movesLeft / HUD "연결 가능 N쌍"). */
export function findAllMoves(view: PickView): [number, number][] {
  return scanMoves(view, false);
}

/**
 * 진실 cells에 물음표/자물쇠 플레이스홀더를 씌운다(클라 전송용).
 * locks는 idx → 열쇠 종류(1..MAX_KEY_TYPES) 맵. 자물쇠는 LOCK_BASE+k 로 나간다(색만 보임).
 */
export function maskForClient(
  cells: number[],
  hidden: Iterable<number>,
  locks: ReadonlyMap<number, number>
): number[] {
  const out = cells.slice();
  for (const [idx, keyType] of locks) if (out[idx] > 0) out[idx] = LOCK_BASE + keyType;
  for (const idx of hidden) if (out[idx] > 0 && !isLock(out[idx])) out[idx] = MYSTERY;
  return out;
}

/** 자물쇠만 씌운 뷰(막힘 검사·movesLeft 용): 물음표는 심볼을 아는 것으로 본다. */
export const NO_HIDDEN: readonly number[] = [];

/**
 * 일반 심볼(1..28)만 자리끼리 재배치. 벽·열쇠·숫자는 고정, 자물쇠/물음표는 "자리"가 유지되므로
 * 자물쇠 안의 심볼만 바뀐다. 최소 한 수가 생길 때까지 재시도하고, 가능하면 "보이는 수"가 있는 결과를 고른다.
 * (V4 시그니처의 cells 자리에 PickView를 받는다 — cols/rows 없이는 수가 있는지 확인할 수 없어서)
 */
export function shuffleNormals(
  view: PickView,
  hidden: ReadonlySet<number>,
  locks: ReadonlyMap<number, number>,
  rng: () => number
): number[] {
  const { cells, cols, rows, nextNumber, keysLeft } = view;
  const positions: number[] = [];
  const symbols: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (isNormalSymbol(cells[i])) {
      positions.push(i);
      symbols.push(cells[i]);
    }
  }
  if (positions.length < 2) return cells.slice();

  let fallback: number[] | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const shuffled = shuffleInPlace(symbols.slice(), rng);
    const next = cells.slice();
    for (let i = 0; i < positions.length; i++) next[positions[i]] = shuffled[i];

    const lockedView: PickView = { cells: maskForClient(next, NO_HIDDEN, locks), cols, rows, nextNumber, keysLeft };
    if (!findAnyMove(lockedView)) continue;
    if (!fallback) fallback = next;
    // 물음표까지 가린 상태에서도 수가 보이면 더 좋은 결과
    const visibleView: PickView = { ...lockedView, cells: maskForClient(next, hidden, locks) };
    if (findAnyMove(visibleView)) return next;
  }
  return fallback ?? cells.slice();
}

// --- 맵 마스크 (V3) --------------------------------------------------------

export function pickShape(rng: () => number): Shape {
  return SHAPES[Math.floor(rng() * SHAPES.length)];
}

function countMask(mask: boolean[]): number {
  let n = 0;
  for (const v of mask) if (v) n++;
  return n;
}

/** 좌우대칭 그룹(짝수 cols면 항상 2칸, 홀수 cols의 가운데 열만 1칸) */
function mirrorGroup(idx: number, cols: number): number[] {
  const r = (idx / cols) | 0;
  const c = idx % cols;
  const mc = cols - 1 - c;
  return mc === c ? [idx] : [idx, r * cols + mc];
}

function neighborsOf(idx: number, cols: number, rows: number): number[] {
  const r = (idx / cols) | 0;
  const c = idx % cols;
  const out: number[] = [];
  if (r > 0) out.push(idx - cols);
  if (r < rows - 1) out.push(idx + cols);
  if (c > 0) out.push(idx - 1);
  if (c < cols - 1) out.push(idx + 1);
  return out;
}

/** 좌우대칭 랜덤 얼룩: 왼쪽 절반에서 프런티어 성장 → 미러 */
function blobMask(cols: number, rows: number, rng: () => number): boolean[] {
  const mask = new Array<boolean>(cols * rows).fill(false);
  const halfCols = Math.ceil(cols / 2);
  const target = Math.max(2, Math.round(cols * rows * 0.62 * 0.5)); // 왼쪽 절반 목표
  const inLeft = (idx: number) => idx % cols < halfCols;

  const start = Math.floor(rows / 2) * cols + Math.max(0, halfCols - 1);
  const region = new Set<number>([start]);
  const frontier = new Set<number>();
  const addFrontier = (idx: number) => {
    for (const n of neighborsOf(idx, cols, rows)) {
      if (inLeft(n) && !region.has(n)) frontier.add(n);
    }
  };
  addFrontier(start);
  while (region.size < target && frontier.size > 0) {
    const list = [...frontier];
    const pickIdx = list[Math.floor(rng() * list.length)];
    frontier.delete(pickIdx);
    region.add(pickIdx);
    addFrontier(pickIdx);
  }
  for (const idx of region) {
    for (const m of mirrorGroup(idx, cols)) mask[m] = true;
  }
  return mask;
}

function presetMask(shape: Shape, cols: number, rows: number, rng: () => number): boolean[] {
  if (shape === 'blob') return blobMask(cols, rows, rng);
  const mask = new Array<boolean>(cols * rows).fill(false);
  const halfW = cols / 2;
  const halfH = rows / 2;
  const cc = (cols - 1) / 2;
  const cr = (rows - 1) / 2;
  // 액자: 두께 2의 바깥 테두리 + 속이 빈 안쪽 + 가운데 작은 덩어리(좌우대칭이라 폭은 짝수)
  const coreW = cols >= 16 ? 4 : cols >= 12 ? 4 : 2;
  const coreH = rows >= 10 ? 3 : 2;
  const coreC0 = (cols - coreW) / 2;
  const coreR0 = Math.floor((rows - coreH) / 2);
  // 쌍둥이 탑: 좌우 탑 + 아래쪽 절반 몸통 + 꼭대기 가운데 목
  const towerW = cols >= 16 ? 4 : 3;
  const neckW = 2;
  const neckC0 = (cols - neckW) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = Math.abs(c - cc);
      const dy = Math.abs(r - cr);
      let on = false;
      switch (shape) {
        case 'rect':
          on = true;
          break;
        case 'diamond':
          on = dx / halfW + dy / halfH <= 1.15;
          break;
        case 'frame':
          on =
            r < 2 ||
            r >= rows - 2 ||
            c < 2 ||
            c >= cols - 2 ||
            (r >= coreR0 && r < coreR0 + coreH && c >= coreC0 && c < coreC0 + coreW);
          break;
        case 'towers':
          on =
            c < towerW || // 왼쪽 탑
            c >= cols - towerW || // 오른쪽 탑
            r >= rows / 2 || // 아래쪽 절반 몸통
            (r < 2 && c >= neckC0 && c < neckC0 + neckW); // 꼭대기 가운데 목
          break;
        case 'pyramid':
          on = dx <= (halfW * (r + 1)) / rows + 0.5;
          break;
        case 'cross':
          on = dx <= cols * 0.18 || dy <= rows * 0.22;
          break;
      }
      if (on) mask[r * cols + c] = true;
    }
  }
  return mask;
}

/**
 * 모양 마스크. 좌우대칭을 유지한 채 타일 수를 `4k`(wantMod4Plus=0) 또는 `4k+2`(=2)로 맞춘다.
 * 보정은 가장자리(마스크 이웃이 적은 칸)를 대칭 그룹 단위로 빼거나, 뺄 수 없으면 붙여서 한다.
 */
export function buildMask(
  shape: Shape,
  cols: number,
  rows: number,
  rng: () => number,
  wantMod4Plus: 0 | 2
): boolean[] {
  const mask = presetMask(shape, cols, rows, rng);
  const maskNeighbors = (idx: number) => neighborsOf(idx, cols, rows).filter((n) => mask[n]).length;

  for (let guard = 0; guard < 24; guard++) {
    const n = countMask(mask);
    if (((n % 4) + 4) % 4 === wantMod4Plus) break;
    const need = (((n - wantMod4Plus) % 4) + 4) % 4; // 1,2,3 중 하나

    // 빼기 후보: 빈 공간과 맞닿은 "안쪽 경계" 칸부터(이웃이 많을수록 안쪽 = 실루엣을 덜 깬다)
    const removable: number[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i] && maskNeighbors(i) < 4) removable.push(i);
    removable.sort((a, b) => maskNeighbors(b) - maskNeighbors(a) || (rng() < 0.5 ? -1 : 1));
    // 붙이기 후보: 마스크에 인접한 바깥 칸(움푹 팬 곳부터 메운다)
    const addable: number[] = [];
    for (let i = 0; i < mask.length; i++) if (!mask[i] && maskNeighbors(i) > 0) addable.push(i);
    addable.sort((a, b) => maskNeighbors(b) - maskNeighbors(a) || (rng() < 0.5 ? -1 : 1));

    const wantGroupSize = need === 2 ? 2 : 1; // 짝수 cols면 1칸 그룹이 없으므로 아래에서 2칸으로 떨어진다
    const tryApply = (pool: number[], value: boolean, size: number): boolean => {
      for (const idx of pool) {
        const group = mirrorGroup(idx, cols);
        if (group.length !== size) continue;
        if (group.some((g) => mask[g] === value)) continue;
        for (const g of group) mask[g] = value;
        return true;
      }
      return false;
    };
    // 4의 배수 맞추기는 "빈 곳 메우기"를 먼저 한다 — 실루엣(테두리·탑)을 깎지 않기 위해서.
    // 2칸을 더하는 것과 빼는 것은 mod 4에서 같은 효과라 어느 쪽이든 된다.
    if (
      !tryApply(addable, true, wantGroupSize) &&
      !tryApply(removable, false, wantGroupSize) &&
      !tryApply(addable, true, wantGroupSize === 2 ? 1 : 2) &&
      !tryApply(removable, false, wantGroupSize === 2 ? 1 : 2)
    ) {
      break;
    }
  }
  return mask;
}

/** 로비 썸네일용. 같은 seed면 항상 같은 마스크. */
export function previewMask(options: GameOptions, seed: number, sizeOverride?: BoardSize): boolean[] {
  const { cols, rows } = BOARD_DIMS[sizeOverride ?? options.boardSize];
  const rng = mulberry32(seed);
  const shape = options.mapShape === 'random' ? pickShape(rng) : options.mapShape;
  return buildMask(shape, cols, rows, rng, options.specials.keys ? 2 : 0);
}

// --- 역재생 판 생성 (§1.3 + V3) --------------------------------------------

const BACKTRACK_DEPTH = 4;
const MAX_BACKTRACKS = 400;
const ENDGAME_EMPTIES = 16;

/** 난이도 튜닝 (v3 §W1) */
const SYMBOL_VARIETY = [0.55, 0.7, 0.85, 1, 1];      // 사용 심볼 수 배율
const DISTANCE_ALPHA = [-0.6, -0.3, 0, 0.6, 1.2];    // 쌍 배치 거리 가중치
const HARD_FROM = 4;                                  // d≥4: 붙은 쌍 회피 + 인접 동일쌍 상한
const MAX_ADJACENT_PAIRS_HARD = 2;
const HARD_RETRIES = [2, 5];                          // d4 / d5 — 상한을 못 맞추면 그중 제일 좋은 판
const HARD_TIME_BUDGET_MS = 45;                       // 재시도가 게임 시작을 붙잡지 않도록

export interface DifficultyTuning {
  alpha: number;
  endgameAdjacency: boolean;
  avoidAdjacent: boolean;
  minimizeAdjacency: boolean;
  symbolVariety: number;
  /** 인접 상한을 못 맞췄을 때 다시 만들어 보는 횟수(가장 좋은 판을 쓴다) */
  hardRetries: number;
}

export function difficultyTuning(difficulty: Difficulty): DifficultyTuning {
  const d = Math.min(5, Math.max(1, difficulty)) as Difficulty;
  return {
    alpha: DISTANCE_ALPHA[d - 1],
    endgameAdjacency: d < HARD_FROM,
    avoidAdjacent: d >= HARD_FROM,
    minimizeAdjacency: d >= HARD_FROM,
    symbolVariety: SYMBOL_VARIETY[d - 1],
    hardRetries: d >= HARD_FROM ? HARD_RETRIES[d - HARD_FROM] : 0,
  };
}

/** 초기 판에서 상하좌우로 붙어 있는 같은 심볼 쌍 수 (난이도 지표) */
export function countAdjacentEqualPairs(cells: number[], cols: number, rows: number): number {
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = cells[r * cols + c];
      if (!isNormalSymbol(v)) continue;
      if (c + 1 < cols && cells[r * cols + c + 1] === v) n++;
      if (r + 1 < rows && cells[(r + 1) * cols + c] === v) n++;
    }
  }
  return n;
}

/**
 * 현재 빈칸들 중 "빈칸만 지나서" 이어지는 쌍 하나를 고른다. 반환은 empties 배열 안의 인덱스 쌍.
 *
 * 순수 무작위로 고르면 빈칸이 흩어져 "사방이 막힌 외톨이 빈칸"이 생기고 마지막 몇 쌍에서 후보가 말라
 * 재시작하게 된다. 그래서 (1) 자유도가 낮고 (2) 영구 빈 공간(마스크 밖·테두리)에 가까운 칸부터 소진시키고,
 * (3) 이웃을 고립시키지 않는 짝을 고르고, (4) 끝물에는 붙어 있는 칸을 우선한다.
 */
function pickConnectablePair(
  free: Uint8Array,
  w: number,
  h: number,
  empties: number[],
  depth: Int32Array,
  rng: () => number,
  stuckOut: { cell: number },
  tuning: DifficultyTuning
): [number, number] | null {
  const n = empties.length;
  stuckOut.cell = -1;
  if (n < 2) return null;

  const degOf = (p: number) => {
    let d = 0;
    if (free[p - 1] === 1) d++;
    if (free[p + 1] === 1) d++;
    if (free[p - w] === 1) d++;
    if (free[p + w] === 1) d++;
    return d;
  };

  // 1) (자유도, 바깥으로부터의 깊이)가 최소인 칸 — 동률은 저수지 샘플링
  let bestKey = Infinity;
  let tieCount = 0;
  let pi = -1;
  let minDeg = 5;
  for (let i = 0; i < n; i++) {
    const p = empties[i];
    const deg = degOf(p);
    const key = deg * 256 + depth[p];
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
  if (pi < 0) return null;
  if (minDeg === 0) {
    stuckOut.cell = empties[pi]; // 사방이 막힌 빈칸 = 막다른 길
    return null;
  }

  // 2) p와 이어지는 후보 전수 열거. 이웃을 고립시키지 않는 "안전한" 후보를 모아
  //    난이도 가중치(거리)로 뽑는다. 안전한 게 하나도 없으면 아무 후보나.
  const p = empties[pi];
  const pr = (p / w) | 0;
  const pc = p % w;
  const maxDist = w + h + 4;
  const safe: { j: number; weight: number; adjacent: boolean }[] = [];
  let anyCount = 0;
  let anyQi = -1;
  let minSafeDepth = Infinity;
  for (let j = 0; j < n; j++) {
    if (j === pi) continue;
    const q = empties[j];
    const path = findPathPadded(free, w, h, p, q);
    if (!path) continue;
    anyCount++;
    if (rng() * anyCount < 1) anyQi = j;
    let ok = true;
    for (const c of [p - 1, p + 1, p - w, p + w, q - 1, q + 1, q - w, q + w]) {
      if (c === p || c === q || free[c] !== 1) continue;
      if (depth[c] < 0) continue; // 영구 빈칸(마스크 밖·테두리)은 고립될 일이 없다
      let d = degOf(c);
      if (c === p - 1 || c === p + 1 || c === p - w || c === p + w) d--;
      if (c === q - 1 || c === q + 1 || c === q - w || c === q + w) d--;
      if (d <= 0) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // dist = 맨해튼 거리 + 꺾임 수×2. 0..1로 정규화해 가중치가 음수가 되지 않게 한다.
    const qr = (q / w) | 0;
    const qc = q % w;
    const dist = Math.abs(qr - pr) + Math.abs(qc - pc) + (path.length - 2) * 2;
    const gap = Math.abs(q - p);
    const adjacent = gap === 1 || gap === w;
    const weight = Math.max(0.05, 1 + tuning.alpha * Math.min(1, dist / maxDist));
    safe.push({ j, weight, adjacent });
    if (depth[q] < minSafeDepth) minSafeDepth = depth[q];
  }

  // d≥4: 붙은 쌍은 다른 안전한 후보가 하나도 없을 때만 쓴다(초기 판의 "바로 옆 같은 그림" 최소화).
  // 끝물에서는 붙은 쌍 말고 선택지가 거의 없어서, 거기까지 막으면 생성이 몇 배로 느려진다 → 제외.
  if (tuning.avoidAdjacent && n > ENDGAME_EMPTIES && safe.some((c) => !c.adjacent)) {
    for (let i = safe.length - 1; i >= 0; i--) if (safe[i].adjacent) safe.splice(i, 1);
  }

  let qi = -1;
  if (safe.length > 0) {
    // 바깥쪽(깊이가 얕은) 칸을 먼저 소진하는 성질은 유지하되 절대 우선은 아니게 — 난이도 가중치가 먹히도록.
    let total = 0;
    for (const cand of safe) {
      cand.weight /= 1 + (depth[empties[cand.j]] - minSafeDepth);
      total += cand.weight;
    }
    // 끝물에는 붙은 칸을 우선한다(쉬운 난이도에서만). 판이 거의 꽉 차 긴 경로가 사라지는 구간이라
    // 이걸 맞춰두면 막다른 길이 거의 없어진다.
    if (tuning.endgameAdjacency && n <= ENDGAME_EMPTIES) {
      const adj = safe.filter((c) => c.adjacent);
      if (adj.length > 0) qi = adj[Math.floor(rng() * adj.length)].j;
    }
    if (qi < 0) {
      let roll = rng() * total;
      for (const cand of safe) {
        roll -= cand.weight;
        if (roll <= 0) {
          qi = cand.j;
          break;
        }
      }
      if (qi < 0) qi = safe[safe.length - 1].j;
    }
  } else {
    qi = anyQi;
  }
  if (qi < 0) {
    stuckOut.cell = p; // 이어지는 짝이 하나도 없는 칸
    return null;
  }
  return [pi, qi];
}

/** 각 칸의 "영구 빈 공간까지의 거리"(BFS). 영구 빈칸 자체는 -1. 바깥쪽부터 채우기 위한 지표. */
function buildDepthMap(free: Uint8Array, permanent: Uint8Array, w: number, h: number): Int32Array {
  const depth = new Int32Array(w * h).fill(0x3fffffff);
  const queue: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (permanent[i] === 1) {
      depth[i] = -1;
      queue.push(i);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const base = depth[cur] < 0 ? 0 : depth[cur];
    for (const nb of [cur - 1, cur + 1, cur - w, cur + w]) {
      if (nb < 0 || nb >= w * h) continue;
      if (depth[nb] !== 0x3fffffff) continue;
      if (free[nb] === 0 && permanent[nb] === 0) continue; // 벽은 건너뛴다(깊이 무한)
      depth[nb] = base + 1;
      queue.push(nb);
    }
  }
  for (let i = 0; i < depth.length; i++) if (depth[i] === 0x3fffffff) depth[i] = 255;
  return depth;
}

export interface GenerateV2Options {
  cols: number;
  rows: number;
  mask: boolean[];
  walls: boolean;
  /** 숫자 순서 쌍 수 K (0 = 끄기) */
  numbers: number;
  /** 열쇠 종류 수 (0 = 자물쇠/열쇠 끄기). 종류마다 열쇠 1쌍 */
  keyTypes: number;
  mystery: boolean;
  difficulty: Difficulty;
}

export interface GeneratedBoard {
  /** 서버 진실: 숨김/잠금 마스킹 없음 */
  cells: number[];
  hidden: number[];
  /** [칸, 열쇠 종류] — 그 색 열쇠 쌍을 지우면 풀린다 */
  locks: [number, number][];
  /** 정방향 제거 순서 R — 이대로 지우면 규칙(순서·잠금 포함)을 지켜도 반드시 풀린다 */
  order: [number, number][];
}

const WALL_RATIO_MIN = 0.04;
const WALL_RATIO_MAX = 0.08;
const LOCK_RATIO = 0.25;
const MYSTERY_RATIO = 0.2;
/** v4 §X2.2 특수 타일 분산 제약 */
const SPECIAL_MIN_CHEBYSHEV = 3;
const MYSTERY_ADJACENT_RATIO = 0.25;

/** 마스크 안쪽에 좌우대칭으로 벽을 놓는다. 벽 수는 4의 배수(= 플레이 타일 수의 mod 4 유지). */
function placeWalls(mask: boolean[], cols: number, rows: number, rng: () => number): number[] {
  const inside: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const c = i % cols;
    if (c > cols - 1 - c) continue; // 왼쪽 절반(+가운데)만 후보로
    inside.push(i);
  }
  const maskCount = countMask(mask);
  const ratio = WALL_RATIO_MIN + rng() * (WALL_RATIO_MAX - WALL_RATIO_MIN);
  let pairs = Math.round((maskCount * ratio) / 2);
  pairs -= pairs % 2; // 벽 수 = 2*pairs ≡ 0 (mod 4)
  // 작은 판(4~8%가 2칸 미만)에서도 토글을 켜면 벽이 보여야 하므로 최소 4칸은 놓는다.
  if (pairs < 2 && maskCount >= 24) pairs = 2;
  if (pairs <= 0) return [];

  shuffleInPlace(inside, rng);
  const walls: number[] = [];
  const blocked = new Set<number>();
  for (const idx of inside) {
    if (walls.length >= pairs * 2) break;
    const group = mirrorGroup(idx, cols);
    if (group.length !== 2) continue; // 가운데 열 단독은 건너뛴다(4의 배수 유지)
    if (group.some((g) => blocked.has(g))) continue;
    // 이웃 타일을 완전히 가두지 않도록 확인
    let ok = true;
    for (const g of group) {
      for (const nb of neighborsOf(g, cols, rows)) {
        if (!mask[nb] || blocked.has(nb)) continue;
        const openNeighbors = neighborsOf(nb, cols, rows).filter(
          (x) => !mask[x] || (!blocked.has(x) && !group.includes(x))
        ).length;
        if (openNeighbors <= 1) ok = false;
      }
    }
    if (!ok) continue;
    for (const g of group) {
      blocked.add(g);
      walls.push(g);
    }
  }
  return walls;
}

/**
 * 역재생으로 마스크를 채운다. 반환은 "놓은 순서"의 좌표 쌍 목록(뒤집으면 제거 순서 R).
 * 벽은 미리 점유된 상태, 마스크 밖은 영구 빈칸(경로 통과 가능).
 */
function reversePlay(
  cols: number,
  rows: number,
  mask: boolean[],
  wallSet: Set<number>,
  rng: () => number,
  tuning: DifficultyTuning
): [number, number][] | null {
  const w = cols + 2;
  const h = rows + 2;
  const toPadded = (idx: number) => (((idx / cols) | 0) + 1) * w + (idx % cols) + 1;
  const toOrig = (p: number) => (((p / w) | 0) - 1) * cols + ((p % w) - 1);

  const free = new Uint8Array(w * h).fill(1);
  const permanent = new Uint8Array(w * h).fill(0);
  // 테두리 + 마스크 밖 = 영구 빈칸
  for (let i = 0; i < w * h; i++) {
    const pr = (i / w) | 0;
    const pc = i % w;
    if (pr === 0 || pc === 0 || pr === h - 1 || pc === w - 1) permanent[i] = 1;
  }
  for (let idx = 0; idx < cols * rows; idx++) {
    if (!mask[idx]) permanent[toPadded(idx)] = 1;
  }
  for (const wall of wallSet) free[toPadded(wall)] = 0;

  const depth = buildDepthMap(free, permanent, w, h);

  const empties: number[] = [];
  for (let idx = 0; idx < cols * rows; idx++) {
    if (mask[idx] && !wallSet.has(idx)) empties.push(toPadded(idx));
  }
  if (empties.length % 2 !== 0) return null;

  const placed: [number, number][] = []; // 패딩 좌표 쌍(배치 순서)
  const stuckOut = { cell: -1 };
  let backtracks = 0;
  while (empties.length > 0) {
    const pair = pickConnectablePair(free, w, h, empties, depth, rng, stuckOut, tuning);
    if (!pair) {
      if (placed.length === 0 || backtracks >= MAX_BACKTRACKS) return null;
      backtracks++;
      // 막힌 칸 주변에 놓인 쌍만 골라 되돌린다(맹목적으로 최근 것을 무르는 것보다 훨씬 잘 풀린다).
      // 앞쪽 배치를 빼도 뒤쪽 배치의 경로는 그대로 유효하다 — 빈칸이 늘어나기만 하므로.
      const victims: number[] = [];
      if (stuckOut.cell >= 0) {
        const around = new Set([
          stuckOut.cell - 1,
          stuckOut.cell + 1,
          stuckOut.cell - w,
          stuckOut.cell + w,
        ]);
        for (let k = placed.length - 1; k >= 0 && victims.length < BACKTRACK_DEPTH; k--) {
          if (around.has(placed[k][0]) || around.has(placed[k][1])) victims.push(k);
        }
      }
      if (victims.length === 0) {
        for (let k = 0; k < BACKTRACK_DEPTH && k < placed.length; k++) victims.push(placed.length - 1 - k);
      }
      for (const k of victims) {
        const [pp, pq] = placed[k];
        free[pp] = 1;
        free[pq] = 1;
        empties.push(pp, pq);
      }
      const drop = new Set(victims);
      let write = 0;
      for (let k = 0; k < placed.length; k++) if (!drop.has(k)) placed[write++] = placed[k];
      placed.length = write;
      continue;
    }
    const [i, j] = pair;
    const p = empties[i];
    const q = empties[j];
    free[p] = 0;
    free[q] = 0;
    placed.push([p, q]);
    const hi = Math.max(i, j);
    const lo = Math.min(i, j);
    empties[hi] = empties[empties.length - 1];
    empties.pop();
    empties[lo] = empties[empties.length - 1];
    empties.pop();
  }
  return placed.map(([p, q]) => [toOrig(p), toOrig(q)] as [number, number]);
}

/**
 * 반드시 풀리는 v2 판 생성.
 * 1) 역재생으로 쌍 배치 순서를 만들고 뒤집어 제거 순서 R을 얻는다.
 * 2) R[0] = 열쇠 쌍(켜면), R에서 균등 간격 K쌍 = 숫자 1..K(순서대로), 나머지 일반 쌍의 25% = 자물쇠,
 *    일반 타일의 20% = 물음표.
 * R 순서대로 지우면 순서·잠금 규칙을 지켜도 항상 끝까지 풀린다(자물쇠는 열쇠가 R[0]이라 바로 풀린다).
 */
export function generateBoardV2(opts: GenerateV2Options, rng: () => number): GeneratedBoard {
  const { cols, rows, mask, walls, numbers, keyTypes, mystery, difficulty } = opts;
  const tuning = difficultyTuning(difficulty);
  let best: GeneratedBoard | null = null;
  let bestAdjacency = Infinity;
  let hardTries = 0;
  const startedAt = Date.now();

  for (let attempt = 0; attempt < 50; attempt++) {
    const wallList = walls ? placeWalls(mask, cols, rows, rng) : [];
    const wallSet = new Set(wallList);
    const placed = reversePlay(cols, rows, mask, wallSet, rng, tuning);
    if (!placed) continue;

    const order: [number, number][] = placed.slice().reverse(); // 정방향 제거 순서 R
    const cells = new Array<number>(cols * rows).fill(EMPTY);
    for (const idx of wallSet) cells[idx] = WALL;

    // 열쇠·숫자는 "R 안에서 어느 쌍을 쓸지"를 골라서 배치 제약(v4 §X2.2)을 맞춘다.
    // 자리를 바꾸는 게 아니라 쌍을 고르는 방식이라 제거 순서 R 의 풀이 가능성이 그대로 유지된다.
    const keyPairs = Math.max(0, Math.min(keyTypes, MAX_KEY_TYPES, order.length));
    const usedByRule = new Set<number>(); // R 인덱스
    const cheb = (x: number, y: number) =>
      Math.max(Math.abs(((x / cols) | 0) - ((y / cols) | 0)), Math.abs((x % cols) - (y % cols)));
    const keyTiles: number[] = [];
    let lastKeyIndex = -1;
    for (let k = 1; k <= keyPairs; k++) {
      // 열쇠는 앞쪽 R 구간에서 고른다(뒤의 자물쇠가 항상 열쇠보다 나중이 되도록).
      const window = Math.min(order.length, Math.max(keyPairs * 10, Math.floor(order.length * 0.45), 30));
      let chosen = -1;
      // 완화 순서: (앞 구간, 거리+비인접) → (전체, 거리+비인접) → (전체, 비인접) → 아무거나.
      // "열쇠끼리 8방향 인접 금지"는 가장 마지막까지 지킨다.
      const passes: { scope: number; distance: boolean; nonAdjacent: boolean }[] = [
        { scope: window, distance: true, nonAdjacent: true },
        { scope: order.length, distance: true, nonAdjacent: true },
        { scope: order.length, distance: false, nonAdjacent: true },
        { scope: order.length, distance: false, nonAdjacent: false },
      ];
      for (const pass of passes) {
        for (let i = 0; i < pass.scope && chosen < 0; i++) {
          if (usedByRule.has(i)) continue;
          const [a, b] = order[i];
          if (pass.distance && cheb(a, b) < SPECIAL_MIN_CHEBYSHEV) continue;
          if (pass.nonAdjacent && keyTiles.some((t) => cheb(t, a) <= 1 || cheb(t, b) <= 1)) continue;
          chosen = i;
        }
        if (chosen >= 0) break;
      }
      if (chosen < 0) chosen = order.findIndex((_, i) => !usedByRule.has(i));
      if (chosen < 0) break;
      usedByRule.add(chosen);
      lastKeyIndex = Math.max(lastKeyIndex, chosen);
      const [a, b] = order[chosen];
      cells[a] = KEY_BASE + k;
      cells[b] = KEY_BASE + k;
      keyTiles.push(a, b);
    }
    const numberCount = Math.max(0, Math.min(numbers, order.length - usedByRule.size));
    if (numberCount > 0) {
      const first = lastKeyIndex + 1;
      const span = Math.max(1, order.length - first);
      let prev = first - 1;
      for (let n = 1; n <= numberCount; n++) {
        // R 안에서 균등 간격 + 같은 숫자 두 타일이 붙지 않는 쌍을 그 근처에서 고른다.
        const target = first + Math.floor(((n - 0.5) * span) / numberCount);
        let at = -1;
        for (let pass = 0; pass < 2 && at < 0; pass++) {
          for (let step = 0; step < order.length; step++) {
            for (const i of [target + step, target - step]) {
              if (i <= prev || i >= order.length || usedByRule.has(i)) continue;
              if (pass === 0 && cheb(order[i][0], order[i][1]) < SPECIAL_MIN_CHEBYSHEV) continue;
              at = i;
              break;
            }
            if (at >= 0) break;
          }
        }
        if (at < 0) continue;
        usedByRule.add(at);
        prev = at;
        const [a, b] = order[at];
        cells[a] = NUMBER_BASE + n;
        cells[b] = NUMBER_BASE + n;
      }
    }

    // 나머지 쌍 = 일반 심볼. 심볼 종류 수는 난이도가 정한다(적을수록 같은 그림이 많아 쉬움).
    const normalPairs: number[] = [];
    for (let i = 0; i < order.length; i++) if (!usedByRule.has(i)) normalPairs.push(i);
    const tiles = normalPairs.length * 2;
    const symbolCount = Math.max(
      6,
      Math.min(SYMBOL_COUNT, Math.round((tiles / 4) * tuning.symbolVariety))
    );
    const shuffledPairs = shuffleInPlace(normalPairs.slice(), rng);
    assignSymbols(cells, order, shuffledPairs, cols, rows, symbolCount, tuning.minimizeAdjacency, rng);


    // 자물쇠: 열쇠보다 뒤에 있는 일반 쌍 중 25%. 색은 "같은 색끼리 4방향으로 붙지 않게" 골라 준다.
    const locks: [number, number][] = [];
    if (keyPairs > 0 && shuffledPairs.length > 0) {
      const lockable = shuffledPairs.filter((i) => i > lastKeyIndex);
      const lockCount = Math.floor(shuffledPairs.length * LOCK_RATIO);
      const byColor = new Map<number, Set<number>>();
      for (let k = 1; k <= keyPairs; k++) byColor.set(k, new Set());
      const conflictsWith = (idx: number, color: number) =>
        neighborsOf(idx, cols, rows).filter((nb) => byColor.get(color)!.has(nb)).length;
      // 같은 색 자물쇠끼리 4방향으로 붙지 않게 고른다. 불가피한 경우는 판당 1쌍까지만 허용(§X2.2).
      let adjacentAllowance = 1;
      let placed = 0;
      for (let k = 0; k < lockable.length && placed < lockCount; k++) {
        const [a, b] = order[lockable[k]];
        // 쌍의 두 타일이 서로 붙어 있으면 그 자체로 "같은 색 자물쇠 인접"이 된다
        const selfAdjacent = neighborsOf(a, cols, rows).includes(b) ? 1 : 0;
        let color = ((placed % keyPairs) + 1) as number;
        let conflicts = Infinity;
        for (let t = 0; t < keyPairs; t++) {
          const c = ((placed + t) % keyPairs) + 1;
          const n = conflictsWith(a, c) + conflictsWith(b, c) + selfAdjacent;
          if (n < conflicts) {
            conflicts = n;
            color = c;
            if (n === 0) break;
          }
        }
        if (conflicts > adjacentAllowance) continue; // 이 쌍은 건너뛰고 다른 쌍을 잠근다
        adjacentAllowance -= conflicts;
        byColor.get(color)!.add(a).add(b);
        locks.push([a, color], [b, color]);
        placed++;
      }
    }
    const lockedSet = new Set(locks.map(([idx]) => idx));

    // 물음표: 자물쇠가 아닌 일반 타일의 20%. 서로 붙은 `?` 가 전체의 25%를 넘지 않게 고른다.
    const hidden: number[] = [];
    if (mystery) {
      const candidates: number[] = [];
      for (let i = 0; i < cells.length; i++) {
        if (isNormalSymbol(cells[i]) && !lockedSet.has(i)) candidates.push(i);
      }
      shuffleInPlace(candidates, rng);
      const hideCount = Math.floor(candidates.length * MYSTERY_RATIO);
      const chosen = new Set<number>();
      const maxTouching = Math.floor(hideCount * MYSTERY_ADJACENT_RATIO);
      let touching = 0;
      for (const idx of candidates) {
        if (chosen.size >= hideCount) break;
        const near = neighborsOf(idx, cols, rows).filter((nb) => chosen.has(nb)).length;
        if (near > 0 && touching + near > maxTouching) continue;
        touching += near;
        chosen.add(idx);
      }
      // 제약 때문에 모자라면 남은 후보로 채운다(개수 우선)
      for (const idx of candidates) {
        if (chosen.size >= hideCount) break;
        chosen.add(idx);
      }
      hidden.push(...chosen);
      hidden.sort((a, b) => a - b);
    }

    locks.sort((x, y) => x[0] - y[0]);
    const board: GeneratedBoard = { cells, hidden, locks, order };

    // d≥4는 "붙어 있는 같은 그림"을 상한 이하로. 못 맞추면 몇 번 다시 만들어 그중 제일 좋은 판을 쓴다
    // (판 구조상 어쩔 수 없이 붙는 쌍이 남는다 — 상한 0은 불가능).
    if (!tuning.minimizeAdjacency) return board;
    const adjacency = countAdjacentEqualPairs(cells, cols, rows);
    if (adjacency <= MAX_ADJACENT_PAIRS_HARD) return board;
    hardTries++;
    if (adjacency < bestAdjacency) {
      bestAdjacency = adjacency;
      best = board;
    }
    if (hardTries >= tuning.hardRetries || Date.now() - startedAt > HARD_TIME_BUDGET_MS) return best!;
  }
  if (best) return best;
  throw new Error(`generateBoardV2 failed for ${cols}x${rows} after 50 attempts`);
}

/**
 * 일반 쌍에 심볼을 배정한다. 심볼 하나당 2쌍(=4타일)씩 symbolCount 종류를 순환.
 * minimizeAdjacency면 "붙어 있는 같은 심볼"이 최소가 되도록 탐욕 배정한다(어려운 난이도).
 */
function assignSymbols(
  cells: number[],
  order: [number, number][],
  pairIdx: number[],
  cols: number,
  rows: number,
  symbolCount: number,
  minimizeAdjacency: boolean,
  rng: () => number
): void {
  const quota = new Map<number, number>();
  for (let k = 0; k < pairIdx.length; k++) {
    const symbol = 1 + (Math.floor(k / 2) % symbolCount);
    quota.set(symbol, (quota.get(symbol) ?? 0) + 1);
  }
  if (!minimizeAdjacency) {
    for (let k = 0; k < pairIdx.length; k++) {
      const symbol = 1 + (Math.floor(k / 2) % symbolCount);
      const [a, b] = order[pairIdx[k]];
      cells[a] = symbol;
      cells[b] = symbol;
    }
    return;
  }
  const neighborsAt = (idx: number) => neighborsOf(idx, cols, rows);
  for (const pi of pairIdx) {
    const [a, b] = order[pi];
    const around = [...neighborsAt(a), ...neighborsAt(b)];
    let best: number[] = [];
    let bestCost = Infinity;
    for (const [symbol, left] of quota) {
      if (left <= 0) continue;
      let cost = 0;
      for (const nb of around) if (nb !== a && nb !== b && cells[nb] === symbol) cost++;
      if (cost < bestCost) {
        bestCost = cost;
        best = [symbol];
      } else if (cost === bestCost) {
        best.push(symbol);
      }
      if (bestCost === 0 && best.length > 6) break; // 충분히 많이 모였으면 그만
    }
    const symbol = best[Math.floor(rng() * best.length)];
    quota.set(symbol, (quota.get(symbol) ?? 1) - 1);
    if ((quota.get(symbol) ?? 0) <= 0) quota.delete(symbol);
    cells[a] = symbol;
    cells[b] = symbol;
  }
}
