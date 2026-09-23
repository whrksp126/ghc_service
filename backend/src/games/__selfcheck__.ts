// 사천성 엔진/매니저 셀프체크 (v1 §1 + v2 §V3/§V6). 실행: npx tsx src/games/__selfcheck__.ts
// DB·소켓 의존 없음. 모든 검사가 PASS여야 하고, 하나라도 FAIL이면 exit code 1.

import {
  PickView,
  Shape,
  buildMask,
  canPick,
  NO_HIDDEN,
  countAdjacentEqualPairs,
  countRemaining,
  findAllMoves,
  findAnyMove,
  findPath,
  generateBoardV2,
  maskForClient,
  mulberry32,
  previewMask,
  shuffleNormals,
} from './shisen/engine';
import {
  BOARD_DIMS,
  BoardSize,
  Difficulty,
  GameOptions,
  GameSnapshot,
  KEY_BASE,
  KEY_TYPES_PER_SIZE,
  LOCK_BASE,
  MYSTERY,
  NUMBER_BASE,
  Point,
  SpecialToggles,
  WALL,
  isKey,
  isLock,
  isNormalSymbol,
} from './types';
import { __setLobbyReturnDelayMs, gameManager } from './gameManager';
import {
  B2B_BONUS,
  COLS,
  COMBO_TABLE,
  DEFAULT_TETRIS_OPTIONS,
  PERFECT_CLEAR_BONUS,
  TetrisClearMsg,
  TetrisFrame,
  TetrisOptions,
} from './tetris/types';
import {
  TetrisRuntime,
  beginTetris,
  computeGarbage,
  createTetris,
  makeHoles,
  onClear,
  onFinish,
  onFrame,
  onTopout,
  pickTarget,
  sortForResults,
  stopTetris,
} from './tetris/manager';

let failures = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function check(name: string, fn: () => string | void): void {
  try {
    const note = fn();
    console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
  } catch (err: any) {
    failures++;
    console.log(`FAIL  ${name}: ${err?.message || err}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const note = await fn();
    console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`);
  } catch (err: any) {
    failures++;
    console.log(`FAIL  ${name}: ${err?.message || err}`);
  }
}

const SHAPES: Shape[] = ['rect', 'diamond', 'frame', 'towers', 'pyramid', 'cross', 'blob'];
const SIZES: BoardSize[] = ['s', 'm', 'l'];
const NUMBERS_PER_SIZE: Record<BoardSize, number> = { s: 3, m: 4, l: 5 };

const SPECIAL_SETS: { name: string; specials: SpecialToggles }[] = [
  { name: 'all-off', specials: { mystery: false, numbers: false, keys: false, walls: false } },
  { name: 'all-on', specials: { mystery: true, numbers: true, keys: true, walls: true } },
  { name: 'walls-only', specials: { mystery: false, numbers: false, keys: false, walls: true } },
  { name: 'keys+numbers', specials: { mystery: false, numbers: true, keys: true, walls: false } },
];

// --- 판 하나를 만들고 규칙대로 굴려 보는 시뮬레이터 -------------------------

interface SimBoard {
  cols: number;
  rows: number;
  cells: number[];
  hidden: Set<number>;
  locks: Map<number, number>;
  nextNumber: number;
  maxNumber: number;
  keysLeft: number;
}

function makeBoard(
  size: BoardSize,
  shape: Shape,
  specials: SpecialToggles,
  seed: number,
  difficulty: Difficulty = 3
) {
  const { cols, rows } = BOARD_DIMS[size];
  const rng = mulberry32(seed);
  const keyTypes = specials.keys ? KEY_TYPES_PER_SIZE[size] : 0;
  const mask = buildMask(shape, cols, rows, rng, ((keyTypes * 2) % 4) as 0 | 2);
  const numbers = specials.numbers ? NUMBERS_PER_SIZE[size] : 0;
  const gen = generateBoardV2(
    { cols, rows, mask, walls: specials.walls, numbers, keyTypes, mystery: specials.mystery, difficulty },
    rng
  );
  const board: SimBoard = {
    cols,
    rows,
    cells: gen.cells.slice(),
    hidden: new Set(gen.hidden),
    locks: new Map(gen.locks),
    nextNumber: numbers > 0 ? 1 : 0,
    maxNumber: numbers,
    keysLeft: keyTypes,
  };
  return { board, mask, gen, rng, keyTypes };
}

/** 클라가 보는 판(물음표까지 가림) — 엿보기 전 상태 확인용 */
const clientView = (b: SimBoard): PickView => ({
  cells: maskForClient(b.cells, b.hidden, b.locks),
  cols: b.cols,
  rows: b.rows,
  nextNumber: b.nextNumber,
  keysLeft: b.keysLeft,
});
/** 서버 규칙 뷰: 물음표는 진실 심볼, 자물쇠만 장애물 (v3) */
const ruleView = (b: SimBoard): PickView => ({
  cells: maskForClient(b.cells, NO_HIDDEN, b.locks),
  cols: b.cols,
  rows: b.rows,
  nextNumber: b.nextNumber,
  keysLeft: b.keysLeft,
});

/** 서버(gameManager.applyRemoval)와 같은 부수효과 */
function removePair(b: SimBoard, a: number, c: number): void {
  const value = b.cells[a];
  b.cells[a] = 0;
  b.cells[c] = 0;
  for (const idx of [a, c]) {
    b.hidden.delete(idx);
    b.locks.delete(idx);
  }
  if (isKey(value)) {
    const keyType = value - KEY_BASE;
    b.keysLeft = Math.max(0, b.keysLeft - 1);
    for (const [idx, k] of [...b.locks]) if (k === keyType) b.locks.delete(idx); // 같은 색만 풀린다
  }
  if (value > NUMBER_BASE) b.nextNumber = b.nextNumber < b.maxNumber ? b.nextNumber + 1 : 0;
}

// --- 1. 마스크: 대칭 + 타일 수 규칙 ----------------------------------------

check('buildMask — 좌우대칭 + 타일 수 4k / 4k+2', () => {
  let min = Infinity;
  let max = 0;
  for (const size of SIZES) {
    const { cols, rows } = BOARD_DIMS[size];
    for (const shape of SHAPES) {
      for (let i = 0; i < 12; i++) {
        for (const want of [0, 2] as const) {
          const mask = buildMask(shape, cols, rows, mulberry32(500 + i), want);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              assert(
                mask[r * cols + c] === mask[r * cols + (cols - 1 - c)],
                `${shape}/${size} not left-right symmetric at (${r},${c})`
              );
            }
          }
          const n = mask.filter(Boolean).length;
          assert(n % 4 === want, `${shape}/${size} tile count ${n} is not 4k+${want}`);
          assert(n >= 20, `${shape}/${size} tile count ${n} is too small`);
          min = Math.min(min, n);
          max = Math.max(max, n);
        }
      }
    }
  }
  return `${SHAPES.length} shapes × ${SIZES.length} sizes, tiles ${min}~${max}`;
});

check('buildMask — frame/towers 실루엣 (액자 테두리·쌍둥이 탑)', () => {
  const notes: string[] = [];
  for (const size of SIZES) {
    const { cols, rows } = BOARD_DIMS[size];
    for (let i = 0; i < 12; i++) {
      for (const want of [0, 2] as const) {
        const frame = buildMask('frame', cols, rows, mulberry32(600 + i), want);
        for (let c = 0; c < cols; c++) {
          assert(frame[c] && frame[(rows - 1) * cols + c], `frame/${size}: 바깥 테두리가 뚫렸다 (col ${c})`);
        }
        for (let r = 0; r < rows; r++) {
          assert(frame[r * cols] && frame[r * cols + cols - 1], `frame/${size}: 바깥 테두리가 뚫렸다 (row ${r})`);
        }
        const midR = rows >> 1;
        const midC = cols >> 1;
        assert(frame[midR * cols + midC], `frame/${size}: 가운데 덩어리가 없다`);
        let hollow = 0;
        for (let r = 2; r < rows - 2; r++) for (let c = 2; c < cols - 2; c++) if (!frame[r * cols + c]) hollow++;
        assert(hollow >= 4, `frame/${size}: 안쪽이 비어 있지 않다 (hollow ${hollow})`);

        const towers = buildMask('towers', cols, rows, mulberry32(600 + i), want);
        for (let r = 0; r < rows; r++) {
          assert(
            towers[r * cols] && towers[r * cols + cols - 1],
            `towers/${size}: 좌우 탑이 끊겼다 (row ${r})`
          );
        }
        for (let c = 0; c < cols; c++) {
          assert(towers[(rows - 1) * cols + c], `towers/${size}: 아래 몸통이 뚫렸다 (col ${c})`);
        }
        assert(towers[midC] && towers[cols + midC], `towers/${size}: 꼭대기 목이 없다`);
        let gap = 0;
        for (let r = 0; r < rows / 2; r++) for (let c = 0; c < cols; c++) if (!towers[r * cols + c]) gap++;
        assert(gap >= 4, `towers/${size}: 탑 사이가 비어 있지 않다 (gap ${gap})`);
        if (i === 0 && want === 0) {
          notes.push(`${size} frame ${frame.filter(Boolean).length}/towers ${towers.filter(Boolean).length}`);
        }
      }
    }
  }
  return notes.join(', ');
});

check('previewMask — 같은 seed면 항상 같은 마스크', () => {
  const opts: GameOptions = {
    boardSize: 'm',
    mapShape: 'random',
    specials: { mystery: true, numbers: true, keys: true, walls: true },
    difficulty: 3,
    tools: { hint: 3, shuffle: 2, wand: 1 },
    items: false,
    timeLimitSec: 300,
  };
  for (let seed = 1; seed <= 20; seed++) {
    const a = previewMask(opts, seed).join('');
    const b = previewMask(opts, seed).join('');
    assert(a === b, `previewMask is not deterministic for seed ${seed}`);
    const small = previewMask(opts, seed, 's');
    assert(small.length === BOARD_DIMS.s.cols * BOARD_DIMS.s.rows, 'sizeOverride ignored');
  }
  const fixed = previewMask({ ...opts, mapShape: 'diamond' }, 7);
  assert(fixed.join('') === previewMask({ ...opts, mapShape: 'diamond' }, 7).join(''), 'fixed shape drifted');
  return '20 seeds × random/고정 모양';
});

// --- 1.5 난이도 (v3 §W1) ----------------------------------------------------

const DIFFICULTIES: Difficulty[] = [1, 2, 3, 4, 5];
const VARIETY_FACTOR = [0.55, 0.7, 0.85, 1, 1];

check('난이도 — 붙어 있는 같은 그림 수가 d1→d5로 단조 감소 (각 100판)', () => {
  const rows: string[] = [];
  let prevAdj = Infinity;
  for (const d of DIFFICULTIES) {
    let adj = 0;
    let symbols = 0;
    let expected = 0;
    for (let i = 0; i < 100; i++) {
      const { board, gen } = makeBoard('m', 'rect', SPECIAL_SETS[0].specials, 600000 + i * 11, d);
      adj += countAdjacentEqualPairs(board.cells, board.cols, board.rows);
      symbols += new Set(board.cells.filter(isNormalSymbol)).size;
      const tiles = gen.order.length * 2;
      expected += Math.max(6, Math.min(28, Math.round((tiles / 4) * VARIETY_FACTOR[d - 1])));
    }
    const avgAdj = adj / 100;
    const avgSym = symbols / 100;
    const wantSym = expected / 100;
    assert(
      Math.abs(avgSym - wantSym) < 0.01,
      `d${d}: 심볼 종류 ${avgSym} != 공식값 ${wantSym}`
    );
    assert(avgAdj < prevAdj, `d${d}: 인접 동일쌍 ${avgAdj.toFixed(2)} 가 d${d - 1}(${prevAdj.toFixed(2)}) 보다 작지 않다`);
    prevAdj = avgAdj;
    rows.push(`d${d} adj ${avgAdj.toFixed(1)} / sym ${avgSym.toFixed(0)}`);
  }
  return rows.join(' | ');
});

