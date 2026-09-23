// 테트리스 순수 엔진 (docs/games/tetris-design.md §T4). 외부 의존 없음 — types.ts + srs.ts 만 import.
//
// 권위 모델(§T1): **클라가 60fps 로 전부 시뮬**하고 서버는 시드/쓰레기줄/등수만 중재한다.
// 그래서 이 파일은 DOM·소켓·스토어를 전혀 모르고, 같은 seed + 같은 입력이면 항상 같은 결과를 낸다.
//
// 좌표계: x = 열(오른쪽 +), y = 행(**아래쪽 +**). 필드는 FIELD_ROWS(22) x COLS(10) 1차원 배열이고
// 위 HIDDEN_ROWS(2) 행은 스폰 버퍼라 렌더하지 않는다. y < 0 은 "천장 위"로, 충돌로 취급한다
// (숨은 행이 2줄뿐이라 그 위 상태를 담을 칸이 없다. 킥이 위로 2칸 뜨는 경우만 드물게 거절된다).
//
// 성능 주의: tick/toCells 가 매 프레임 돈다. 이 파일 안에서는 핫패스에 새 배열을 만들지 않는다
// (셀 좌표는 SHAPES 를 그대로 읽고, toCells 는 호출자가 준 버퍼를 재사용한다).

import {
  B2B_KINDS,
  CELL_ACTIVE_BASE,
  CELL_EMPTY,
  CELL_GARBAGE,
  CELL_GHOST,
  COLS,
  FIELD_ROWS,
  HIDDEN_ROWS,
  ROWS,
  SCORE_BASE,
} from './types';
import type { ClearKind, PieceId, TetrisOptions } from './types';
import { SHAPES, T_CORNERS, T_FRONT, kicksFor, rotateBy } from './srs';
import type { Cell, Rot, RotDir } from './srs';

// --- 상수 -----------------------------------------------------------------

/** 레벨 1..10 의 중력(ms/칸). 인덱스 = level - 1. 11레벨 이상은 마지막 값(64ms) 유지 */
export const GRAVITY_MS = [1000, 793, 618, 473, 355, 262, 190, 135, 94, 64];
/** 접지 후 굳을 때까지의 유예 */
export const LOCK_DELAY_MS = 500;
/** 이동/회전으로 락 딜레이를 되돌릴 수 있는 최대 횟수(무한 버티기 방지) */
export const MAX_LOCK_RESETS = 15;
/** next 큐가 항상 유지하는 최소 길이. 설정(nextCount)이 작아도 내부적으로는 5개 이상 채워 둔다 */
export const NEXT_MIN = 5;
/** 스폰 원점 x. 3x3 조각은 3·4·5열, I 는 3~6열을 차지한다(가이드라인) */
export const SPAWN_X = 3;
/** T 조각 id (PIECE_NAMES 기준) */
export const PIECE_T: PieceId = 6;

const VISIBLE_CELLS = COLS * ROWS;
const FIELD_CELLS = COLS * FIELD_ROWS;
const ALL_PIECES: PieceId[] = [1, 2, 3, 4, 5, 6, 7];

export function gravityMs(level: number): number {
  const i = Math.max(1, Math.floor(level)) - 1;
  return GRAVITY_MS[Math.min(i, GRAVITY_MS.length - 1)];
}

// --- 타입 -----------------------------------------------------------------

export interface ActivePiece { id: PieceId; rot: Rot; x: number; y: number }
export interface GarbageItem { amount: number; holes: number[] }
/** 스핀 판정 결과. 'none' = 평범한 락, 'mini' = 미니 T-스핀, 'full' = 정식 T-스핀 */
export type SpinKind = 'none' | 'mini' | 'full';

