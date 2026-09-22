// 사천성 엔진/매니저 셀프체크 (v1 §1 + v2 §V3/§V6). 실행: npx tsx src/games/__selfcheck__.ts
// DB·소켓 의존 없음. 모든 검사가 PASS여야 하고, 하나라도 FAIL이면 exit code 1.

import {
  PickView,
  Shape,
  buildMask,
  canPick,
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
  GameOptions,
  GameSnapshot,
  KEY_SYMBOL,
  NUMBER_BASE,
  Point,
  SpecialToggles,
  WALL,
  isNormalSymbol,
} from './types';
import { gameManager } from './gameManager';

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
  locked: Set<number>;
  nextNumber: number;
  maxNumber: number;
  keysLeft: number;
}

function makeBoard(size: BoardSize, shape: Shape, specials: SpecialToggles, seed: number) {
  const { cols, rows } = BOARD_DIMS[size];
  const rng = mulberry32(seed);
  const mask = buildMask(shape, cols, rows, rng, specials.keys ? 2 : 0);
  const numbers = specials.numbers ? NUMBERS_PER_SIZE[size] : 0;
  const gen = generateBoardV2(
    { cols, rows, mask, walls: specials.walls, numbers, keys: specials.keys, mystery: specials.mystery },
    rng
  );
  const board: SimBoard = {
    cols,
    rows,
    cells: gen.cells.slice(),
    hidden: new Set(gen.hidden),
    locked: new Set(gen.locked),
    nextNumber: numbers > 0 ? 1 : 0,
    maxNumber: numbers,
    keysLeft: specials.keys ? 1 : 0,
  };
  return { board, mask, gen, rng };
}