// --- 2. 대표 조합 × 50판: 생성 순서 R을 실제 규칙으로 재생 ------------------

interface ReplayStat {
  ok: boolean;
  detail: string;
}

function replayOrder(size: BoardSize, shape: Shape, specials: SpecialToggles, seed: number): ReplayStat {
  const { board, mask, gen } = makeBoard(size, shape, specials, seed);
  const tiles = countRemaining(board.cells);
  const maskCount = mask.filter(Boolean).length;
  const wallCount = board.cells.filter((v) => v === WALL).length;
  if (tiles !== maskCount - wallCount) return { ok: false, detail: `tiles ${tiles} != mask ${maskCount} - walls ${wallCount}` };
  if (tiles !== gen.order.length * 2) return { ok: false, detail: `order covers ${gen.order.length * 2} of ${tiles}` };
  // 심볼 개수는 전부 짝수(쌍으로만 존재)
  const counts = new Map<number, number>();
  for (const v of board.cells) if (v > 0) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [v, n] of counts) {
    if (n % 2 !== 0) return { ok: false, detail: `symbol ${v} appears ${n} times (odd)` };
  }
  if (specials.keys) {
    for (let k = 1; k <= KEY_TYPES_PER_SIZE[size]; k++) {
      if ((counts.get(KEY_BASE + k) ?? 0) !== 2) return { ok: false, detail: `key ${k} pair missing` };
    }
  }
  if (specials.numbers) {
    for (let n = 1; n <= NUMBERS_PER_SIZE[size]; n++) {
      if ((counts.get(NUMBER_BASE + n) ?? 0) !== 2) return { ok: false, detail: `number ${n} pair missing` };
    }
  }

  for (const [a, b] of gen.order) {
    // v3+: 숨김 타일도 서버는 진실 심볼로 판정한다(엿보기가 공짜)
    const reason = canPick(ruleView(board), a, b);
    if (reason) return { ok: false, detail: `reason='${reason}' with ${countRemaining(board.cells)} tiles left` };
    removePair(board, a, b);
  }
  const left = countRemaining(board.cells);
  return { ok: left === 0, detail: left === 0 ? '' : `${left} tiles left` };
}

for (const specialSet of SPECIAL_SETS) {
  check(`생성 순서 재생 — 모양 7종 × ${specialSet.name} × 50판 (size m)`, () => {
    for (const shape of SHAPES) {
      for (let i = 0; i < 50; i++) {
        const res = replayOrder('m', shape, specialSet.specials, 700000 + i * 31);
        assert(res.ok, `${shape} seed#${i}: ${res.detail}`);
      }
    }
    return `${SHAPES.length * 50} boards`;
  });
}

check('생성 순서 재생 — 크기 3종 × 랜덤 모양 × 특수 전부 ON × 50판', () => {
  for (const size of SIZES) {
    for (let i = 0; i < 50; i++) {
      const shape = SHAPES[i % SHAPES.length];
      const res = replayOrder(size, shape, SPECIAL_SETS[1].specials, 800000 + i * 17);
      assert(res.ok, `${size}/${shape} seed#${i}: ${res.detail}`);
    }
  }
  return `${SIZES.length * 50} boards`;
});

check('색 자물쇠 — 같은 색 열쇠만 그 색을 연다 (l = 3색)', () => {
  let checked = 0;
  for (let i = 0; i < 40; i++) {
    const { board, keyTypes } = makeBoard('l', SHAPES[i % SHAPES.length], SPECIAL_SETS[3].specials, 610000 + i);
    assert(keyTypes === 3, `l 은 열쇠 3종이어야 한다 (${keyTypes})`);
    assert(board.keysLeft === 3, 'keysLeft 는 열쇠 쌍 수');
    const byType = new Map<number, number[]>();
    for (const [idx, k] of board.locks) {
      const list = byType.get(k) ?? [];
      list.push(idx);
      byType.set(k, list);
    }
    if (byType.size < 2) continue; // 자물쇠가 거의 없는 판은 건너뛴다
    const target = [...byType.keys()][0];
    // 열쇠를 쓰기 전: 그 색 자물쇠는 잠겨 보인다
    const masked = clientView(board).cells;
    for (const idx of byType.get(target)!) {
      assert(masked[idx] === LOCK_BASE + target, `자물쇠 칸이 색으로 마스킹되지 않았다 (${masked[idx]})`);
    }
    const pairOfTarget = byType.get(target)!;
    assert(canPick(ruleView(board), pairOfTarget[0], pairOfTarget[1]) === 'locked', '잠긴 칸은 선택 불가');
    // 그 색 열쇠 쌍을 제거하면 그 색만 열린다
    const keyIdx: number[] = [];
    for (let k = 0; k < board.cells.length && keyIdx.length < 2; k++) {
      if (board.cells[k] === KEY_BASE + target) keyIdx.push(k);
    }
    assert(keyIdx.length === 2, `열쇠 ${target} 쌍이 없다`);
    removePair(board, keyIdx[0], keyIdx[1]);
    assert(board.keysLeft === 2, '열쇠 쌍 수가 줄어야 한다');
    for (const idx of byType.get(target)!) assert(!board.locks.has(idx), '같은 색 자물쇠가 안 열렸다');
    for (const [k, list] of byType) {
      if (k === target) continue;
      for (const idx of list) assert(board.locks.has(idx), `다른 색(${k}) 자물쇠까지 열렸다`);
    }
    checked++;
  }
  assert(checked > 0, 'no board with locks to check');
  return `${checked} boards`;
});

check('특수 타일 분산 (v4 §X2.2) — 크기 3종 × 100판, 특수 전부 ON', () => {
  const lines: string[] = [];
  for (const size of SIZES) {
    const { cols } = BOARD_DIMS[size];
    const cheb = (x: number, y: number) =>
      Math.max(Math.abs(((x / cols) | 0) - ((y / cols) | 0)), Math.abs((x % cols) - (y % cols)));
    let keyPairClose = 0;
    let keyPairCloseMax = 0;
    let adjacentKeys = 0;
    let adjacentLocks = 0;
    let adjacentLocksMax = 0;
    let numberClose = 0;
    let numberCloseMax = 0;
    let mysteryAdjOver = 0;
    for (let i = 0; i < 100; i++) {
      const { board } = makeBoard(size, SHAPES[i % SHAPES.length], SPECIAL_SETS[1].specials, 620000 + i * 7);
      const { cells, rows } = board;
      const tilesOf = (test: (v: number) => boolean) => {
        const out: number[] = [];
        for (let k = 0; k < cells.length; k++) if (test(cells[k])) out.push(k);
        return out;
      };
      // 열쇠: 한 쌍의 두 타일 체비셰프 ≥ 3, 아무 열쇠끼리도 8방향 인접 금지
      const keys = tilesOf(isKey);
      let closeThisBoard = 0;
      for (let k = 1; k <= KEY_TYPES_PER_SIZE[size]; k++) {
        const pair = tilesOf((v) => v === KEY_BASE + k);
        if (pair.length === 2 && cheb(pair[0], pair[1]) < 3) closeThisBoard++;
      }
      keyPairClose += closeThisBoard;
      keyPairCloseMax = Math.max(keyPairCloseMax, closeThisBoard);
      for (let x = 0; x < keys.length; x++) {
        for (let y = x + 1; y < keys.length; y++) if (cheb(keys[x], keys[y]) <= 1) adjacentKeys++;
      }
      // 자물쇠: 같은 색끼리 4방향 인접
      let lockPairs = 0;
      for (const [idx, k] of board.locks) {
        for (const nb of [idx + 1, idx + cols]) {
          if (nb >= cells.length) continue;
          if (nb === idx + 1 && (nb % cols) === 0) continue;
          if (board.locks.get(nb) === k) lockPairs++;
        }
      }
      adjacentLocks += lockPairs;
      adjacentLocksMax = Math.max(adjacentLocksMax, lockPairs);
      // 숫자: 같은 숫자 두 타일 체비셰프 ≥ 3
      let numClose = 0;
      for (let n = 1; n <= NUMBERS_PER_SIZE[size]; n++) {
        const pair = tilesOf((v) => v === NUMBER_BASE + n);
        if (pair.length === 2 && cheb(pair[0], pair[1]) < 3) numClose++;
      }
      numberClose += numClose;
      numberCloseMax = Math.max(numberCloseMax, numClose);
      // 물음표: 4방향으로 붙은 `?` 가 전체의 25% 이하
      const hidden = [...board.hidden];
      let touching = 0;
      for (const idx of hidden) {
        for (const nb of [idx + 1, idx + cols]) {
          if (nb >= cols * rows) continue;
          if (nb === idx + 1 && (nb % cols) === 0) continue;
          if (board.hidden.has(nb)) touching++;
        }
      }
      if (hidden.length > 0 && touching > Math.ceil(hidden.length * 0.25)) mysteryAdjOver++;
    }
    assert(adjacentKeys === 0, `${size}: 열쇠끼리 8방향 인접 ${adjacentKeys}건 (0이어야 함)`);
    assert(adjacentLocksMax <= 1, `${size}: 같은 색 자물쇠 인접 최대 ${adjacentLocksMax}쌍 (1 이하)`);
    assert(keyPairCloseMax === 0, `${size}: 열쇠 쌍 거리 위반 최대 ${keyPairCloseMax}`);
    assert(mysteryAdjOver === 0, `${size}: 물음표 인접 25% 초과 ${mysteryAdjOver}판`);
    lines.push(
      `${size} keyDist ${(keyPairClose / 100).toFixed(2)}/${keyPairCloseMax} adjKey ${adjacentKeys} ` +
        `adjLock ${(adjacentLocks / 100).toFixed(2)}/${adjacentLocksMax} numDist ${(numberClose / 100).toFixed(2)}/${numberCloseMax}`
    );
  }
  return lines.join(' | ');
});

// --- 3. 무작위 순서 플레이: 셔플 복구 / 막힘 해소(system) 비율 ---------------