export interface TetrisState {
  /** 이 판의 규칙. createState 가 받은 것을 그대로 들고 있는다(레벨/홀드/그림자 판단에 쓴다) */
  opts: TetrisOptions;
  seed: number;
  field: Uint8Array;        // FIELD_ROWS * COLS, 값 = 0 | 1..7 | 8(garbage)
  piece: ActivePiece | null;
  hold: PieceId | 0; holdUsed: boolean;
  bag: PieceId[]; bagIndex: number; rng: () => number;
  next: PieceId[];
  lines: number; score: number; level: number; combo: number; b2b: number;
  pending: GarbageItem[];   // 다음(줄을 못 지운) 락에서 올라올 쓰레기
  alive: boolean; ko: number;
  lockTimer: number; lockResets: number;
  gravityAcc: number;
  // --- 내부 판정용(렌더러가 읽어도 되지만 서버로는 보내지 않는다) ---
  /** 마지막 성공 동작이 회전이었나. T-스핀의 전제 조건 */
  lastWasRotate: boolean;
  /** 방금 회전에 쓰인 킥 인덱스(디버그/연출용) */
  lastKick: number;
  /** 방금 회전이 90도 킥 표의 **5번째 오프셋**으로 들어갔나. 그러면 T-스핀은 무조건 정식 */
  lastKickFinal: boolean;
  /** 이번 조각이 도달한 가장 아래 y. 더 내려가면 락 리셋 횟수를 되돌려 준다 */
  lowestY: number;
  /** 굳힌 조각 수(통계/디버그) */
  placed: number;
}

export interface LockResult {
  cleared: number;
  kind: ClearKind | null;
  perfect: boolean;
  toppedOut: boolean;
  /** 지워진 줄의 **보이는 행 인덱스**(0..19). 음수면 숨은 행이라 렌더 대상이 아니다 */
  rows: number[];
  // --- 설계서에 없지만 UI/소켓이 바로 쓰도록 덧붙인 값들 ---
  spin: SpinKind;
  /** 이번 클리어가 B2B 를 이어받았는가(= tetris:clear 의 b2b 필드) */
  b2b: boolean;
  /** 이번 클리어 직후의 콤보 값(= tetris:clear 의 combo 필드) */
  combo: number;
  /** 이번 락으로 올라간 점수 */
  score: number;
  /** 이번 락으로 레벨이 올랐는가(레벨업 연출용) */
  levelUp: boolean;
}

export interface TickResult {
  /** 중력으로 내려간 칸 수 */
  dropped: number;
  /** 락 딜레이가 다 돼서 굳었으면 그 결과 */
  locked: LockResult | null;
}

// --- 결정적 PRNG ----------------------------------------------------------

/** 결정적 PRNG. 같은 seed면 항상 같은 수열 (사천성 엔진과 동일 구현 — 서버와 조각 순서를 맞추는 근거) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 7-bag ----------------------------------------------------------------

/** 7종을 한 번씩 담은 가방을 Fisher-Yates 로 섞는다. 연속 7개 안에 모든 조각이 정확히 한 번 나온다. */
function newBag(rng: () => number): PieceId[] {
  const bag = ALL_PIECES.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = bag[i];
    bag[i] = bag[j];
    bag[j] = tmp;
  }
  return bag;
}

/** 가방에서 한 조각 꺼낸다. 다 쓰면 새 가방을 만든다. */
function pullFromBag(s: TetrisState): PieceId {
  if (s.bagIndex >= s.bag.length) {
    s.bag = newBag(s.rng);
    s.bagIndex = 0;
  }
  return s.bag[s.bagIndex++];
}

/** next 큐를 NEXT_MIN(과 설정값) 이상으로 채운다 */
function fillNext(s: TetrisState): void {
  const want = Math.max(NEXT_MIN, s.opts.nextCount | 0);
  while (s.next.length < want) s.next.push(pullFromBag(s));
}

// --- 충돌 / 배치 ----------------------------------------------------------

/** (x, y)가 필드 밖이거나 이미 채워져 있으면 true. y < 0(천장 위)도 막힌 것으로 본다 */
function blocked(field: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || x >= COLS || y < 0 || y >= FIELD_ROWS) return true;
  return field[y * COLS + x] !== CELL_EMPTY;
}