const clientView = (b: SimBoard): PickView => ({
  cells: maskForClient(b.cells, b.hidden, b.locked),
  cols: b.cols,
  rows: b.rows,
  nextNumber: b.nextNumber,
  keysLeft: b.keysLeft,
});
const stuckView = (b: SimBoard): PickView => ({
  cells: maskForClient(b.cells, [], b.locked),
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
    b.locked.delete(idx);
  }
  for (const idx of [a, c]) {
    const r = (idx / b.cols) | 0;
    const col = idx % b.cols;
    const nbs = [r > 0 ? idx - b.cols : -1, r < b.rows - 1 ? idx + b.cols : -1, col > 0 ? idx - 1 : -1, col < b.cols - 1 ? idx + 1 : -1];
    for (const nb of nbs) if (nb >= 0) b.hidden.delete(nb);
  }
  if (value === KEY_SYMBOL) {
    b.keysLeft = 0;
    b.locked.clear();
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
  if (specials.keys && (counts.get(KEY_SYMBOL) ?? 0) !== 2) return { ok: false, detail: 'key pair missing' };
  if (specials.numbers) {
    for (let n = 1; n <= NUMBERS_PER_SIZE[size]; n++) {
      if ((counts.get(NUMBER_BASE + n) ?? 0) !== 2) return { ok: false, detail: `number ${n} pair missing` };
    }
  }

  for (const [a, b] of gen.order) {
    // 물음표는 클릭 한 번으로 공개된다(선택으로 치지 않음) → 재생에서도 먼저 공개
    board.hidden.delete(a);
    board.hidden.delete(b);
    const reason = canPick(clientView(board), a, b);
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
            let move = findAnyMove(stuckView(board));
            if (!move) {
              // 서버와 동일한 순서: 일반 심볼 셔플 → 그래도 없으면 시스템 제거
              board.cells = shuffleNormals(
                { ...stuckView(board), cells: board.cells },
                board.hidden,
                board.locked,
                rng
              );
              stuckShuffles++;
              move = findAnyMove(stuckView(board));
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
                if (board.keysLeft > 0) blocker = pickPair((v) => v === KEY_SYMBOL);
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
            const reason = canPick(stuckView(board), move[0], move[1]);
            assert(reason === null, `findAnyMove returned an illegal pair (${reason})`);
            assert(findAllMoves(stuckView(board)).length > 0, 'findAllMoves disagrees with findAnyMove');
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
        const move = findAnyMove(stuckView(board));
        if (!move) break;
        removePair(board, move[0], move[1]);
      }
      const before = board.cells.slice();
      const next = shuffleNormals({ ...stuckView(board), cells: board.cells }, board.hidden, board.locked, rng);
      for (let idx = 0; idx < before.length; idx++) {
        const wasNormal = isNormalSymbol(before[idx]);
        if (!wasNormal) assert(next[idx] === before[idx], `special/wall tile moved at ${idx}`);
        else assert(isNormalSymbol(next[idx]), `normal tile replaced by a special at ${idx}`);
      }
      const sortNormals = (arr: number[]) => arr.filter(isNormalSymbol).sort((a, b) => a - b).join(',');
      assert(sortNormals(before) === sortNormals(next), 'normal symbol multiset changed');
      board.cells = next;
      assert(findAnyMove(stuckView(board)) !== null, 'no move after shuffle');
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

check('canPick — 벽/자물쇠/물음표/숫자 순서 사유', () => {
  const view = (cells: number[], nextNumber = 0): PickView => ({ cells, cols: 4, rows: 2, nextNumber, keysLeft: 0 });
  const WALLED = [WALL, 1, 0, 0, 1, 0, 0, 0];
  assert(canPick(view(WALLED), 0, 1) === 'wall', 'wall reason');
  assert(canPick(view([98, 0, 0, 0, 98, 0, 0, 0]), 0, 4) === 'locked', 'locked reason');
  assert(canPick(view([99, 0, 0, 0, 99, 0, 0, 0]), 0, 4) === 'hidden', 'hidden reason');
  assert(canPick(view([1, 0, 0, 0, 2, 0, 0, 0]), 0, 4) === 'symbol', 'symbol reason');
  assert(canPick(view([1, 0, 0, 0, 0, 0, 0, 0]), 0, 4) === 'gone', 'gone reason');
  assert(canPick(view([1, 0, 0, 0, 1, 0, 0, 0]), 2, 2) === 'same', 'same reason');
  const numbers = [NUMBER_BASE + 2, 0, 0, 0, NUMBER_BASE + 2, 0, 0, 0];
  assert(canPick(view(numbers, 1), 0, 4) === 'order', 'order reason');
  assert(canPick(view(numbers, 2), 0, 4) === null, 'nextNumber pair must be allowed');
  assert(canPick(view([1, 0, 0, 0, 1, 0, 0, 0]), 0, 4) === null, 'plain pair must be allowed');
  return '8 cases';
});

// --- 6. gameManager 한 판 흐름 ----------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  assert(afterCoop.mapShape === 'diamond', '모드 전환에서 mapShape가 날아갔다');
  assert(afterCoop.specials.keys && afterCoop.specials.mystery, '모드 전환에서 specials가 날아갔다');
  assert(afterCoop.boardSize === 'l' && afterCoop.timeLimitSec === 0, '모드 기본값(판 크기/제한 시간) 미적용');
  assert(afterCoop.items === false, 'coop은 items=false 강제');
  gameManager.updateOptions(slug, p1, { mode: 'race', options: { boardSize: 's', items: true, timeLimitSec: 120 } });
  const backToRace = gameManager.getSnapshot(slug)!.options;
  assert(backToRace.mapShape === 'diamond' && backToRace.specials.mystery, '되돌릴 때도 유지돼야 한다');
  assert(backToRace.boardSize === 's' && backToRace.items, 'patch가 모드 기본값을 덮어써야 한다');
  assert('error' in gameManager.start(slug, p2), 'non-host start must fail');

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
  assert(startState.boards['u1'].keysLeft === 1, 'keysLeft not reported');
  assert(startState.boards['u1'].movesLeft > 0, 'movesLeft missing in snapshot');
  assert(gameManager.pick(slug, p1, 0, 1).ok === false, 'pick before startAt must be rejected');

  await sleep(3200); // 카운트다운

  // 물음표 타일은 reveal 해야 고를 수 있다
  const snap1 = gameManager.getSnapshot(slug)!;
  const mysteryIdx = snap1.boards['u1'].cells.findIndex((v) => v === 99);
  assert(mysteryIdx >= 0, 'mystery tiles should exist with mystery:true');
  const lockedIdx = snap1.boards['u1'].cells.findIndex((v) => v === 98);
  assert(lockedIdx >= 0, 'locked tiles should exist with keys:true');
  const revealed = gameManager.reveal(slug, p1, mysteryIdx);
  assert(revealed.ok === true, 'reveal failed');
  assert(gameManager.getSnapshot(slug)!.boards['u1'].cells[mysteryIdx] !== 99, 'tile still masked after reveal');

  // 자물쇠는 선택 불가
  const otherLocked = gameManager.getSnapshot(slug)!.boards['u1'].cells.findIndex((v, i) => v === 98 && i !== lockedIdx);
  const lockedPick = gameManager.pick(slug, p1, lockedIdx, otherLocked);
  assert(lockedPick.ok === false && lockedPick.reason === 'locked', `expected locked, got ${JSON.stringify(lockedPick)}`);

  // u1이 판을 전부 지운다(막히면 서버가 알아서 셔플)
  let guard = 0;
  for (;;) {
    const snap = gameManager.getSnapshot(slug);
    if (!snap || snap.phase !== 'playing') break;
    const b = snap.boards['u1'];
    const view: PickView = { cells: b.cells, cols: b.cols, rows: b.rows, nextNumber: b.nextNumber, keysLeft: b.keysLeft };
    let move = findAnyMove(view);
    if (!move) {
      // 보이는 수가 없으면 물음표를 하나 열어 본다
      const hiddenIdx = b.cells.findIndex((v) => v === 99);
      assert(hiddenIdx >= 0, `no move and no mystery tile with ${b.remaining} left`);
      assert(gameManager.reveal(slug, p1, hiddenIdx).ok === true, 'reveal failed mid-game');
      assert(++guard < 400, 'play loop did not terminate');
      continue;
    }
    const ack = gameManager.pick(slug, p1, move[0], move[1]);
    assert(ack.ok === true, `pick rejected: ${JSON.stringify(ack)} (remaining ${b.remaining})`);
    assert(++guard < 400, 'play loop did not terminate');
  }

  const done = gameManager.getSnapshot(slug)!;
  assert(done.phase === 'finished', `phase ${done.phase}`);
  assert(done.results![0].userId === 'u1', 'winner must be u1');
  assert(done.scoreboard.find((r) => r.userId === 'u1')!.wins === 1, 'scoreboard wins not recorded');

  const rematched = gameManager.rematch(slug, p1);
  assert('state' in rematched && (rematched as any).state.phase === 'lobby', 'rematch must return to lobby');
  gameManager.onParticipantLeft(slug, 'u2', false);
  gameManager.onParticipantLeft(slug, 'u1', false);
  assert(gameManager.getSnapshot(slug) === null, 'game must be deleted when no players remain');
  gameManager.destroy(slug);

  // v2.1: 모든 판 변경 델타에 movesLeft가 실려야 하고, movesLeft 0 + 타일 잔여면 바로 재배치돼야 한다.
  const deltaEvents = ['game:matched', 'game:revealed', 'game:unlocked', 'game:shuffled'];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!deltaEvents.includes(e.event)) continue;
    assert(typeof e.payload.movesLeft === 'number', `${e.event} has no movesLeft`);
    const patch = e.payload.board;
    assert(
      patch &&
        typeof patch.remaining === 'number' &&
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
  assert(revealedEvents.length > 0, 'expected reveal broadcasts');
  let lastSeq = -1;
  for (const e of events) {
    const seq = e.event === 'game:state' ? e.payload.state?.seq : e.payload.seq;
    if (typeof seq !== 'number') continue;
    assert(seq > lastSeq, `seq went backwards at ${e.event}: ${seq} after ${lastSeq}`);
    lastSeq = seq;
  }
  const system = events.filter((e) => e.event === 'game:matched' && e.payload.userId === 'system').length;
  return `${events.filter((e) => e.event === 'game:matched').length} matched (system ${system}), ${revealedEvents.length} revealed, seq monotonic`;
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

  gameManager.start(slug, p1);
  await sleep(3200);
  const playing = gameManager.getSnapshot(slug)!;
  assert(Object.keys(playing.boards).join(',') === 'shared', `coop boards: ${Object.keys(playing.boards)}`);
  assert(playing.boards.shared.nextNumber === 1, 'numbers:true must start at nextNumber 1');
  assert(playing.boards.shared.cells.some((v) => v === WALL), 'walls:true must place walls');
  assert(playing.players.every((p) => p.hintsLeft === 5), '협동 힌트는 5회 공유');

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

async function main(): Promise<void> {
  await checkAsync('gameManager — 레이스 2인(옵션 부분병합·특수타일·reveal·unlock·결과)', managerFlow);
  await checkAsync('gameManager — 협동 한 판(공유 보드·숫자 순서·벽·팀 기록)', coopFlow);

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('all checks PASS');
  process.exit(0);
}

void main();