check('무작위 순서 완주 — 셔플로 복구, 시스템 제거 < 1%', () => {
  let boards = 0;
  let stuckShuffles = 0;
  let systemRemovals = 0;
  let totalPairs = 0;
  for (const size of SIZES) {
    for (const shape of SHAPES) {
      for (const specialSet of [SPECIAL_SETS[0], SPECIAL_SETS[1]]) {
        for (let i = 0; i < 6; i++) {
          const seed = 900000 + i * 13 + shape.length * 7;
          const { board, rng } = makeBoard(size, shape, specialSet.specials, seed);
          boards++;
          let guard = 0;
          while (countRemaining(board.cells) > 0) {
            assert(++guard < 500, 'play loop did not terminate');
            let move = findAnyMove(ruleView(board));
            if (!move) {
              // 서버와 동일한 순서: 일반 심볼 셔플 → 그래도 없으면 시스템 제거
              board.cells = shuffleNormals(
                { ...ruleView(board), cells: board.cells },
                board.hidden,
                board.locks,
                rng
              );
              stuckShuffles++;
              move = findAnyMove(ruleView(board));
              if (!move) {
                // 서버 findBlockerPair와 같은 순서: 열쇠 → nextNumber → 아무 같은 값 쌍
                systemRemovals++;
                const pickPair = (test: (v: number) => boolean): [number, number] | null => {
                  const found: number[] = [];
                  for (let k = 0; k < board.cells.length; k++) {
                    if (board.cells[k] > 0 && test(board.cells[k])) found.push(k);
                    if (found.length === 2) return [found[0], found[1]];
                  }
                  return null;
                };
                let blocker: [number, number] | null = null;
                if (board.keysLeft > 0) {
                  for (let k = 1; k <= 3 && !blocker; k++) blocker = pickPair((v) => v === KEY_BASE + k);
                }
                if (!blocker && board.nextNumber > 0) blocker = pickPair((v) => v === NUMBER_BASE + board.nextNumber);
                if (!blocker) {
                  const seen = new Map<number, number>();
                  for (let k = 0; k < board.cells.length && !blocker; k++) {
                    const v = board.cells[k];
                    if (v <= 0 || v > NUMBER_BASE) continue;
                    const first = seen.get(v);
                    if (first !== undefined) blocker = [first, k];
                    else seen.set(v, k);
                  }
                }
                assert(blocker !== null, `no blocker pair to remove (${countRemaining(board.cells)} tiles left)`);
                removePair(board, blocker![0], blocker![1]);
                totalPairs++;
                continue;
              }
            }
            const reason = canPick(ruleView(board), move[0], move[1]);
            assert(reason === null, `findAnyMove returned an illegal pair (${reason})`);
            assert(findAllMoves(ruleView(board)).length > 0, 'findAllMoves disagrees with findAnyMove');
            removePair(board, move[0], move[1]);
            totalPairs++;
          }
        }
      }
    }
  }
  const pct = (systemRemovals / totalPairs) * 100;
  assert(pct < 1, `system removals ${pct.toFixed(2)}% of ${totalPairs} pairs (must be < 1%)`);
  return `${boards} boards, ${totalPairs} pairs, shuffles ${stuckShuffles}, system ${systemRemovals} (${pct.toFixed(3)}%)`;
});

check('shuffleNormals — 위치·특수 타일 유지 + 항상 한 수', () => {
  let tested = 0;
  for (const size of SIZES) {
    for (let i = 0; i < 12; i++) {
      const { board, rng } = makeBoard(size, SHAPES[i % SHAPES.length], SPECIAL_SETS[1].specials, 950000 + i);
      // 절반쯤 지운 상태에서 섞는다
      for (let k = 0; k < 8; k++) {
        const move = findAnyMove(ruleView(board));
        if (!move) break;
        removePair(board, move[0], move[1]);
      }
      const before = board.cells.slice();
      const next = shuffleNormals({ ...ruleView(board), cells: board.cells }, board.hidden, board.locks, rng);
      for (let idx = 0; idx < before.length; idx++) {
        const wasNormal = isNormalSymbol(before[idx]);
        if (!wasNormal) assert(next[idx] === before[idx], `special/wall tile moved at ${idx}`);
        else assert(isNormalSymbol(next[idx]), `normal tile replaced by a special at ${idx}`);
      }
      const sortNormals = (arr: number[]) => arr.filter(isNormalSymbol).sort((a, b) => a - b).join(',');
      assert(sortNormals(before) === sortNormals(next), 'normal symbol multiset changed');
      board.cells = next;
      assert(findAnyMove(ruleView(board)) !== null, 'no move after shuffle');
      tested++;
    }
  }
  return `${tested} boards`;
});

// --- 4. findPath 단위 케이스 ------------------------------------------------

/** '.' = 빈칸, 그 외 문자는 타일. 문자 하나 = 한 칸(공백 구분 없음). */
function grid(rowsText: string[]): { cells: number[]; cols: number; rows: number } {
  const rows = rowsText.length;
  const cols = rowsText[0].length;
  const cells: number[] = [];
  for (const line of rowsText) {
    assert(line.length === cols, 'ragged grid');
    for (const ch of line) cells.push(ch === '.' ? 0 : ch.charCodeAt(0));
  }
  return { cells, cols, rows };
}
const at = (cols: number, r: number, c: number) => r * cols + c;
const fmt = (path: Point[] | null) => (path ? path.map((p) => `(${p.r},${p.c})`).join('→') : 'null');

check('findPath — 맞닿은 두 타일', () => {
  const g = grid(['AA..', '....', '....']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 0, 0), at(g.cols, 0, 1));
  assert(path !== null && path.length === 2, `expected 2 points, got ${fmt(path)}`);
  return fmt(path);
});

check('findPath — 같은 줄 직선(사이가 빈칸)', () => {
  const g = grid(['A..A', 'xxxx', 'xxxx']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 0, 0), at(g.cols, 0, 3));
  assert(path !== null && path.length === 2, `expected straight path, got ${fmt(path)}`);
  return fmt(path);
});

check('findPath — 꺾임 1회', () => {
  const g = grid(['A...', '....', 'xxxA']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 0, 0), at(g.cols, 2, 3));
  assert(path !== null && path.length === 3, `expected 3 points (1 turn), got ${fmt(path)}`);
  return fmt(path);
});

check('findPath — 꺾임 2회(판 안쪽 우회)', () => {
  // 위쪽 테두리로 빠지는 길은 (0,0)/(0,4) 타일이 막아서, 판 안쪽 1행으로 돌아가야만 한다.
  const g = grid(['x...x', '.....', 'AxxxA', '.....', '.....']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 2, 0), at(g.cols, 2, 4));
  assert(path !== null && path.length === 4, `expected 4 points (2 turns), got ${fmt(path)}`);
  assert(path![1].r === 1 && path![2].r === 1, `corners must stay inside the grid, got ${fmt(path)}`);
  return fmt(path);
});

check('findPath — 바깥 테두리를 지나는 경로', () => {
  const g = grid(['AxxxA', 'xxxxx', 'xxxxx']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 0, 0), at(g.cols, 0, 4));
  assert(path !== null && path.length === 4, `expected 4 points, got ${fmt(path)}`);
  assert(path![1].r === -1 && path![2].r === -1, `corners must sit on the ring, got ${fmt(path)}`);
  return fmt(path);
});

check('findPath — 사방이 막힌 타일 → null', () => {
  const g = grid(['A....', '..x..', '.xAx.', '..x..', '.....']);
  assert(findPath(g.cells, g.cols, g.rows, at(g.cols, 2, 2), at(g.cols, 0, 0)) === null, 'expected null');
  return 'null';
});

check('findPath — 꺾임 3회가 필요하면 → null', () => {
  const g = grid(['Axxxx', 'xxxxx', 'xxxxx', 'xxxxx', 'xxxxA']);
  assert(findPath(g.cells, g.cols, g.rows, at(g.cols, 0, 0), at(g.cols, 4, 4)) === null, 'expected null');
  return 'null';
});

check('findPath — 같은 칸 / 범위 밖 → null', () => {
  const g = grid(['AA..', '....']);
  assert(findPath(g.cells, g.cols, g.rows, 0, 0) === null, 'same index must be null');
  assert(findPath(g.cells, g.cols, g.rows, 0, 999) === null, 'out of range must be null');
  assert(findPath(g.cells, g.cols, g.rows, -1, 1) === null, 'negative must be null');
  return 'null';
});

// --- 5. canPick 특수 타일 사유 ----------------------------------------------

check('canPick — 벽/자물쇠/물음표/열쇠/숫자 순서 사유', () => {
  const view = (cells: number[], nextNumber = 0): PickView => ({ cells, cols: 4, rows: 2, nextNumber, keysLeft: 0 });
  const WALLED = [WALL, 1, 0, 0, 1, 0, 0, 0];
  assert(canPick(view(WALLED), 0, 1) === 'wall', 'wall reason');
  assert(canPick(view([LOCK_BASE + 1, 0, 0, 0, LOCK_BASE + 1, 0, 0, 0]), 0, 4) === 'locked', 'locked reason');
  // v3: 아직 엿보지 않은 물음표는 클라가 예측할 수 없다 → 'symbol'
  assert(canPick(view([MYSTERY, 0, 0, 0, MYSTERY, 0, 0, 0]), 0, 4) === 'symbol', 'mystery is not matchable');
  // 열쇠는 같은 색끼리만
  assert(canPick(view([KEY_BASE + 1, 0, 0, 0, KEY_BASE + 1, 0, 0, 0]), 0, 4) === null, 'same-colour keys pair');
  assert(canPick(view([KEY_BASE + 1, 0, 0, 0, KEY_BASE + 2, 0, 0, 0]), 0, 4) === 'symbol', 'different keys must not pair');
  assert(isLock(LOCK_BASE + 3) && !isLock(MYSTERY) && isKey(KEY_BASE + 2), 'lock/key predicates');
  assert(canPick(view([1, 0, 0, 0, 2, 0, 0, 0]), 0, 4) === 'symbol', 'symbol reason');
  assert(canPick(view([1, 0, 0, 0, 0, 0, 0, 0]), 0, 4) === 'gone', 'gone reason');
  assert(canPick(view([1, 0, 0, 0, 1, 0, 0, 0]), 2, 2) === 'same', 'same reason');
  const numbers = [NUMBER_BASE + 2, 0, 0, 0, NUMBER_BASE + 2, 0, 0, 0];
  assert(canPick(view(numbers, 1), 0, 4) === 'order', 'order reason');
  assert(canPick(view(numbers, 2), 0, 4) === null, 'nextNumber pair must be allowed');
  assert(canPick(view([1, 0, 0, 0, 1, 0, 0, 0]), 0, 4) === null, 'plain pair must be allowed');
  return '10 cases';
});

// --- 6. gameManager 한 판 흐름 ----------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- 6. 테트리스 (docs/games/tetris-design.md T3) ----------------------------

/** 빈 프레임 하나 (cells 200칸). 서버는 내용을 안 보지만 형태는 계약대로 채운다. */
function tframe(over: Partial<Omit<TetrisFrame, 'userId'>> = {}): Omit<TetrisFrame, 'userId'> {
  return {
    cells: new Array(200).fill(0),
    lines: 0,
    score: 0,
    level: 1,
    combo: 0,
    b2b: 0,
    hold: 0,
    next: [1, 2, 3],
    pending: 0,
    alive: true,
    ko: 0,
    t: 0,
    ...over,
  };
}

function tclear(over: Partial<TetrisClearMsg> = {}): TetrisClearMsg {
  return { kind: 'tetris', lines: 4, combo: 0, b2b: false, perfect: false, ...over };
}

interface TetrisHarness {
  rt: TetrisRuntime;
  events: { event: string; payload: any }[];
  ended: string[];
  setPlaying: (v: boolean) => void;
}

function harness(ids: string[], opts: Partial<TetrisOptions> = {}, seed = 12345): TetrisHarness {
  const events: { event: string; payload: any }[] = [];
  const ended: string[] = [];
  let playing = true;
  const rng = mulberry32(seed);
  const rt = createTetris({ ...DEFAULT_TETRIS_OPTIONS.versus, ...opts }, ids, {
    broadcast: (event, payload) => events.push({ event, payload: payload as any }),
    onPlayerUpdate: () => {},
    onEnd: (reason) => {
      ended.push(reason);
      playing = false;
    },
    rng,
    isPlaying: () => playing,
  });
  return { rt, events, ended, setPlaying: (v) => (playing = v) };
}