/** 조각을 (x, y)/rot 로 놓을 수 있는가 */
export function canPlace(field: Uint8Array, id: PieceId, rot: Rot, x: number, y: number): boolean {
  const cells = SHAPES[id][rot];
  for (let i = 0; i < cells.length; i++) {
    if (blocked(field, x + cells[i][0], y + cells[i][1])) return false;
  }
  return true;
}

/** 현재 조각이 한 칸 더 내려갈 수 있는가(= 접지 판정의 반대) */
export function canMoveDown(s: TetrisState): boolean {
  const p = s.piece;
  if (!p) return false;
  return canPlace(s.field, p.id, p.rot, p.x, p.y + 1);
}

// --- 생성 -----------------------------------------------------------------

export function createState(seed: number, opts: TetrisOptions): TetrisState {
  const rng = mulberry32(seed);
  const s: TetrisState = {
    opts,
    seed,
    field: new Uint8Array(FIELD_CELLS),
    piece: null,
    hold: 0,
    holdUsed: false,
    bag: newBag(rng),
    bagIndex: 0,
    rng,
    next: [],
    lines: 0,
    score: 0,
    level: Math.max(1, opts.startLevel | 0),
    combo: 0,
    b2b: 0,
    pending: [],
    alive: true,
    ko: 0,
    lockTimer: 0,
    lockResets: 0,
    gravityAcc: 0,
    lastWasRotate: false,
    lastKick: -1,
    lastKickFinal: false,
    lowestY: 0,
    placed: 0,
  };
  fillNext(s);
  return s;
}

// --- 스폰 / 홀드 ----------------------------------------------------------

/**
 * 조각을 스폰 위치에 놓는다. 겹치면 탑아웃(alive = false).
 * 가이드라인대로 막히지 않았으면 곧바로 한 칸 내려 보이는 영역에 걸치게 한다.
 */
function placeAtSpawn(s: TetrisState, id: PieceId): boolean {
  s.lockTimer = 0;
  s.lockResets = 0;
  s.gravityAcc = 0;
  s.lastWasRotate = false;
  s.lastKick = -1;
  s.lastKickFinal = false;
  if (!canPlace(s.field, id, 0, SPAWN_X, 0)) {
    s.piece = null;
    s.alive = false;
    return false;
  }
  const y = canPlace(s.field, id, 0, SPAWN_X, 1) ? 1 : 0;
  s.piece = { id, rot: 0, x: SPAWN_X, y };
  s.lowestY = y;
  return true;
}

/** next 큐에서 다음 조각을 꺼내 스폰한다. false = 탑아웃 */
export function spawn(s: TetrisState): boolean {
  fillNext(s);
  const id = s.next.shift() as PieceId;
  fillNext(s);
  const ok = placeAtSpawn(s, id);
  s.holdUsed = false;   // 새 조각 = 홀드 권리 부활
  return ok;
}

/**
 * 홀드. 비어 있으면 현재 조각을 넣고 next 에서 당겨오고, 차 있으면 맞바꾼다.
 * 같은 조각으로 두 번은 못 한다(holdUsed). 바꾼 조각이 스폰 위치에서 겹치면 탑아웃이라 false.
 */
export function holdPiece(s: TetrisState): boolean {
  if (!s.opts.hold || !s.alive || !s.piece || s.holdUsed) return false;
  const cur = s.piece.id;
  if (s.hold === 0) {
    s.hold = cur;
    const ok = spawn(s);
    s.holdUsed = true;
    return ok;
  }
  const swap = s.hold;
  s.hold = cur;
  const ok = placeAtSpawn(s, swap);
  s.holdUsed = true;
  return ok;
}

// --- 이동 / 회전 ----------------------------------------------------------

/**
 * 이동·회전 성공 직후의 락 딜레이 갱신.
 * 더 아래로 내려갔으면(새 최저점) 리셋 횟수를 통째로 돌려주고,
 * 접지 상태에서의 조작이면 MAX_LOCK_RESETS 까지만 타이머를 되돌린다.
 */
function afterMove(s: TetrisState): void {
  const p = s.piece!;
  if (p.y > s.lowestY) {
    s.lowestY = p.y;
    s.lockResets = 0;
    s.lockTimer = 0;
    return;
  }
  if (!canMoveDown(s) && s.lockResets < MAX_LOCK_RESETS) {
    s.lockResets++;
    s.lockTimer = 0;
  }
}

export function tryMove(s: TetrisState, dx: number, dy: number): boolean {
  const p = s.piece;
  if (!s.alive || !p) return false;
  if (!canPlace(s.field, p.id, p.rot, p.x + dx, p.y + dy)) return false;
  p.x += dx;
  p.y += dy;
  s.lastWasRotate = false;   // 마지막 동작이 이동 → T-스핀 아님
  afterMove(s);
  return true;
}

/** SRS 킥 테이블을 순서대로 시도한다. dir 2 = 180도 회전(SRS+ 표) */
export function tryRotate(s: TetrisState, dir: RotDir): boolean {
  const p = s.piece;
  if (!s.alive || !p) return false;
  const to = rotateBy(p.rot, dir);
  if (to === p.rot) return false;
  const kicks: Cell[] = kicksFor(p.id, p.rot, to);
  for (let i = 0; i < kicks.length; i++) {
    const nx = p.x + kicks[i][0];
    const ny = p.y + kicks[i][1];
    if (!canPlace(s.field, p.id, to, nx, ny)) continue;
    p.rot = to;
    p.x = nx;
    p.y = ny;
    s.lastWasRotate = true;
    s.lastKick = i;
    // "5번째 오프셋 = 무조건 정식"은 가이드라인 90도 표(5개)에서만 성립한다. 180도 표(6개)는 제외.
    s.lastKickFinal = i === 4 && kicks.length === 5;
    afterMove(s);
    return true;
  }
  return false;
}

/** 현재 조각이 그대로 떨어졌을 때의 y (그림자 위치) */
export function ghostY(s: TetrisState): number {
  const p = s.piece;
  if (!p) return 0;
  let y = p.y;
  while (canPlace(s.field, p.id, p.rot, p.x, y + 1)) y++;
  return y;
}

/** 소프트 드롭 한 칸. 성공하면 1점(가이드라인) */
export function softDropStep(s: TetrisState): boolean {
  if (!tryMove(s, 0, 1)) return false;
  s.score += 1;
  s.gravityAcc = 0;   // 수동으로 내렸으니 중력 누적은 초기화
  return true;
}

/** 하드 드롭 — 바닥까지 떨어뜨리고 즉시 굳힌다. 떨어진 칸당 2점 */
export function hardDrop(s: TetrisState): LockResult {
  const p = s.piece;
  if (!s.alive || !p) return emptyLock(!s.alive);   // 조각이 없을 뿐이면 탑아웃은 아니다
  const to = ghostY(s);
  const dist = to - p.y;
  if (dist > 0) {
    p.y = to;
    s.score += dist * 2;
    s.lastWasRotate = false;   // 실제로 떨어졌다면 마지막 동작은 이동 → T-스핀 취소
    if (p.y > s.lowestY) s.lowestY = p.y;
  }
  return lockPiece(s);
}

function emptyLock(toppedOut: boolean): LockResult {
  return { cleared: 0, kind: null, perfect: false, toppedOut, rows: [], spin: 'none', b2b: false, combo: 0, score: 0, levelUp: false };
}

// --- T-스핀 판정 ----------------------------------------------------------

/**
 * 설계서 §T4: 마지막 동작이 회전이고, T 중심의 네 대각 중 3개 이상이 막혔으면 스핀.
 * 앞쪽(코 방향) 두 대각이 모두 막혔으면 정식, 하나만이면 미니.
 * 단 킥 테이블 5번째(index 4) 오프셋으로 들어갔으면 무조건 정식.
 * 필드 밖은 전부 "막힌 것"으로 센다(벽·바닥에 붙은 스핀을 인정하기 위해).
 */