check('테트리스 공격량 — 기본표(줄 지움 4종) × 배수', () => {
  assert(computeGarbage(tclear({ kind: 'single', lines: 1 }), 1) === 0, 'single = 0줄');
  assert(computeGarbage(tclear({ kind: 'double', lines: 2 }), 1) === 1, 'double = 1줄');
  assert(computeGarbage(tclear({ kind: 'triple', lines: 3 }), 1) === 2, 'triple = 2줄');
  assert(computeGarbage(tclear(), 1) === 4, 'tetris = 4줄');
  // floor 는 곱한 다음에 — 2 * 1.5 = 3, 2 * 0.5 = 1
  assert(computeGarbage(tclear({ kind: 'triple' }), 1.5) === 3, 'triple × 1.5 = 3');
  assert(computeGarbage(tclear({ kind: 'triple' }), 0.5) === 1, 'triple × 0.5 = 1');
  assert(computeGarbage(tclear(), 2) === 8, 'tetris × 2 = 8');
  assert(computeGarbage(tclear(), 0) === 0, '배수 0(레이스)이면 공격 없음');
  return '8 cases';
});

check('테트리스 공격량 — T스핀 4종 + B2B + 퍼펙트클리어', () => {
  assert(computeGarbage(tclear({ kind: 'tsm', lines: 1 }), 1) === 0, 'T스핀 미니 = 0');
  assert(computeGarbage(tclear({ kind: 'tss', lines: 1 }), 1) === 2, 'TSS = 2');
  assert(computeGarbage(tclear({ kind: 'tsd', lines: 2 }), 1) === 4, 'TSD = 4');
  assert(computeGarbage(tclear({ kind: 'tst', lines: 3 }), 1) === 6, 'TST = 6');
  assert(computeGarbage(tclear({ kind: 'tsd', b2b: true }), 1) === 4 + B2B_BONUS, 'B2B 보너스');
  assert(
    computeGarbage(tclear({ perfect: true }), 1) === 4 + PERFECT_CLEAR_BONUS,
    '퍼펙트클리어 보너스'
  );
  // 전부 겹친 최대치: tst + b2b + pc + combo
  const all = computeGarbage(tclear({ kind: 'tst', b2b: true, perfect: true, combo: 4 }), 1);
  assert(all === 6 + B2B_BONUS + PERFECT_CLEAR_BONUS + COMBO_TABLE[4], `합산 ${all}`);
  return '7 cases';
});

check('테트리스 공격량 — 콤보표(인덱스=콤보, 표를 넘으면 마지막 값)', () => {
  for (let c = 0; c < COMBO_TABLE.length; c++) {
    const got = computeGarbage(tclear({ kind: 'double', combo: c }), 1);
    assert(got === 1 + COMBO_TABLE[c], `combo ${c} → ${got}`);
  }
  const last = COMBO_TABLE[COMBO_TABLE.length - 1];
  assert(computeGarbage(tclear({ kind: 'double', combo: 99 }), 1) === 1 + last, '표 초과는 마지막 값');
  assert(computeGarbage(tclear({ kind: 'double', combo: -3 }), 1) === 1 + COMBO_TABLE[0], '음수 콤보 방어');
  return `${COMBO_TABLE.length + 2} cases`;
});

check('테트리스 구멍 열 — 길이 일치 + 4줄마다만 열이 바뀐다', () => {
  const rng = mulberry32(99);
  for (const amount of [1, 2, 4, 5, 8, 9, 12, 20]) {
    const holes = makeHoles(rng, amount);
    assert(holes.length === amount, `holes ${holes.length} ≠ ${amount}`);
    assert(holes.every((c) => c >= 0 && c < COLS), `열 범위 밖: ${holes}`);
    for (let i = 1; i < holes.length; i++) {
      if (i % 4 === 0) assert(holes[i] !== holes[i - 1], `${amount}줄: ${i}번째에서 열이 안 바뀌었다`);
      else assert(holes[i] === holes[i - 1], `${amount}줄: ${i}번째 열이 묶음 안에서 바뀌었다`);
    }
  }
  assert(makeHoles(rng, 0).length === 0, '0줄이면 빈 배열');
  return '9 cases';
});

check('테트리스 대상 선택 — 2인은 상대, 3인은 선두(지운 줄 최대), 죽은 사람 제외', () => {
  const rng = mulberry32(7);
  const two = harness(['a', 'b']);
  assert(pickTarget([...two.rt.players.values()], 'a', rng)!.userId === 'b', '2인은 무조건 상대');
  assert(pickTarget([...two.rt.players.values()], 'b', rng)!.userId === 'a', '2인 반대 방향');

  const three = harness(['a', 'b', 'c']);
  three.rt.players.get('b')!.lines = 12;
  three.rt.players.get('c')!.lines = 30;
  for (let i = 0; i < 20; i++) {
    assert(pickTarget([...three.rt.players.values()], 'a', rng)!.userId === 'c', '선두(c)를 쳐야 한다');
  }
  three.rt.players.get('c')!.alive = false;
  assert(pickTarget([...three.rt.players.values()], 'a', rng)!.userId === 'b', '죽은 선두는 제외');

  const solo = harness(['a']);
  assert(pickTarget([...solo.rt.players.values()], 'a', rng) === null, '1인은 대상 없음');

  // 동률이면 랜덤 — 여러 번 뽑으면 두 명 다 나와야 한다
  const tie = harness(['a', 'b', 'c']);
  tie.rt.players.get('b')!.lines = 5;
  tie.rt.players.get('c')!.lines = 5;
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) seen.add(pickTarget([...tie.rt.players.values()], 'a', rng)!.userId);
  assert(seen.size === 2, `동률 랜덤이 아니다: ${[...seen]}`);
  return '6 cases';
});

check('테트리스 상쇄 — 내 pending 을 먼저 깎고 남은 만큼만 보낸다', () => {
  const h = harness(['a', 'b']);
  const a = h.rt.players.get('a')!;
  const b = h.rt.players.get('b')!;

  // b 가 4줄 → a 에게 4줄
  const first = onClear(h.rt, 'b', tclear());
  assert(first !== null && first.to === 'a' && first.amount === 4, `첫 공격 ${JSON.stringify(first)}`);
  assert(a.pending === 4, `a.pending ${a.pending}`);
  assert(h.events.filter((e) => e.event === 'tetris:garbage').length === 1, 'garbage 1건');
  assert(h.events.filter((e) => e.event === 'tetris:sent').length === 1, 'sent 1건');
  const g = h.events.find((e) => e.event === 'tetris:garbage')!.payload;
  assert(g.to === 'a' && g.from === 'b' && g.holes.length === 4, `garbage payload ${JSON.stringify(g)}`);

  // a 가 triple(2줄) → 전부 상쇄, 아무것도 안 나간다
  const canceled = onClear(h.rt, 'a', tclear({ kind: 'triple', lines: 3 }));
  assert(canceled === null, '전부 상쇄면 null');
  assert(a.pending === 2, `상쇄 후 a.pending ${a.pending}`);
  assert(b.pending === 0, 'b 는 아직 안 맞았다');
  assert(h.events.filter((e) => e.event === 'tetris:sent').length === 1, '상쇄는 sent 를 만들면 안 된다');

  // a 가 4줄 → 2줄 상쇄 + 2줄 전달
  const partial = onClear(h.rt, 'a', tclear());
  assert(partial !== null && partial.amount === 2, `부분 상쇄 ${JSON.stringify(partial)}`);
  assert(a.pending === 0 && b.pending === 2, `원장 a=${a.pending} b=${b.pending}`);
  assert(partial!.holes.length === 2, '구멍 열도 남은 양만큼');
  return '11 cases';
});

check('테트리스 프레임 — 초당 15회 상한을 넘으면 조용히 버린다', () => {
  const h = harness(['a', 'b']);
  let accepted = 0;
  for (let i = 0; i < 40; i++) if (onFrame(h.rt, 'a', tframe({ t: i }), 1000)) accepted++;
  assert(accepted === 15, `같은 창에서 ${accepted}개 통과 (15여야 함)`);
  // 창이 지나면 다시 받는다
  assert(onFrame(h.rt, 'a', tframe(), 2001) === true, '다음 창에서는 다시 받아야 한다');
  assert(onFrame(h.rt, 'nobody', tframe(), 2001) === false, '플레이어가 아니면 거부');
  return '3 cases';
});

check('테트리스 프레임 — lines/score 단조 증가 + pending 은 서버 원장', () => {
  const h = harness(['a', 'b']);
  const a = h.rt.players.get('a')!;
  onFrame(h.rt, 'a', tframe({ lines: 10, score: 5000 }), 1000);
  assert(a.lines === 10 && a.score === 5000, '첫 프레임 반영');
  onFrame(h.rt, 'a', tframe({ lines: 3, score: 100 }), 1100);
  assert(a.lines === 10 && a.score === 5000, `줄어드는 값은 무시해야 한다 (${a.lines}/${a.score})`);
  assert(a.frame!.lines === 10 && a.frame!.score === 5000, '릴레이 프레임도 최대값으로 고쳐 나간다');
  onFrame(h.rt, 'a', tframe({ lines: 11, score: 5100 }), 1200);
  assert(a.lines === 11 && a.score === 5100, '증가는 반영');

  // 서버가 4줄을 꽂아 넣으면 클라가 뭐라 하든 원장이 우선
  onClear(h.rt, 'b', tclear());
  assert(a.pending === 4, 'garbage 원장');
  onFrame(h.rt, 'a', tframe({ lines: 11, score: 5100, pending: 99 }), 1300);
  assert(a.pending === 4, '클라가 pending 을 부풀려도 안 늘어난다');
  assert(a.frame!.pending === 4, '릴레이 프레임의 pending 은 서버 값');
  onFrame(h.rt, 'a', tframe({ lines: 11, score: 5100, pending: 1 }), 1400);
  assert(a.pending === 1, '클라가 실제로 받아 내면 원장이 줄어든다');
  return '8 cases';
});

check('테트리스 탑아웃 — 3인 대전에서 먼저 죽은 사람이 3등, KO 크레딧', () => {
  const h = harness(['a', 'b', 'c']);
  // b 가 c 를 때려 놓는다 → c 가 죽으면 KO 는 b 에게
  h.rt.players.get('c')!.lines = 50; // c 가 선두라 b 의 공격은 c 로 간다
  onClear(h.rt, 'b', tclear());
  assert(h.rt.players.get('c')!.pending === 4, 'c 가 맞았다');

  const rankC = onTopout(h.rt, 'c', 1000);
  assert(rankC === 3, `먼저 죽은 c 는 3등이어야 한다 (${rankC})`);
  assert(h.rt.players.get('b')!.ko === 1, 'KO 는 마지막으로 때린 b 에게');
  assert(h.ended.length === 0, '아직 2명 남았으니 안 끝난다');
  const down = h.events.filter((e) => e.event === 'tetris:down');
  assert(down.length === 1 && down[0].payload.by === 'b' && down[0].payload.rank === 3, 'down 이벤트');

  const rankB = onTopout(h.rt, 'b', 2000);
  assert(rankB === 2, `두 번째로 죽은 b 는 2등 (${rankB})`);
  assert(h.ended.length === 1, `마지막 1명이 남으면 끝나야 한다 (${h.ended.length})`);
  assert(onTopout(h.rt, 'b', 3000) === null, '이미 죽은 사람은 두 번 안 죽는다');

  const order = sortForResults(h.rt).map((p) => p.userId);
  assert(order.join(',') === 'a,b,c', `결과 정렬 ${order}`);

  // 혼자 하는 판은 그 1명이 죽어야 끝난다
  const solo = harness(['a']);
  assert(solo.ended.length === 0, '시작하자마자 끝나면 안 된다');
  onTopout(solo.rt, 'a', 1000);
  assert(solo.ended.length === 1, '혼자일 때도 종료 조건이 성립해야 한다');
  return '10 cases';
});