function detectSpin(s: TetrisState): SpinKind {
  const p = s.piece!;
  if (p.id !== PIECE_T || !s.lastWasRotate) return 'none';
  const f = s.field;
  const corner = (c: Cell) => blocked(f, p.x + c[0], p.y + c[1]);
  const [fa, fb] = T_FRONT[p.rot];
  const frontA = corner(fa);
  const frontB = corner(fb);
  let n = 0;
  if (corner(T_CORNERS.tl)) n++;
  if (corner(T_CORNERS.tr)) n++;
  if (corner(T_CORNERS.bl)) n++;
  if (corner(T_CORNERS.br)) n++;
  if (n < 3) return 'none';
  if (s.lastKickFinal) return 'full';
  return frontA && frontB ? 'full' : 'mini';
}

/** 지운 줄 수 + 스핀 종류 → 공격량 표의 키 */
function classify(cleared: number, spin: SpinKind): ClearKind | null {
  if (cleared <= 0) return null;
  if (spin === 'full') {
    if (cleared === 1) return 'tss';
    if (cleared === 2) return 'tsd';
    if (cleared === 3) return 'tst';
    return 'tetris';                       // T로 4줄은 불가능하지만 방어적으로
  }
  if (spin === 'mini') {
    // 미니는 싱글만 'tsm'. 2줄 이상 지운 미니는 실질적으로 정식과 같은 값을 준다.
    if (cleared === 1) return 'tsm';
    if (cleared === 2) return 'tsd';
    return 'tst';
  }
  if (cleared === 1) return 'single';
  if (cleared === 2) return 'double';
  if (cleared === 3) return 'triple';
  return 'tetris';
}

// --- 락 -------------------------------------------------------------------

/** 가득 찬 줄을 지우고 위를 끌어내린다. 반환 = 지워진 필드 행 번호(위에서부터) */
function clearLines(field: Uint8Array): number[] {
  const rows: number[] = [];
  for (let y = 0; y < FIELD_ROWS; y++) {
    let full = true;
    const base = y * COLS;
    for (let x = 0; x < COLS; x++) {
      if (field[base + x] === CELL_EMPTY) { full = false; break; }
    }
    if (full) rows.push(y);
  }
  if (rows.length === 0) return rows;
  // 아래에서 위로 훑으며 살아남은 줄만 아래쪽부터 다시 쌓는다(한 번의 패스로 끝낸다)
  let write = FIELD_ROWS - 1;
  for (let y = FIELD_ROWS - 1; y >= 0; y--) {
    if (rows.indexOf(y) >= 0) continue;
    if (write !== y) field.copyWithin(write * COLS, y * COLS, y * COLS + COLS);
    write--;
  }
  for (let y = write; y >= 0; y--) field.fill(CELL_EMPTY, y * COLS, y * COLS + COLS);
  return rows;
}

function fieldIsEmpty(field: Uint8Array): boolean {
  for (let i = 0; i < FIELD_CELLS; i++) if (field[i] !== CELL_EMPTY) return false;
  return true;
}

/**
 * 현재 조각을 필드에 굳히고, 줄 정리 → 쓰레기 투입 → 다음 조각 스폰까지 한 번에 처리한다.
 * 줄을 **못 지운** 락에서만 pending 쓰레기가 올라온다(설계서 §T4).
 */
function lockPiece(s: TetrisState): LockResult {
  const p = s.piece;
  if (!p) return emptyLock(!s.alive);
  const spin = detectSpin(s);              // 필드에 굳히기 전에 봐야 자기 자신이 대각에 안 센다

  const cells = SHAPES[p.id][p.rot];
  for (let i = 0; i < cells.length; i++) {
    const x = p.x + cells[i][0];
    const y = p.y + cells[i][1];
    if (y >= 0 && y < FIELD_ROWS && x >= 0 && x < COLS) s.field[y * COLS + x] = p.id;
  }
  s.piece = null;
  s.placed++;

  const fieldRows = clearLines(s.field);
  const cleared = fieldRows.length;
  const kind = classify(cleared, spin);
  const perfect = cleared > 0 && fieldIsEmpty(s.field);

  // --- 콤보 / B2B ---
  let b2bChain = false;
  if (cleared > 0) {
    s.combo++;
    const difficult = kind !== null && B2B_KINDS.indexOf(kind) >= 0;
    if (difficult) {
      b2bChain = s.b2b > 0;                // 직전에도 어려운 클리어였으면 보너스 대상
      s.b2b++;
    } else {
      s.b2b = 0;                           // 평범한 1~3줄은 체인을 끊는다
    }
  } else {
    s.combo = 0;                           // 줄을 못 지우면 콤보만 끊긴다(B2B 는 유지)
  }

  // --- 점수 / 레벨 ---
  let gained = 0;
  if (kind) {
    gained += SCORE_BASE[kind] * s.level;
    if (b2bChain) gained += Math.floor(SCORE_BASE[kind] * s.level * 0.5);
    if (s.combo > 1) gained += 50 * (s.combo - 1) * s.level;
    if (perfect) gained += 1000 * s.level;
  } else if (spin !== 'none') {
    gained += (spin === 'full' ? 400 : 100) * s.level;   // 줄 없는 T-스핀도 점수는 준다
  }
  s.score += gained;
  s.lines += cleared;
  let levelUp = false;
  if (s.opts.levelUpLines > 0) {
    const want = Math.max(1, s.opts.startLevel | 0) + Math.floor(s.lines / s.opts.levelUpLines);
    if (want > s.level) { s.level = want; levelUp = true; }
  }

  // --- 쓰레기: 줄을 못 지웠을 때만 밀려 올라온다 ---
  if (cleared === 0) flushPending(s);

  const spawned = s.alive ? spawn(s) : false;
  const rows: number[] = [];
  for (let i = 0; i < fieldRows.length; i++) rows.push(fieldRows[i] - HIDDEN_ROWS);
  return {
    cleared,
    kind,
    perfect,
    toppedOut: !spawned,
    rows,
    spin,
    b2b: b2bChain,
    combo: s.combo,
    score: gained,
    levelUp,
  };
}

// --- 중력 틱 --------------------------------------------------------------

/**
 * dtMs 만큼 시간을 흘린다. 중력으로 내려가고, 접지 상태면 락 딜레이를 깎는다.
 * 60fps 루프에서 매 프레임 불리므로 새 객체는 결과 하나만 만든다.
 */
export function tick(s: TetrisState, dtMs: number): TickResult {
  const res: TickResult = { dropped: 0, locked: null };
  if (!s.alive || !s.piece || dtMs <= 0) return res;
  const g = gravityMs(s.level);
  s.gravityAcc += dtMs;
  while (s.gravityAcc >= g) {
    s.gravityAcc -= g;
    if (tryMove(s, 0, 1)) res.dropped++;
    else { s.gravityAcc = 0; break; }      // 바닥이면 더 누적해 봐야 의미 없다
  }
  if (canMoveDown(s)) {
    s.lockTimer = 0;
  } else {
    s.lockTimer += dtMs;
    if (s.lockTimer >= LOCK_DELAY_MS) res.locked = lockPiece(s);
  }
  return res;
}

// --- 쓰레기 줄 ------------------------------------------------------------

/** 서버가 보낸 쓰레기를 대기열에 넣는다. 실제 삽입은 다음 "줄 못 지운 락"에서 */
export function queueGarbage(s: TetrisState, amount: number, holes: number[]): void {
  if (amount <= 0) return;
  s.pending.push({ amount, holes: holes.slice() });
}

/** 아직 안 올라온 쓰레기 줄 총합 (TetrisFrame.pending 용) */
export function pendingCount(s: TetrisState): number {
  let n = 0;
  for (let i = 0; i < s.pending.length; i++) n += s.pending[i].amount;
  return n;
}