check('테트리스 레이스 — 첫 완주자가 나오면 즉시 종료 + 정렬(미완주는 줄 내림차순)', () => {
  const h = harness(['a', 'b', 'c', 'd'], { ...DEFAULT_TETRIS_OPTIONS.sprint });
  h.rt.players.get('a')!.lines = 22;
  h.rt.players.get('c')!.lines = 31;
  h.rt.players.get('d')!.lines = 12;

  assert(onFinish(h.rt, 'b', 41000, 40, 1000) === 1, 'b 가 먼저 완주 → 1등');
  // v5: 나머지가 40줄을 채울 때까지 기다리지 않는다(사용자 요청)
  assert(h.ended.length === 1, '완주자가 나오는 순간 끝난다');
  assert(onFinish(h.rt, 'b', 30000, 40, 3000) === null, '두 번 완주는 무시');
  const fin = h.events.filter((e) => e.event === 'tetris:finished');
  assert(fin.length === 1 && fin[0].payload.timeMs === 41000, 'finished 이벤트');

  // 완주자 먼저, 미완주자는 지운 줄 내림차순
  const order = sortForResults(h.rt).map((p) => p.userId);
  assert(order.join(',') === 'b,c,a,d', `sprint 정렬 ${order}`);

  // 아무도 완주 못 하고 전원 탈락해도 끝나야 한다
  const h2 = harness(['a', 'b'], { ...DEFAULT_TETRIS_OPTIONS.sprint });
  onTopout(h2.rt, 'a', 1000);
  assert(h2.ended.length === 0, 'b 가 아직 살아 있다');
  onTopout(h2.rt, 'b', 2000);
  assert(h2.ended.length === 1, '전원 탈락이면 끝난다');
  return '9 cases';
});

check('테트리스 타이머 — begin/stop 으로 반드시 정리된다', () => {
  const h = harness(['a', 'b'], { riseSec: 15 });
  beginTetris(h.rt);
  assert(h.rt.frameTimer !== null && h.rt.riseTimer !== null, '타이머가 켜져야 한다');
  beginTetris(h.rt); // 중복 호출로 타이머가 새면 안 된다
  assert(h.rt.frameTimer !== null && h.rt.riseTimer !== null, '중복 시작 후에도 1쌍');
  stopTetris(h.rt);
  assert(h.rt.frameTimer === null && h.rt.riseTimer === null, '정리 안 됨');

  const noRise = harness(['a'], { riseSec: 0 });
  beginTetris(noRise.rt);
  assert(noRise.rt.riseTimer === null, 'riseSec 0 이면 상승 타이머 없음');
  stopTetris(noRise.rt);
  return '5 cases';
});

async function tetrisVersusFlow(): Promise<string> {
  const slug = `selfcheck-tetris-${Date.now()}`;
  const events: { event: string; payload: any }[] = [];
  gameManager.setBroadcast((_slug, event, payload) => events.push({ event, payload: payload as any }));
  const p1 = { userId: 't1', nickname: '하나' };
  const p2 = { userId: 't2', nickname: '두울' };
  const p3 = { userId: 't3', nickname: '세엣' };

  const created = gameManager.create(slug, p1, { gameId: 'tetris', tetris: { mode: 'versus' } });
  assert('state' in created, 'create failed');
  gameManager.join(slug, p2);
  gameManager.join(slug, p3);

  const lobby = gameManager.getSnapshot(slug)!;
  assert(lobby.gameId === 'tetris', `gameId ${lobby.gameId}`);
  assert(lobby.tetris !== null && lobby.tetris.mode === 'versus', '테트리스 설정이 비어 있다');
  assert(lobby.players.every((p) => p.lines === 0 && p.ko === 0), 'lines/ko 기본값');

  // 옵션 병합 + 범위 보정
  gameManager.updateOptions(slug, p1, { tetris: { startLevel: 99, garbageMul: 1.4, nextCount: 0 } });
  const opt1 = gameManager.getSnapshot(slug)!.tetris!;
  assert(opt1.startLevel === 10, `startLevel 클램프 실패 ${opt1.startLevel}`);
  assert(opt1.garbageMul === 1.5, `garbageMul 스냅 실패 ${opt1.garbageMul}`);
  assert(opt1.nextCount === 1, `nextCount 클램프 실패 ${opt1.nextCount}`);
  assert(opt1.mode === 'versus', '모드는 그대로');

  // 사천성으로 갔다 오면 테트리스 설정은 기본값으로 초기화된다
  gameManager.updateOptions(slug, p1, { gameId: 'shisen' });
  assert(gameManager.getSnapshot(slug)!.tetris === null, '사천성이면 tetris 는 null');
  gameManager.updateOptions(slug, p1, { gameId: 'tetris', tetris: { mode: 'versus' } });
  const opt2 = gameManager.getSnapshot(slug)!.tetris!;
  assert(opt2.startLevel === DEFAULT_TETRIS_OPTIONS.versus.startLevel, '되돌아오면 기본값');
  gameManager.updateOptions(slug, p1, { tetris: { garbageMul: 1 } });

  gameManager.setReady(slug, p2, true); // §Z3
  gameManager.setReady(slug, p3, true);
  const started = gameManager.start(slug, p1);
  assert('state' in started, 'tetris start failed');
  const s0 = (started as { state: GameSnapshot }).state;
  assert(s0.phase === 'countdown', `phase ${s0.phase}`);
  assert(Object.keys(s0.boards).length === 0, '테트리스는 서버 보드를 만들지 않는다');
  assert(s0.seed > 0, '7-bag 시드가 필요하다');

  // 시작 전 입력은 무시
  assert(gameManager.tetrisClear(slug, p1, tclear()).ok === false, '카운트다운 중 공격은 거부');
  await sleep(3200);
  assert(gameManager.getSnapshot(slug)!.phase === 'playing', 'playing 으로 못 넘어감');

  // 프레임 릴레이(8Hz)
  gameManager.tetrisFrame(slug, p1, tframe({ lines: 8, score: 900 }));
  gameManager.tetrisFrame(slug, p2, tframe({ lines: 2, score: 100 }));
  gameManager.tetrisFrame(slug, p3, tframe({ lines: 20, score: 4000 }));
  await sleep(300);
  const relay = events.filter((e) => e.event === 'tetris:frames');
  assert(relay.length >= 1, `8Hz 릴레이가 없다 (${relay.length})`);
  assert(relay[relay.length - 1].payload.frames.length === 3, '세 명 프레임이 묶여야 한다');
  const live = gameManager.getSnapshot(slug)!;
  assert(live.players.find((p) => p.userId === 't3')!.lines === 20, '스냅샷에 lines 반영');
  assert(live.players.find((p) => p.userId === 't3')!.rank === 1, '지운 줄이 제일 많은 t3 가 1등');

  // t1 의 공격은 선두 t3 로 간다
  assert(gameManager.tetrisClear(slug, p1, tclear()).ok === true, 'clear ack');
  const sent = events.filter((e) => e.event === 'tetris:sent');
  assert(sent.length === 1 && sent[0].payload.to === 't3', `선두 타격 실패 ${JSON.stringify(sent[0]?.payload)}`);
  assert(sent[0].payload.amount === 4 && sent[0].payload.kind === 'tetris', '공격량 4줄');

  // t3 탈락 → 3등, KO 는 t1
  assert(gameManager.tetrisTopout(slug, p3).ok === true, 'topout ack');
  const afterKo = gameManager.getSnapshot(slug)!;
  assert(afterKo.players.find((p) => p.userId === 't1')!.ko === 1, 'KO 가 t1 에게 안 갔다');
  assert(afterKo.phase === 'playing', '아직 2명 남았다');

  gameManager.tetrisTopout(slug, p2);
  const done = gameManager.getSnapshot(slug)!;
  assert(done.phase === 'finished', `phase ${done.phase}`);
  const results = done.results!;
  assert(results.map((r) => r.userId).join(',') === 't1,t2,t3', `등수 ${results.map((r) => r.userId)}`);
  assert(results[0].rank === 1 && results[2].rank === 3, '등수 번호');
  assert(results[0].remaining === results[0].pairsCleared, 'remaining 자리에는 지운 줄 수');
  assert(results[2].remaining === 20, `t3 의 지운 줄 ${results[2].remaining}`);
  assert(done.scoreboard.find((r) => r.userId === 't1')!.wins === 1, '테트리스도 승수를 센다');

  // 끝난 뒤에는 타이머가 전부 꺼져서 프레임이 더 안 나가야 한다
  const framesAtEnd = events.filter((e) => e.event === 'tetris:frames').length;
  await sleep(300);
  assert(
    events.filter((e) => e.event === 'tetris:frames').length === framesAtEnd,
    '종료 후에도 프레임 타이머가 돌고 있다'
  );

  const again = gameManager.rematch(slug, p1);
  assert('state' in again && (again as any).state.phase === 'lobby', 'rematch 실패');
  const relobby = gameManager.getSnapshot(slug)!;
  assert(relobby.players.every((p) => p.lines === 0 && p.ko === 0), '리매치는 줄/KO 도 리셋');
  assert(relobby.tetris !== null, '리매치 후에도 테트리스 설정은 남는다');
  gameManager.destroy(slug);
  return `${sent.length} attack, ${relay.length} frame relays`;
}

async function tetrisSprintFlow(): Promise<string> {
  const slug = `selfcheck-tetris-sprint-${Date.now()}`;
  const events: { event: string; payload: any }[] = [];
  gameManager.setBroadcast((_slug, event, payload) => events.push({ event, payload: payload as any }));
  const p1 = { userId: 's1', nickname: '하나' };
  const p2 = { userId: 's2', nickname: '두울' };

  gameManager.create(slug, p1, { gameId: 'tetris', tetris: { mode: 'sprint', sprintLines: 40 } });
  gameManager.join(slug, p2);
  const opts = gameManager.getSnapshot(slug)!.tetris!;
  assert(opts.mode === 'sprint' && opts.garbageMul === 0, '레이스는 공격이 없다');
  assert(opts.timeLimitSec === DEFAULT_TETRIS_OPTIONS.sprint.timeLimitSec, '레이스 기본 제한 시간');

  gameManager.setReady(slug, p2, true); // §Z3
  gameManager.start(slug, p1);
  await sleep(3200);
  // s2 가 먼저 40줄을 채우고, s1 은 18줄에서 멈춰 있는 상황
  gameManager.tetrisFrame(slug, p1, tframe({ lines: 18, score: 2000 }));
  gameManager.tetrisFrame(slug, p2, tframe({ lines: 40, score: 8000 }));

  // v5: 한 명이라도 완주하면 **즉시** 끝난다(기다리지 않는다)
  assert(gameManager.tetrisFinish(slug, p2, 38000, 40).ok === true, 's2 finish');
  assert(gameManager.getSnapshot(slug)!.phase === 'finished', '완주자가 나오면 즉시 종료');
  assert(gameManager.tetrisFinish(slug, p1, 45000, 40).ok === false, '끝난 뒤 완주 보고는 거절');

  const done = gameManager.getSnapshot(slug)!;
  const rows = done.results!;
  assert(rows[0].userId === 's2' && rows[0].timeMs === 38000, `1등 ${rows[0].userId} ${rows[0].timeMs}`);
  assert(rows[1].userId === 's1' && rows[1].timeMs === null, '미완주자는 기록 없이 2등');
  assert(rows[1].remaining === 18, `미완주자는 지운 줄로 평가 (${rows[1].remaining})`);
  assert(rows[0].remaining === 40, '지운 줄 수가 remaining 자리에');
  assert(
    done.scoreboard.find((r) => r.userId === 's2')!.bestTimeMs === 38000,
    '레이스 기록이 전적에 남아야 한다'
  );
  assert(events.some((e) => e.event === 'tetris:finished'), 'tetris:finished 브로드캐스트');
  gameManager.destroy(slug);
  return `${rows[0].timeMs}ms vs ${rows[1].timeMs}ms`;
}


async function managerFlow(): Promise<string> {
  const slug = `selfcheck-${Date.now()}`;
  const events: { event: string; payload: any }[] = [];
  gameManager.setBroadcast((_slug, event, payload) => events.push({ event, payload }));

  const p1 = { userId: 'u1', nickname: '하나' };
  const p2 = { userId: 'u2', nickname: '두울' };

  // v2: 인자 없이 만들면 shisen/race/기본 옵션
  const created = gameManager.create(slug, p1, {});
  assert('state' in created, 'create failed');
  const lobby0 = (created as { state: GameSnapshot }).state;
  assert(lobby0.mode === 'race' && lobby0.options.mapShape === 'random', 'default options wrong');
  assert('error' in gameManager.create(slug, p2, {}), 'duplicate create must fail');
  assert('state' in gameManager.join(slug, p2), 'join failed');

  // 부분 병합: specials 하나만 바꿔도 나머지는 유지
  gameManager.updateOptions(slug, p1, { options: { specials: { keys: true } } });
  gameManager.updateOptions(slug, p1, {
    options: { boardSize: 's', mapShape: 'diamond', items: true, timeLimitSec: 120, specials: { mystery: true } },
  });
  const merged = gameManager.getSnapshot(slug)!.options;
  assert(merged.specials.keys && merged.specials.mystery, `partial merge lost a toggle: ${JSON.stringify(merged.specials)}`);
  assert(merged.boardSize === 's' && merged.mapShape === 'diamond' && merged.items, 'option patch lost fields');

  // A6: 모드를 바꿔도 맵 모양·특수 타일은 유지, 판 크기/제한 시간만 새 모드 기본값
  gameManager.updateOptions(slug, p1, { mode: 'coop' });
  const afterCoop = gameManager.getSnapshot(slug)!.options;
  assert(
    afterCoop.tools.hint === 5 && afterCoop.tools.shuffle === 3 && afterCoop.tools.wand === 2,
    `모드 전환 시 아이템 횟수는 그 모드 기본값: ${JSON.stringify(afterCoop.tools)}`
  );
  assert(afterCoop.mapShape === 'diamond', '모드 전환에서 mapShape가 날아갔다');
  assert(afterCoop.specials.keys && afterCoop.specials.mystery, '모드 전환에서 specials가 날아갔다');
  assert(afterCoop.boardSize === 'l' && afterCoop.timeLimitSec === 0, '모드 기본값(판 크기/제한 시간) 미적용');
  assert(afterCoop.items === false, 'coop은 items=false 강제');
  gameManager.updateOptions(slug, p1, { mode: 'race', options: { boardSize: 's', items: true, timeLimitSec: 120 } });
  const backToRace = gameManager.getSnapshot(slug)!.options;
  assert(backToRace.mapShape === 'diamond' && backToRace.specials.mystery, '되돌릴 때도 유지돼야 한다');
  assert(backToRace.boardSize === 's' && backToRace.items, 'patch가 모드 기본값을 덮어써야 한다');

  // A10: 아이템 횟수 옵션(부분 병합 + 범위 클램프)
  gameManager.updateOptions(slug, p1, { options: { tools: { hint: 7 } } });
  const tools1 = gameManager.getSnapshot(slug)!.options.tools;
  assert(tools1.hint === 7 && tools1.shuffle === 2 && tools1.wand === 1, `tools 부분 병합 실패: ${JSON.stringify(tools1)}`);
  gameManager.updateOptions(slug, p1, { options: { tools: { hint: 99, wand: 9, shuffle: -3 } } });
  const tools2 = gameManager.getSnapshot(slug)!.options.tools;
  assert(tools2.hint === 9 && tools2.wand === 3 && tools2.shuffle === 0, `tools 클램프 실패: ${JSON.stringify(tools2)}`);
  gameManager.updateOptions(slug, p1, { options: { tools: { hint: 3, shuffle: 2, wand: 1 } } });

  // A8: GameOptions 의 모든 필드가 부분 병합돼야 한다 (difficulty 가 빠져 있었다)
  assert(gameManager.getSnapshot(slug)!.options.difficulty === 3, '기본 난이도는 3');
  const diffAck = gameManager.updateOptions(slug, p1, { options: { difficulty: 5 } });
  assert('state' in diffAck && diffAck.state.options.difficulty === 5, 'ack 에 난이도가 반영돼야 한다');
  const afterDiff = gameManager.getSnapshot(slug)!.options;
  assert(afterDiff.difficulty === 5, `스냅샷 난이도 ${afterDiff.difficulty}`);
  assert(
    afterDiff.boardSize === 's' && afterDiff.mapShape === 'diamond' && afterDiff.specials.keys,
    '난이도만 바꿨는데 다른 옵션이 날아갔다'
  );
  assert('error' in gameManager.start(slug, p2), 'non-host start must fail');
  // §Z3: 방장이 아닌 사람이 준비를 눌러야 시작할 수 있다
  assert('error' in gameManager.start(slug, p1), '미준비자가 있으면 시작이 거절돼야 한다');
  assert('state' in gameManager.setReady(slug, p2, true), 'p2 준비 실패');

  const started = gameManager.start(slug, p1);
  assert('state' in started, 'start failed');
  const startState = (started as { state: GameSnapshot }).state;
  assert(startState.phase === 'countdown', `phase ${startState.phase}`);
  assert(Object.keys(startState.boards).length === 2, 'race needs one board per player');
  assert(
    startState.boards['u1'].cells.join(',') === startState.boards['u2'].cells.join(','),
    'race boards must be identical (cells incl. hidden/locked masking)'
  );
  assert(startState.boards['u1'].shape === 'diamond', 'board shape not reported');
  // 난이도 5로 만든 판이어야 한다: d5 는 붙어 있는 같은 그림이 거의 없다(같은 크기 d1 대비)
  {
    const b = startState.boards['u1'];
    const adjHard = countAdjacentEqualPairs(b.cells, b.cols, b.rows);
    const easy = makeBoard('s', 'diamond', SPECIAL_SETS[0].specials, 777, 1);
    const adjEasy = countAdjacentEqualPairs(easy.board.cells, easy.board.cols, easy.board.rows);
    assert(adjHard < adjEasy, `d5 보드 인접 동일쌍 ${adjHard} 이 d1 ${adjEasy} 보다 많다`);
  }
  assert(startState.boards['u1'].keysLeft === KEY_TYPES_PER_SIZE.s, 'keysLeft must be the number of key pairs');
  assert(
    startState.players[0].items.hint === 3 && startState.players[0].items.shuffle === 2 && startState.players[0].items.wand === 1,
    `race item defaults wrong: ${JSON.stringify(startState.players[0].items)}`
  );
  assert(startState.boards['u1'].movesLeft > 0, 'movesLeft missing in snapshot');
  assert(
    startState.boards['u1'].total === startState.boards['u1'].remaining && startState.boards['u1'].total > 0,
    'Board.total 은 시작 시 남은 패 수와 같아야 한다'
  );
  assert(startState.players.every((p) => p.rank >= 1), 'rank 가 없다');
  assert(gameManager.pick(slug, p1, 0, 1).ok === false, 'pick before startAt must be rejected');

  await sleep(3200); // 카운트다운

  // 물음표는 엿보기(peek) — 서버 상태는 바뀌지 않는다
  const snap1 = gameManager.getSnapshot(slug)!;
  const mysteryIdx = snap1.boards['u1'].cells.findIndex((v) => v === MYSTERY);
  assert(mysteryIdx >= 0, 'mystery tiles should exist with mystery:true');
  const lockedIdx = snap1.boards['u1'].cells.findIndex((v) => isLock(v));
  assert(lockedIdx >= 0, 'locked tiles should exist with keys:true');
  const peeked = gameManager.peek(slug, p1, mysteryIdx);
  assert(peeked.ok === true && isNormalSymbol(peeked.symbol), `peek failed: ${JSON.stringify(peeked)}`);
  const afterPeek = gameManager.getSnapshot(slug)!;
  assert(afterPeek.boards['u1'].cells[mysteryIdx] === MYSTERY, 'peek must NOT reveal the tile for everyone');
  assert(afterPeek.seq === snap1.seq, 'peek must not bump seq / mutate state');
  assert(gameManager.peek(slug, p1, mysteryIdx).ok === true, 'peek must be repeatable');

  // 자물쇠는 선택 불가 / 같은 색 열쇠끼리만 짝
  const lockValue = afterPeek.boards['u1'].cells[lockedIdx];
  const otherLocked = afterPeek.boards['u1'].cells.findIndex((v, i) => v === lockValue && i !== lockedIdx);
  const lockedPick = gameManager.pick(slug, p1, lockedIdx, otherLocked);
  assert(lockedPick.ok === false && lockedPick.reason === 'locked', `expected locked, got ${JSON.stringify(lockedPick)}`);
  assert(gameManager.peek(slug, p1, lockedIdx).ok === false, 'peeking a lock must fail');

  // 아이템: 재배치 / 여의봉
  const beforeItems = gameManager.getSnapshot(slug)!.players[0].items;
  assert(gameManager.useShuffle(slug, p1).ok === true, 'F2 shuffle failed');
  assert(gameManager.getSnapshot(slug)!.players[0].items.shuffle === beforeItems.shuffle - 1, 'shuffle not consumed');
  const beforeWand = gameManager.getSnapshot(slug)!;
  assert(gameManager.useWand(slug, p1).ok === true, 'F3 wand failed');
  const afterWand = gameManager.getSnapshot(slug)!;
  assert(afterWand.players[0].items.wand === 0, 'wand not consumed');
  assert(afterWand.boards['u1'].remaining === beforeWand.boards['u1'].remaining - 2, 'wand did not remove a pair');
  assert(afterWand.players[0].combo === 0, 'wand must break the combo');
  assert(gameManager.useWand(slug, p1).ok === false, 'wand must be empty now');

  // A10: total 은 고정, rank 는 실시간
  {
    const live = gameManager.getSnapshot(slug)!;
    const b = live.boards['u1'];
    assert(b.total > b.remaining, `total(${b.total}) 이 remaining(${b.remaining}) 보다 커야 한다(이미 몇 쌍 지움)`);
    assert(b.total === startState.boards['u1'].total, 'total 은 변하면 안 된다');
    const me = live.players.find((p) => p.userId === 'u1')!;
    const other = live.players.find((p) => p.userId === 'u2')!;
    assert(me.rank === 1 && other.rank === 2, `실시간 등수가 틀렸다: u1 ${me.rank}, u2 ${other.rank}`);
  }

  // A9 준비: u2는 진행 중에 기권(플레이어 목록에는 남는다)
  gameManager.spectate(slug, p2);
  const afterForfeit = gameManager.getSnapshot(slug)!;
  assert(afterForfeit.players.length === 2, '기권해도 플레이어 목록에는 남는다');
  assert(afterForfeit.players.find((p) => p.userId === 'u2')!.forfeited === true, 'u2 기권 표시');

  // u1이 판을 전부 지운다(막히면 서버가 알아서 셔플)
  let guard = 0;
  for (;;) {
    const snap = gameManager.getSnapshot(slug);
    if (!snap || snap.phase !== 'playing') break;
    const b = snap.boards['u1'];
    const view: PickView = { cells: b.cells, cols: b.cols, rows: b.rows, nextNumber: b.nextNumber, keysLeft: b.keysLeft };
    let move = findAnyMove(view);
    if (!move) {
      // 보이는 수가 없으면 물음표를 엿본 뒤 그 심볼로 짝을 찾는다(v3: 숨김 타일도 pick 가능)
      const peekIdx = b.cells.findIndex((v) => v === MYSTERY);
      assert(peekIdx >= 0, `no move and no mystery tile with ${b.remaining} left`);
      const ack = gameManager.peek(slug, p1, peekIdx);
      assert(ack.ok === true, 'peek failed mid-game');
      const symbol = (ack as { ok: true; symbol: number }).symbol;
      const cells = b.cells.slice();
      cells[peekIdx] = symbol;
      move = findAnyMove({ ...view, cells });
      if (!move) {
        // 엿본 심볼로도 짝이 없으면 다른 물음표를 계속 열어 본다
        for (let i = 0; i < cells.length && !move; i++) {
          if (cells[i] !== MYSTERY) continue;
          const one = gameManager.peek(slug, p1, i);
          if (!one.ok) continue;
          cells[i] = one.symbol;
          move = findAnyMove({ ...view, cells });
        }
      }
      assert(move !== null, `no move even after peeking everything (${b.remaining} left)`);
    }
    const ack = gameManager.pick(slug, p1, move![0], move![1]);
    assert(ack.ok === true, `pick rejected: ${JSON.stringify(ack)} (remaining ${b.remaining})`);
    assert(++guard < 400, 'play loop did not terminate');
  }

  const done = gameManager.getSnapshot(slug)!;
  assert(done.phase === 'finished', `phase ${done.phase}`);
  assert(done.results![0].userId === 'u1', 'winner must be u1');
  assert(done.scoreboard.find((r) => r.userId === 'u1')!.wins === 1, 'scoreboard wins not recorded');

  const rematched = gameManager.rematch(slug, p1);
  assert('state' in rematched && (rematched as any).state.phase === 'lobby', 'rematch must return to lobby');
  const lobbyAgain = gameManager.getSnapshot(slug)!;
  assert(lobbyAgain.players.length === 2, `리매치 후 플레이어 ${lobbyAgain.players.length}명 (2명이어야 함)`);
  assert(
    lobbyAgain.players.every((p) => !p.forfeited && p.finishedAt === null && p.score === 0 && p.combo === 0),
    '리매치는 기권/점수/콤보를 전부 리셋해야 한다'
  );
  assert(lobbyAgain.players.every((p) => p.items.hint === 3 && p.items.wand === 1), '리매치는 아이템도 리셋');
  assert(lobbyAgain.spectators.length === 0, '리매치 후 관전자로 내려간 사람이 없어야 한다');
  gameManager.onParticipantLeft(slug, 'u2', false);
  gameManager.onParticipantLeft(slug, 'u1', false);
  assert(gameManager.getSnapshot(slug) === null, 'game must be deleted when no players remain');
  gameManager.destroy(slug);

  // v2.1: 모든 판 변경 델타에 movesLeft가 실려야 하고, movesLeft 0 + 타일 잔여면 바로 재배치돼야 한다.
  const deltaEvents = ['game:matched', 'game:unlocked', 'game:shuffled'];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!deltaEvents.includes(e.event)) continue;
    assert(typeof e.payload.movesLeft === 'number', `${e.event} has no movesLeft`);
    const patch = e.payload.board;
    assert(
      patch &&
        typeof patch.remaining === 'number' &&
        typeof patch.total === 'number' &&
        typeof patch.nextNumber === 'number' &&
        typeof patch.keysLeft === 'number' &&
        typeof patch.movesLeft === 'number',
      `${e.event} has no board patch`
    );
    if (e.event !== 'game:matched' || e.payload.remaining === 0 || e.payload.movesLeft > 0) continue;
    const follow = events.slice(i + 1, i + 5).map((x) => x.event);
    assert(
      follow.includes('game:shuffled') || follow.includes('game:matched'),
      `movesLeft=0 with ${e.payload.remaining} tiles left but no auto-shuffle followed (${follow.join(',')})`
    );
  }
  // A5: 열쇠 쌍을 지운 matched 델타는 이미 keysLeft=0 을 싣고 있어야 한다(다음 스냅샷까지 기다리면 안 됨)
  const unlockAt = events.findIndex((e) => e.event === 'game:unlocked');
  assert(unlockAt > 0, 'no unlock event');
  const keyMatch = events.slice(0, unlockAt).reverse().find((e) => e.event === 'game:matched');
  assert(keyMatch!.payload.board.keysLeft === 0, 'matched delta still reports keysLeft=1 after the key pair');
  assert(events[unlockAt].payload.board.keysLeft === 0, 'unlocked delta must report keysLeft=0');

  const unlocked = events.filter((e) => e.event === 'game:unlocked');
  const revealedEvents = events.filter((e) => e.event === 'game:revealed');
  assert(unlocked.length === 1, `expected exactly one unlock broadcast, got ${unlocked.length}`);
  assert(unlocked[0].payload.tiles.length > 0, 'unlock payload must list the revealed symbols');
  assert(revealedEvents.length === 0, 'v4: game:revealed 브로드캐스트는 없어야 한다');
  let lastSeq = -1;
  for (const e of events) {
    const seq = e.event === 'game:state' ? e.payload.state?.seq : e.payload.seq;
    if (typeof seq !== 'number') continue;
    assert(seq > lastSeq, `seq went backwards at ${e.event}: ${seq} after ${lastSeq}`);
    lastSeq = seq;
  }
  const system = events.filter((e) => e.event === 'game:matched' && e.payload.userId === 'system').length;
  return `${events.filter((e) => e.event === 'game:matched').length} matched (system ${system}), seq monotonic`;
}