function flushPending(s: TetrisState): void {
  while (s.pending.length > 0) {
    const g = s.pending.shift()!;
    applyGarbage(s, g.amount, g.holes);
    if (!s.alive) break;
  }
}

/**
 * 쓰레기 줄을 바닥에서 amount 만큼 즉시 밀어 올린다(서바이벌 rise 도 이 함수를 쓴다).
 * holes 가 amount 개면 줄마다 하나씩, 모자라면 4줄 단위로 같은 열을 쓴다(설계서 §T3.1).
 * 위로 밀려 나가는 칸에 블록이 남아 있으면 탑아웃.
 */
export function applyGarbage(s: TetrisState, amount: number, holes: number[]): void {
  if (amount <= 0) return;
  const f = s.field;
  const n = Math.min(amount, FIELD_ROWS);

  // 밖으로 밀려 나갈 위쪽 n 행에 블록이 남아 있으면 더 쌓을 자리가 없다 = 탑아웃
  for (let y = 0; y < n; y++) {
    const base = y * COLS;
    for (let x = 0; x < COLS; x++) {
      if (f[base + x] !== CELL_EMPTY) { s.alive = false; break; }
    }
    if (!s.alive) break;
  }

  f.copyWithin(0, n * COLS, FIELD_CELLS);
  for (let i = 0; i < n; i++) {
    const y = FIELD_ROWS - n + i;
    const base = y * COLS;
    const hole = holeFor(holes, amount, i);
    for (let x = 0; x < COLS; x++) f[base + x] = x === hole ? CELL_EMPTY : CELL_GARBAGE;
  }

  // 떨어지던 조각도 같이 위로 민다. 그만큼 못 올라가면 가능한 한 높은 자리로 물러선다.
  const p = s.piece;
  if (p) {
    let ok = false;
    for (let y = Math.max(0, p.y - n); y <= p.y; y++) {
      if (canPlace(f, p.id, p.rot, p.x, y)) { p.y = y; ok = true; break; }
    }
    if (!ok) s.alive = false;
    else if (p.y > s.lowestY) s.lowestY = p.y;
  }
}

/** i 번째 쓰레기 줄의 구멍 열. 한 묶음은 같은 열, 4줄을 넘으면 4줄마다 바뀐다 */
function holeFor(holes: number[], amount: number, i: number): number {
  if (holes.length === 0) return 0;
  if (holes.length >= amount) return holes[i] % COLS;
  return holes[Math.min(i >> 2, holes.length - 1)] % COLS;
}

// --- 렌더용 셀 ------------------------------------------------------------

/**
 * 보이는 20행(길이 200)을 굳은 블록 → 그림자 → 현재 조각 순서로 겹쳐서 만든다.
 * out 을 주면 그 배열을 재사용한다(60fps 렌더에서 매 프레임 200칸 배열을 새로 만들지 않기 위함).
 */
export function toCells(s: TetrisState, opts?: { ghost?: boolean } | null, out?: number[]): number[] {
  const cells = out && out.length === VISIBLE_CELLS ? out : new Array<number>(VISIBLE_CELLS);
  const offset = HIDDEN_ROWS * COLS;
  for (let i = 0; i < VISIBLE_CELLS; i++) cells[i] = s.field[offset + i];

  const p = s.piece;
  if (!p) return cells;
  const shape = SHAPES[p.id][p.rot];
  const showGhost = opts ? opts.ghost !== false : s.opts.ghost;
  if (showGhost) {
    const gy = ghostY(s);
    for (let i = 0; i < shape.length; i++) {
      const x = p.x + shape[i][0];
      const y = gy + shape[i][1] - HIDDEN_ROWS;
      if (y >= 0 && y < ROWS && x >= 0 && x < COLS) cells[y * COLS + x] = CELL_GHOST;
    }
  }
  for (let i = 0; i < shape.length; i++) {
    const x = p.x + shape[i][0];
    const y = p.y + shape[i][1] - HIDDEN_ROWS;
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) cells[y * COLS + x] = CELL_ACTIVE_BASE + p.id;
  }
  return cells;
}