async function coopFlow(): Promise<string> {
  const slug = `selfcheck-coop-${Date.now()}`;
  const events: { event: string; payload: any }[] = [];
  gameManager.setBroadcast((_slug, event, payload) => events.push({ event, payload }));
  const p1 = { userId: 'c1', nickname: '하나' };
  const p2 = { userId: 'c2', nickname: '두울' };

  gameManager.create(slug, p1, { mode: 'coop', options: { boardSize: 's', items: true, specials: { numbers: true, walls: true } } });
  gameManager.join(slug, p2);
  const lobby = gameManager.getSnapshot(slug)!;
  assert(lobby.options.items === false, '협동에는 아이템이 없어야 한다');
  assert(lobby.players.every((p) => p.boardId === 'shared'), 'coop players must share one board');

  gameManager.setReady(slug, p2, true); // §Z3
  gameManager.start(slug, p1);
  await sleep(3200);
  const playing = gameManager.getSnapshot(slug)!;
  assert(Object.keys(playing.boards).join(',') === 'shared', `coop boards: ${Object.keys(playing.boards)}`);
  assert(playing.boards.shared.nextNumber === 1, 'numbers:true must start at nextNumber 1');
  assert(playing.boards.shared.cells.some((v) => v === WALL), 'walls:true must place walls');
  assert(playing.players.every((p) => p.items.hint === 5 && p.items.shuffle === 3 && p.items.wand === 2), '쟁탈전 아이템은 공유 카운트');
  assert(gameManager.useShuffle(slug, p2).ok === true, 'coop F2 failed');
  assert(
    gameManager.getSnapshot(slug)!.players.every((p) => p.items.shuffle === 2),
    '쟁탈전 아이템은 전원에 미러돼야 한다'
  );

  // 숫자 순서 위반 → 'order'
  const b0 = gameManager.getSnapshot(slug)!.boards.shared;
  const wrong: number[] = [];
  for (let i = 0; i < b0.cells.length && wrong.length < 2; i++) {
    if (b0.cells[i] === NUMBER_BASE + 2) wrong.push(i);
  }
  if (wrong.length === 2) {
    const ack = gameManager.pick(slug, p1, wrong[0], wrong[1]);
    assert(ack.ok === false && ack.reason === 'order', `expected order, got ${JSON.stringify(ack)}`);
  }

  let turn = 0;
  for (let guard = 0; guard < 400; guard++) {
    const snap = gameManager.getSnapshot(slug);
    if (!snap || snap.phase !== 'playing') break;
    const b = snap.boards.shared;
    const move = findAnyMove({ cells: b.cells, cols: b.cols, rows: b.rows, nextNumber: b.nextNumber, keysLeft: b.keysLeft });
    assert(move !== null, `shared board stuck with ${b.remaining}`);
    const who = turn++ % 2 === 0 ? p1 : p2;
    assert(gameManager.pick(slug, who, move![0], move![1]).ok === true, 'coop pick rejected');
  }

  // A5: 숫자 쌍을 지운 matched 델타가 바로 다음 nextNumber를 싣고 있어야 한다
  const numberMatches = events.filter(
    (e) => e.event === 'game:matched' && typeof e.payload.board?.nextNumber === 'number'
  );
  let sawNumberAdvance = false;
  for (let i = 1; i < numberMatches.length; i++) {
    const prev = numberMatches[i - 1].payload.board.nextNumber;
    const cur = numberMatches[i].payload.board.nextNumber;
    if (cur !== prev) sawNumberAdvance = true;
    assert(cur === prev || cur === prev + 1 || cur === 0, `nextNumber jumped ${prev} → ${cur}`);
  }
  assert(sawNumberAdvance, 'nextNumber never advanced in the matched deltas');

  const done = gameManager.getSnapshot(slug)!;
  assert(done.phase === 'finished', `phase ${done.phase}`);
  const [r1, r2] = done.results!;
  assert(r1.timeMs !== null && r1.timeMs === r2.timeMs, '협동 결과는 모든 행이 같은 팀 기록');
  assert(done.scoreboard.every((r) => r.wins === 0 && r.games === 1), 'coop은 games만 올라간다');
  gameManager.destroy(slug);
  return `team ${r1.timeMs}ms, ${r1.pairsCleared}+${r2.pairsCleared} pairs`;
}

// --- §Z3 준비(레디) 시스템 -------------------------------------------------

const RHOST = { userId: 'r1', nickname: '방장' };
const RP2 = { userId: 'r2', nickname: '두울' };
const RP3 = { userId: 'r3', nickname: '세엣' };
let readySeq = 0;

/** 준비 검사용 테트리스 대전 로비 하나. 쓰고 나면 반드시 destroy(타이머 정리). */
function readyLobby(joiners: { userId: string; nickname: string }[] = [RP2]): string {
  const slug = `selfcheck-ready-${Date.now()}-${++readySeq}`;
  gameManager.create(slug, RHOST, { gameId: 'tetris', tetris: { mode: 'versus' } });
  for (const j of joiners) gameManager.join(slug, j);
  return slug;
}

const readyOf = (slug: string, userId: string) =>
  gameManager.getSnapshot(slug)!.players.find((p) => p.userId === userId)?.ready;

/** 로비 하나를 만들어 fn 을 돌리고 무조건 치운다. */
function withLobby(fn: (slug: string) => string | void, joiners = [RP2]): string | void {
  const slug = readyLobby(joiners);
  try {
    return fn(slug);
  } finally {
    gameManager.destroy(slug);
  }
}

function checkReadyRules(): void {
  check('§Z3 — 미준비자가 있으면 시작 거절, 전원 준비하면 허용', () =>
    withLobby((slug) => {
      assert(gameManager.getSnapshot(slug)!.players.every((p) => p.ready === false), '기본값은 미준비');
      const blocked = gameManager.start(slug, RHOST);
      assert(
        'error' in blocked && blocked.error === '아직 준비하지 않은 사람이 있어요',
        `거절 메시지가 다르다: ${JSON.stringify(blocked)}`
      );
      assert('state' in gameManager.setReady(slug, RP2, true), '준비 실패');
      assert(readyOf(slug, 'r2') === true, '스냅샷에 ready 가 실려야 한다');
      const ok = gameManager.start(slug, RHOST);
      assert('state' in ok && ok.state.phase === 'countdown', `전원 준비 후 시작 실패: ${JSON.stringify(ok)}`);
    })
  );

  check('§Z3 — 방장 혼자면 준비 없이 시작 (시작 버튼이 곧 동의)', () =>
    withLobby((slug) => {
      const ok = gameManager.start(slug, RHOST);
      assert('state' in ok && ok.state.phase === 'countdown', `혼자 시작 실패: ${JSON.stringify(ok)}`);
    }, [])
  );

  check('§Z3 — 시작하면 준비가 전부 풀린다', () =>
    withLobby((slug) => {
      gameManager.setReady(slug, RP2, true);
      gameManager.start(slug, RHOST);
      assert(
        gameManager.getSnapshot(slug)!.players.every((p) => !p.ready),
        '시작 후에도 ready 가 남아 있다'
      );
    })
  );

  check('§Z3 — 플레이어 입장 시 준비 해제', () =>
    withLobby((slug) => {
      gameManager.setReady(slug, RP2, true);
      gameManager.join(slug, RP3);
      assert(readyOf(slug, 'r2') === false, '입장하면 전원 준비가 풀려야 한다');
      assert(readyOf(slug, 'r3') === false, '새로 들어온 사람도 미준비');
    })
  );

  check('§Z3 — 퇴장 시 준비 해제', () =>
    withLobby((slug) => {
      gameManager.setReady(slug, RP2, true);
      gameManager.setReady(slug, RP3, true);
      gameManager.onParticipantLeft(slug, 'r3', false);
      assert(gameManager.getSnapshot(slug)!.players.length === 2, '퇴장이 반영되지 않았다');
      assert(readyOf(slug, 'r2') === false, '누가 나가면 준비가 풀려야 한다');
    }, [RP2, RP3])
  );

  check('§Z3 — 관전 전환 시 준비 해제', () =>
    withLobby((slug) => {
      gameManager.setReady(slug, RP2, true);
      gameManager.setReady(slug, RP3, true);
      gameManager.spectate(slug, RP3);
      assert(gameManager.getSnapshot(slug)!.spectators.length === 1, '관전자로 안 내려갔다');
      assert(readyOf(slug, 'r2') === false, '관전 전환에도 준비가 풀려야 한다');
    }, [RP2, RP3])
  );

  check('§Z3 — 옵션·모드·게임 변경 시 준비 해제', () =>
    withLobby((slug) => {
      gameManager.setReady(slug, RP2, true);
      gameManager.updateOptions(slug, RHOST, { tetris: { startLevel: 5 } });
      assert(readyOf(slug, 'r2') === false, '테트리스 옵션 변경에 안 풀렸다');
      gameManager.setReady(slug, RP2, true);
      gameManager.updateOptions(slug, RHOST, { gameId: 'shisen' });
      assert(readyOf(slug, 'r2') === false, '게임 변경에 안 풀렸다');
      gameManager.setReady(slug, RP2, true);
      gameManager.updateOptions(slug, RHOST, { mode: 'coop' });
      assert(readyOf(slug, 'r2') === false, '모드 변경에 안 풀렸다');
      gameManager.setReady(slug, RP2, true);
      gameManager.updateOptions(slug, RHOST, { options: { difficulty: 5 } });
      assert(readyOf(slug, 'r2') === false, '사천성 옵션 변경에 안 풀렸다');
    })
  );

  check('§Z3 — 값이 실제로 안 바뀌면 준비는 유지된다', () =>
    withLobby((slug) => {
      gameManager.updateOptions(slug, RHOST, { tetris: { startLevel: 5, ghost: false } });
      gameManager.setReady(slug, RP2, true);
      gameManager.updateOptions(slug, RHOST, { tetris: { startLevel: 5, ghost: false } });
      assert(readyOf(slug, 'r2') === true, '같은 값 재전송으로 준비가 풀리면 안 된다');
      gameManager.updateOptions(slug, RHOST, {}); // 빈 패치
      assert(readyOf(slug, 'r2') === true, '빈 패치로도 풀리면 안 된다');
      gameManager.updateOptions(slug, RHOST, { gameId: 'tetris' }); // 이미 테트리스
      assert(readyOf(slug, 'r2') === true, '같은 게임을 다시 골라도 풀리면 안 된다');
      // 클램프로 같은 값이 되는 경우도 변경이 아니다 (startLevel 최대 10)
      gameManager.updateOptions(slug, RHOST, { tetris: { startLevel: 5.4 } });
      assert(readyOf(slug, 'r2') === true, '보정 결과가 같으면 변경이 아니다');
    })
  );

  check('§Z3 — 로비가 아니면 setReady 거절', () =>
    withLobby((slug) => {
      gameManager.setReady(slug, RP2, true);
      gameManager.start(slug, RHOST); // countdown
      const res = gameManager.setReady(slug, RP2, true);
      assert('error' in res, `카운트다운 중 준비는 거절해야 한다: ${JSON.stringify(res)}`);
    })
  );

  check('§Z3 — 플레이어가 아닌 사람(관전자)의 setReady 거절', () =>
    withLobby((slug) => {
      gameManager.spectate(slug, RP3); // 참가한 적 없는 사람 → 관전자
      assert('error' in gameManager.setReady(slug, RP3, true), '관전자는 준비할 수 없다');
      assert('error' in gameManager.setReady(slug, { userId: 'nobody', nickname: '외부인' }, true), '외부인도 거절');
    })
  );
}

/**
 * 종료 후 자동 로비 복귀 (§Z3). 12초를 그대로 기다리지 않도록 지연을 주입한다
 * (__setLobbyReturnDelayMs — 셀프체크 전용, 0 을 주면 기본 12초로 복귀).
 */
async function autoLobbyFlow(): Promise<string> {
  const AUTO_MS = 400;
  __setLobbyReturnDelayMs(AUTO_MS);
  const slug = readyLobby();
  try {
    const snap = () => gameManager.getSnapshot(slug)!;
    gameManager.setReady(slug, RP2, true);
    gameManager.start(slug, RHOST);
    await sleep(3200);
    assert(snap().phase === 'playing', 'playing 으로 못 넘어감');
    gameManager.tetrisFrame(slug, RP2, tframe({ lines: 5, score: 300 }));
    gameManager.tetrisTopout(slug, RP2); // 2인 대전이라 한 명 탈락 = 종료
    const fin = snap();
    assert(fin.phase === 'finished', `phase ${fin.phase}`);
    assert(fin.results !== null && fin.results.length === 2, '결과가 있어야 한다');
    assert('error' in gameManager.setReady(slug, RHOST, true), '종료 화면에서도 준비는 거절');
    const wins = fin.scoreboard.find((r) => r.userId === 'r1')?.wins ?? 0;
    assert(wins === 1, `승수 집계 ${wins}`);

    await sleep(AUTO_MS + 400);
    const back = snap();
    assert(back.phase === 'lobby', `자동 복귀 실패 (phase ${back.phase})`);
    assert(back.results === null, '로비로 돌아오면 결과는 비워야 한다');
    assert(back.endedAt === null && back.startAt === null, '복귀 시 시각도 비운다');
    assert(Object.keys(back.boards).length === 0, '복귀 시 보드도 정리해야 한다');
    assert(back.players.every((p) => !p.ready), '복귀 시 준비 전원 해제');
    assert(back.players.every((p) => p.score === 0 && p.lines === 0 && !p.forfeited), '복귀 시 점수/줄/기권 리셋');
    assert(back.scoreboard.find((r) => r.userId === 'r1')?.wins === wins, '누적 전적은 복귀해도 유지돼야 한다');
    // 복귀했으니 다시 준비를 받아야 시작된다
    assert('error' in gameManager.start(slug, RHOST), '복귀 직후에는 미준비라 시작 거절');
    return `auto return in ${AUTO_MS}ms (운영 12s)`;
  } finally {
    __setLobbyReturnDelayMs(0);
    gameManager.destroy(slug);
  }
}

/** rematch = 즉시 재시작이 아니라 로비 복귀, 누구나 호출 가능 (§Z3). */
async function manualLobbyFlow(): Promise<string> {
  const AUTO_MS = 400;
  __setLobbyReturnDelayMs(AUTO_MS);
  const events: { event: string; payload: any }[] = [];
  gameManager.setBroadcast((_slug, event, payload) => events.push({ event, payload }));
  const slug = readyLobby();
  try {
    const snap = () => gameManager.getSnapshot(slug)!;
    gameManager.setReady(slug, RP2, true);
    gameManager.start(slug, RHOST);
    await sleep(3200);
    gameManager.tetrisTopout(slug, RP2);
    assert(snap().phase === 'finished', '판이 안 끝났다');

    const rm = gameManager.rematch(slug, RP2); // 방장이 아닌 사람
    assert('state' in rm, `비방장도 로비로 보낼 수 있어야 한다: ${JSON.stringify(rm)}`);
    assert((rm as any).state.phase === 'lobby', 'rematch 는 즉시 재시작이 아니라 로비 복귀');
    assert((rm as any).state.results === null, 'rematch 후 결과는 비어야 한다');
    assert(snap().players.every((p) => !p.ready), 'rematch 후 준비 해제');
    assert('error' in gameManager.rematch(slug, RHOST), '로비에서 또 부르면 거절');

    // 수동 복귀했으면 자동 복귀 타이머는 취소돼 있어야 한다(추가 방송이 없어야 한다)
    const n = events.length;
    await sleep(AUTO_MS + 400);
    assert(events.length === n, `수동 복귀 후에도 자동 타이머가 살아 있다 (+${events.length - n})`);
    assert(snap().phase === 'lobby', '여전히 로비여야 한다');
    return `${events.filter((e) => e.event === 'game:state').length} state broadcasts`;
  } finally {
    __setLobbyReturnDelayMs(0);
    gameManager.destroy(slug);
  }
}

async function main(): Promise<void> {
  await checkAsync('gameManager — 레이스 2인(옵션 부분병합·특수타일·reveal·unlock·결과)', managerFlow);
  await checkAsync('gameManager — 협동 한 판(공유 보드·숫자 순서·벽·팀 기록)', coopFlow);
  await checkAsync('테트리스 — 3인 대전 한 판(옵션·프레임 릴레이·선두 타격·KO·등수)', tetrisVersusFlow);
  await checkAsync('테트리스 — 2인 레이스 한 판(완주 시간 정렬·전적 기록)', tetrisSprintFlow);
  checkReadyRules();
  await checkAsync('§Z3 — 종료 12초 뒤 자동 로비 복귀(결과 비움·전적 유지·준비 해제)', autoLobbyFlow);
  await checkAsync('§Z3 — rematch 는 로비 복귀(누구나)·자동 타이머 취소', manualLobbyFlow);

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('all checks PASS');
  process.exit(0);
}

void main();
