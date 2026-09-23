// 테트리스 엔진 셀프체크 (docs/games/tetris-design.md §T4). 실행: npx tsx src/games/tetris/__selfcheck__.ts
// DOM·소켓·스토어 의존 없음. 모든 검사가 PASS여야 하고, 하나라도 FAIL이면 exit code 1.
//
// 판을 세울 때는 문자열 한 줄 = 한 행('#' = 채움, '.' = 빈칸)으로 적는다. y 는 **필드 절대 행**이라
// 바닥이 21(FIELD_ROWS-1), 보이는 첫 행이 2(HIDDEN_ROWS)다.

import {
  CELL_ACTIVE_BASE,
  CELL_GARBAGE,
  CELL_GHOST,
  COLS,
  DEFAULT_TETRIS_OPTIONS,
  FIELD_ROWS,
  ROWS,
} from './types';
import type { PieceId, TetrisOptions } from './types';
import { KICKS, SHAPES, kicksFor } from './srs';
import type { Rot } from './srs';
import {
  GRAVITY_MS,
  LOCK_DELAY_MS,
  MAX_LOCK_RESETS,
  applyGarbage,
  canPlace,
  createState,
  ghostY,
  gravityMs,
  hardDrop,
  holdPiece,
  mulberry32,
  pendingCount,
  queueGarbage,
  spawn,
  tick,
  toCells,
  tryMove,
  tryRotate,
} from './engine';
import type { TetrisState } from './engine';

// --- 러너 -----------------------------------------------------------------

let pass = 0;
let total = 0;

function eq(name: string, fn: () => unknown, expected: unknown): void {
  total++;
  let actual: unknown;
  try {
    actual = fn();
  } catch (err: unknown) {
    actual = `throw: ${(err as Error)?.message || String(err)}`;
  }
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    console.log(`✗ ${name} (기대 ${e}, 실제 ${a})`);
  }
}

function ok(name: string, fn: () => unknown): void {
  eq(name, () => !!fn(), true);
}

// --- 판 조작 헬퍼 ---------------------------------------------------------

function options(over?: Partial<TetrisOptions>): TetrisOptions {
  return { ...DEFAULT_TETRIS_OPTIONS.versus, ...over };
}
function mk(seed = 1, over?: Partial<TetrisOptions>): TetrisState {
  return createState(seed, options(over));
}
/** rows[절대행] = '##...' 패턴으로 필드를 채운다. 채운 칸은 쓰레기 색(8)로 둔다 */
function setRows(s: TetrisState, rows: Record<number, string>): void {
  for (const key of Object.keys(rows)) {
    const y = Number(key);
    const pat = rows[Number(key)];
    for (let x = 0; x < COLS; x++) s.field[y * COLS + x] = pat[x] === '#' ? CELL_GARBAGE : 0;
  }
}
function rowStr(s: TetrisState, y: number): string {
  let out = '';
  for (let x = 0; x < COLS; x++) out += s.field[y * COLS + x] ? '#' : '.';
  return out;
}
function filledCount(s: TetrisState): number {
  let n = 0;
  for (let i = 0; i < s.field.length; i++) if (s.field[i]) n++;
  return n;
}
/** 조각을 강제로 놓는다(테스트 전용). 실제 게임에서는 spawn 이 유일한 입구다 */
function put(s: TetrisState, id: PieceId, rot: Rot, x: number, y: number): boolean {
  if (!canPlace(s.field, id, rot, x, y)) return false;
  s.piece = { id, rot, x, y };
  s.lowestY = y;
  s.lastWasRotate = false;
  s.lastKick = -1;
  s.lastKickFinal = false;
  s.lockTimer = 0;
  s.lockResets = 0;
  return true;
}
/** 필드를 통째로 비운다(연속 시나리오에서 앞선 판의 찌꺼기를 지우기 위해) */
function wipe(s: TetrisState): void {
  s.field.fill(0);
}
/** 더 못 내려갈 때까지 떨어뜨린다(락은 안 함) */
function fall(s: TetrisState): void {
  while (tryMove(s, 0, 1));
}
function takePieces(s: TetrisState, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    spawn(s);
    out.push(s.piece!.id);
  }
  return out;
}
/** 바닥 k줄을 "col 0만 빈" 상태로 채운다 → 세로 I 하나로 k줄을 지울 수 있는 판 */
function wellField(k: number): TetrisState {
  const s = mk();
  const rows: Record<number, string> = {};
  for (let i = 0; i < k; i++) rows[FIELD_ROWS - 1 - i] = '.#########';
  setRows(s, rows);
  return s;
}

// --- 1. 7-bag -------------------------------------------------------------

eq('mulberry32 — 같은 시드는 같은 수열', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  return [a(), a(), a()].join(',') === [b(), b(), b()].join(',');
}, true);

ok('createState — 필드는 22x10 이고 비어 있으며 레벨은 startLevel', () => {
  const s = mk(3, { startLevel: 4 });
  return s.field.length === COLS * FIELD_ROWS && filledCount(s) === 0
    && s.level === 4 && s.piece === null && s.alive && s.pending.length === 0;
});

eq('7-bag — 같은 시드는 같은 조각 순서', () => {
  const a = takePieces(mk(777), 21).join('');
  const b = takePieces(mk(777), 21).join('');
  return a === b;
}, true);

eq('7-bag — 연속 7개 안에 1..7 이 정확히 한 번씩', () => {
  const ids = takePieces(mk(2024), 35);
  for (let g = 0; g < 5; g++) {
    const seen = ids.slice(g * 7, g * 7 + 7).slice().sort().join('');
    if (seen !== '1234567') return `bag ${g} = ${seen}`;
  }
  return 'ok';
}, 'ok');

eq('7-bag — 다른 시드는 다른 조각 순서', () => {
  return takePieces(mk(1), 14).join('') !== takePieces(mk(2), 14).join('');
}, true);

eq('next 큐는 항상 5개 이상', () => {
  const s = mk(9, { nextCount: 1 });
  for (let i = 0; i < 30; i++) {
    spawn(s);
    if (s.next.length < 5) return `i=${i} len=${s.next.length}`;
  }
  return 'ok';
}, 'ok');

// --- 2. 조각 모양 / SRS 표 -------------------------------------------------

eq('SHAPES — 7종 4회전 모두 셀 4개(중복 없음)', () => {
  for (let id = 1 as PieceId; id <= 7; id = (id + 1) as PieceId) {
    for (let r = 0; r < 4; r++) {
      const cells = SHAPES[id][r];
      if (cells.length !== 4) return `id${id} rot${r} = ${cells.length}칸`;
      const uniq = new Set(cells.map((c) => `${c[0]},${c[1]}`));
      if (uniq.size !== 4) return `id${id} rot${r} 중복`;
      for (const c of cells) {
        if (c[0] < 0 || c[0] > 3 || c[1] < 0 || c[1] > 3) return `id${id} rot${r} 박스 밖`;
      }
    }
  }
  return 'ok';
}, 'ok');

eq('SHAPES — O는 회전해도 모양이 같다', () => {
  const key = (r: number) => SHAPES[4][r].map((c) => c.join(',')).sort().join(' ');
  return key(0) === key(1) && key(1) === key(2) && key(2) === key(3);
}, true);

eq('kicksFor — O는 킥이 없다', () => kicksFor(4, 0, 1), [[0, 0]]);

eq('kicksFor — JLSTZ 0→R 표(첫 오프셋 0,0 + 5개)', () => {
  const k = kicksFor(6, 0, 1);
  return [k.length, k[0], k[1], k[4]];
}, [5, [0, 0], [-1, 0], [-1, 2]]);

eq('kicksFor — I는 전용 표를 쓴다', () => {
  const i = kicksFor(1, 0, 1);
  const t = kicksFor(6, 0, 1);
  return [i[1], t[1], i !== t];
}, [[-2, 0], [-1, 0], true]);

eq('kicksFor — 180도(SRS+) 표도 있다', () => {
  const k = kicksFor(6, 0, 2);
  return [k.length, k[0], KICKS.i['13'].length];
}, [6, [0, 0], 6]);

// --- 3. 이동 / 회전 / 드롭 ------------------------------------------------

eq('tryMove — 왼쪽 벽 밖으로는 못 간다', () => {
  const s = mk();
  put(s, 4, 0, 3, 5);      // O = 4·5열
  let moved = 0;
  while (tryMove(s, -1, 0)) moved++;
  return [moved, s.piece!.x];
}, [4, -1]);

eq('I 벽차기 — 왼쪽 벽에 붙은 세로 I가 회전하면 킥으로 밀려난다', () => {
  const s = mk();
  put(s, 1, 1, -2, 10);    // 세로 I가 0열
  const okRot = tryRotate(s, 1);
  return [okRot, s.piece!.rot, s.piece!.x, s.lastKick];
}, [true, 2, 0, 2]);

eq('tryRotate — 180도 회전', () => {
  const s = mk();
  put(s, 6, 0, 3, 10);
  return [tryRotate(s, 2), s.piece!.rot];
}, [true, 2]);

eq('ghostY — 하드드롭 착지 위치와 같다', () => {
  const s = mk();
  setRows(s, { 21: '###....###', 20: '###.....##' });
  put(s, 6, 0, 3, 4);
  const g = ghostY(s);
  const shape = SHAPES[6][0].map((c) => [3 + c[0], g + c[1]]);
  hardDrop(s);
  const okCells = shape.every(([x, y]) => s.field[y * COLS + x] === 6);
  return [g, okCells, filledCount(s) - 11];
}, [20, true, 4]);

// --- 4. 줄 지움 -----------------------------------------------------------

eq('1줄 지움 = single', () => {
  const s = wellField(1);
  put(s, 1, 1, -2, 0);
  const r = hardDrop(s);
  return [r.cleared, r.kind, s.lines];
}, [1, 'single', 1]);

eq('2줄 지움 = double', () => {
  const s = wellField(2);
  put(s, 1, 1, -2, 0);
  const r = hardDrop(s);
  return [r.cleared, r.kind];
}, [2, 'double']);

eq('3줄 지움 = triple', () => {
  const s = wellField(3);
  put(s, 1, 1, -2, 0);
  const r = hardDrop(s);
  return [r.cleared, r.kind];
}, [3, 'triple']);

eq('4줄 지움 = tetris', () => {
  const s = wellField(4);
  put(s, 1, 1, -2, 0);
  const r = hardDrop(s);
  return [r.cleared, r.kind, r.rows];
}, [4, 'tetris', [16, 17, 18, 19]]);

eq('B2B — 테트리스 두 번 연속이면 두 번째가 b2b', () => {
  const s = wellField(4);
  put(s, 1, 1, -2, 0);
  const first = hardDrop(s);
  setRows(s, { 18: '.#########', 19: '.#########', 20: '.#########', 21: '.#########' });
  put(s, 1, 1, -2, 0);
  const second = hardDrop(s);
  return [first.b2b, second.b2b, s.b2b];
}, [false, true, 2]);

eq('B2B — 평범한 싱글이 체인을 끊는다', () => {
  const s = wellField(4);
  put(s, 1, 1, -2, 0);
  hardDrop(s);
  setRows(s, { 21: '.#########' });
  put(s, 1, 1, -2, 0);
  const single = hardDrop(s);
  return [single.b2b, s.b2b];
}, [false, 0]);

eq('콤보 — 연속 클리어로 오르고 빈 락에서 끊긴다', () => {
  const s = wellField(1);
  put(s, 1, 1, -2, 0);
  const a = hardDrop(s).combo;
  wipe(s);
  setRows(s, { 21: '.#########' });
  put(s, 1, 1, -2, 0);
  const b = hardDrop(s).combo;
  wipe(s);
  put(s, 4, 0, 3, 0);
  const c = hardDrop(s).combo;
  return [a, b, c];
}, [1, 2, 0]);

eq('Perfect Clear — 지운 뒤 필드가 완전히 빈다', () => {
  const s = mk();
  setRows(s, { 21: '....######' });
  put(s, 1, 0, 0, 20);     // 가로 I = 0~3열
  const r = hardDrop(s);
  return [r.cleared, r.perfect, filledCount(s)];
}, [1, true, 0]);

eq('Perfect Clear — 찌꺼기가 남으면 false', () => {
  const s = mk();
  setRows(s, { 19: '#.........', 21: '....######' });
  put(s, 1, 0, 0, 20);
  const r = hardDrop(s);
  return [r.cleared, r.perfect];
}, [1, false]);

// --- 5. T-스핀 ------------------------------------------------------------

/** 오버행(19행 5~9열) 밑 3칸 슬롯. 세로 T를 떨어뜨린 뒤 반시계로 비틀어 넣는다 */
function tspinField(bottom: string): TetrisState {
  const s = mk();
  setRows(s, { 19: '.....#####', 20: '###...####', 21: bottom });
  return s;
}

eq('T-스핀 더블 — 회전으로 슬롯에 들어가면 tsd', () => {
  const s = tspinField('####.#####');
  put(s, 6, 3, 3, 2);
  fall(s);
  const rot = tryRotate(s, -1);
  const r = hardDrop(s);
  return [rot, r.spin, r.cleared, r.kind];
}, [true, 'full', 2, 'tsd']);

eq('T-스핀 싱글 — 아랫줄이 안 차면 tss', () => {
  const s = tspinField('####.####.');
  put(s, 6, 3, 3, 2);
  fall(s);
  tryRotate(s, -1);
  const r = hardDrop(s);
  return [r.spin, r.cleared, r.kind];
}, ['full', 1, 'tss']);

eq('T-스핀 미니 — 앞쪽 대각 하나만 막히면 tsm', () => {
  const s = mk();
  setRows(s, { 18: '.....#....', 19: '...#......', 20: '####..####', 21: '####.####.' });
  put(s, 6, 3, 3, 2);
  fall(s);
  const rot = tryRotate(s, 2);          // 180으로 비틀어 넣는 자리(90도로는 못 들어간다)
  const kick = s.lastKick;              // 락 이후에는 다음 조각용으로 초기화된다
  const r = hardDrop(s);
  return [rot, kick, r.spin, r.cleared, r.kind];
}, [true, 4, 'mini', 1, 'tsm']);

eq('T-스핀 — 마지막 동작이 이동이면 스핀이 아니다', () => {
  const s = tspinField('####.#####');
  put(s, 6, 3, 3, 2);
  fall(s);
  tryRotate(s, -1);
  tryMove(s, 0, 0);                     // "성공한 이동"으로 회전 이력을 지운다
  const r = hardDrop(s);
  return [r.spin, r.cleared, r.kind];
}, ['none', 2, 'double']);

eq('T-스핀 — T가 아닌 조각은 스핀이 아니다', () => {
  const s = mk();
  setRows(s, { 20: '#........#', 21: '#.......##' });
  put(s, 5, 0, 3, 10);
  fall(s);
  tryRotate(s, 1);
  const r = hardDrop(s);
  return r.spin;
}, 'none');

// --- 6. 중력 / 락 딜레이 --------------------------------------------------

eq('중력표 — 레벨 1/5/10, 10 초과는 64ms 유지', () => {
  return [GRAVITY_MS.length, gravityMs(1), gravityMs(5), gravityMs(10), gravityMs(11), gravityMs(99)];
}, [10, 1000, 355, 64, 64, 64]);

eq('tick — 중력 누적이 한 칸을 채우면 내려간다', () => {
  const s = mk();
  spawn(s);
  const y0 = s.piece!.y;
  const a = tick(s, 999).dropped;
  const b = tick(s, 1).dropped;
  return [a, b, s.piece!.y - y0];
}, [0, 1, 1]);

eq('tick — 빠른 레벨에서는 한 틱에 여러 칸', () => {
  const s = mk(1, { startLevel: 10 });
  spawn(s);
  const y0 = s.piece!.y;
  const dropped = tick(s, 64 * 3).dropped;
  return [dropped, s.piece!.y - y0];
}, [3, 3]);

eq('락 딜레이 — 접지 후 500ms 에 굳는다', () => {
  const s = mk();
  spawn(s);
  fall(s);
  const before = tick(s, LOCK_DELAY_MS - 100).locked;
  const after = tick(s, 100).locked;
  return [before === null, after !== null, after!.cleared];
}, [true, true, 0]);

eq('락 딜레이 — 이동 리셋은 15회까지만', () => {
  const s = mk();
  spawn(s);
  fall(s);
  let lockedAt = -1;
  let resetsAtLock = -1;
  for (let i = 0; i < 40; i++) {
    tryMove(s, i % 2 === 0 ? -1 : 1, 0);
    resetsAtLock = s.lockResets;
    if (tick(s, 100).locked) { lockedAt = i; break; }
  }
  // 0..14 는 리셋으로 타이머가 0으로 돌아가고, 15부터 100ms씩 쌓여 500ms 되는 순간(18) 락
  return [lockedAt, resetsAtLock];
}, [18, MAX_LOCK_RESETS]);

eq('락 딜레이 — 더 아래로 내려가면 리셋 횟수가 되살아난다', () => {
  const s = mk();
  spawn(s);
  for (let i = 0; i < 5; i++) tryMove(s, i % 2 === 0 ? -1 : 1, 0);
  const airborne = s.lockResets;   // 공중에서의 좌우 이동은 리셋을 쓰지 않는다
  fall(s);
  tryMove(s, -1, 0);
  const grounded = s.lockResets;
  return [airborne, grounded];
}, [0, 1]);

// --- 7. 쓰레기 줄 ---------------------------------------------------------

eq('쓰레기 — 줄 수만큼 바닥에 들어오고 구멍 열이 맞다', () => {
  const s = mk();
  setRows(s, { 21: '#.#.#.#.#.' });
  applyGarbage(s, 2, [5]);
  return [rowStr(s, 19), rowStr(s, 20), rowStr(s, 21), s.alive];
}, ['#.#.#.#.#.', '#####.####', '#####.####', true]);

eq('쓰레기 — holes 가 줄 수와 같으면 줄마다 다른 구멍', () => {
  const s = mk();
  applyGarbage(s, 2, [1, 7]);
  return [rowStr(s, 20), rowStr(s, 21)];
}, ['#.########', '#######.##']);

eq('쓰레기 — holes 가 모자라면 4줄마다 열이 바뀐다', () => {
  const s = mk();
  applyGarbage(s, 6, [0, 9]);
  return [rowStr(s, 16), rowStr(s, 19), rowStr(s, 20), rowStr(s, 21)];
}, ['.#########', '.#########', '#########.', '#########.']);

eq('쓰레기 — 기존 블록이 정확히 그만큼 위로 밀린다', () => {
  const s = mk();
  setRows(s, { 21: '#........#' });
  applyGarbage(s, 3, [4]);
  return [rowStr(s, 18), rowStr(s, 19), filledCount(s)];
}, ['#........#', '####.#####', 2 + 27]);

eq('쓰레기 — 위로 넘치면 탑아웃', () => {
  const s = mk();
  setRows(s, { 2: '.....#....' });
  applyGarbage(s, 3, [0]);
  return s.alive;
}, false);

eq('queueGarbage — 줄을 못 지운 락 직후에 올라온다', () => {
  const s = mk();
  spawn(s);
  queueGarbage(s, 2, [3]);
  const before = pendingCount(s);
  hardDrop(s);
  return [before, pendingCount(s), rowStr(s, 20), rowStr(s, 21)];
}, [2, 0, '###.######', '###.######']);

eq('queueGarbage — 줄을 지운 락에서는 그대로 남는다', () => {
  const s = wellField(1);
  queueGarbage(s, 3, [3]);
  put(s, 1, 1, -2, 0);
  const r = hardDrop(s);
  return [r.cleared, pendingCount(s), rowStr(s, 21)];
}, [1, 3, '#.........']);   // 지워진 줄 위에 있던 I 조각 잔해가 바닥으로 내려앉는다

eq('queueGarbage — 쌓인 쓰레기가 한 번에 다 올라온다', () => {
  const s = mk();
  spawn(s);
  queueGarbage(s, 1, [0]);
  queueGarbage(s, 2, [9]);
  hardDrop(s);
  return [pendingCount(s), rowStr(s, 19), rowStr(s, 21)];
}, [0, '.#########', '#########.']);

// --- 8. 홀드 / 스폰 / 탑아웃 ----------------------------------------------

eq('홀드 — 첫 홀드는 next 에서 당겨온다', () => {
  const s = mk(5);
  spawn(s);
  const cur = s.piece!.id;
  const nextUp = s.next[0];
  const held = holdPiece(s);
  return [held, s.hold === cur, s.piece!.id === nextUp, s.holdUsed];
}, [true, true, true, true]);

eq('홀드 — 같은 조각에서 두 번은 불가', () => {
  const s = mk(5);
  spawn(s);
  holdPiece(s);
  return holdPiece(s);
}, false);

eq('홀드 — 새 조각이 나오면 다시 쓸 수 있고 맞바꾼다', () => {
  const s = mk(5);
  spawn(s);
  const first = s.piece!.id;
  holdPiece(s);
  const second = s.piece!.id;
  hardDrop(s);                 // 다음 조각 스폰 → 홀드 권리 부활
  const third = s.piece!.id;
  const again = holdPiece(s);
  return [again, second !== first, s.piece!.id === first, s.hold === third];
}, [true, true, true, true]);

eq('홀드 — 설정이 꺼져 있으면 무시', () => {
  const s = mk(5, { hold: false });
  spawn(s);
  return holdPiece(s);
}, false);

eq('spawn — 스폰 자리가 막혀 있으면 탑아웃', () => {
  const s = mk();
  setRows(s, { 0: '##########', 1: '##########' });
  const okSpawn = spawn(s);
  return [okSpawn, s.alive, s.piece];
}, [false, false, null]);

eq('hardDrop — 스폰이 막히면 toppedOut', () => {
  const s = mk();
  const rows: Record<number, string> = {};
  for (let y = 0; y < FIELD_ROWS; y++) rows[y] = '..########';   // 0·1열만 뚫린 벽
  setRows(s, rows);
  put(s, 1, 1, -2, 0);         // 0열 우물에 세로 I → 1열이 비어 줄은 안 지워진다
  const r = hardDrop(s);
  return [r.cleared, r.toppedOut, s.alive];
}, [0, true, false]);

// --- 9. 점수 / 레벨 -------------------------------------------------------

eq('점수 — 테트리스 800 + 하드드롭 칸당 2점', () => {
  const s = wellField(4);
  setRows(s, { 17: '.....#....' });   // 퍼펙트 클리어 보너스를 막는 찌꺼기
  put(s, 1, 1, -2, 0);
  const r = hardDrop(s);
  return [r.perfect, r.score, s.score];
}, [false, 800, 800 + 18 * 2]);

eq('레벨 — levelUpLines 마다 오른다', () => {
  const s = wellField(2);
  s.opts.levelUpLines = 2;
  put(s, 1, 1, -2, 0);
  const r = hardDrop(s);
  return [r.levelUp, s.level, gravityMs(s.level)];
}, [true, 2, 793]);

// --- 10. toCells ----------------------------------------------------------

eq('toCells — 길이 200 (보이는 20행만)', () => {
  const s = mk();
  setRows(s, { 0: '##########' });      // 숨은 행은 안 나온다
  spawn(s);
  const cells = toCells(s, s.opts);
  return [cells.length, COLS * ROWS, cells.filter((v) => v === CELL_GARBAGE).length];
}, [200, 200, 0]);

eq('toCells — 조각은 활성값, 착지 예상 자리는 그림자', () => {
  const s = mk();
  spawn(s);
  tryMove(s, 0, 1);
  tryMove(s, 0, 1);            // 숨은 행을 벗어나야 4칸이 다 보인다
  const id = s.piece!.id;
  const cells = toCells(s, s.opts);
  const active = cells.filter((v) => v === CELL_ACTIVE_BASE + id).length;
  const ghost = cells.filter((v) => v === CELL_GHOST).length;
  return [active, ghost];
}, [4, 4]);

eq('toCells — ghost 끄면 그림자를 안 그린다', () => {
  const s = mk(1, { ghost: false });
  spawn(s);
  const cells = toCells(s, s.opts);
  return cells.filter((v) => v === CELL_GHOST).length;
}, 0);

eq('toCells — 조각이 그림자를 덮어쓴다', () => {
  const s = mk();
  put(s, 4, 0, 3, FIELD_ROWS - 2);      // 바닥에 붙은 O = 그림자와 완전히 겹침
  const cells = toCells(s, s.opts);
  return [
    cells.filter((v) => v === CELL_GHOST).length,
    cells.filter((v) => v === CELL_ACTIVE_BASE + 4).length,
  ];
}, [0, 4]);

eq('toCells — out 버퍼를 재사용한다(할당 없음)', () => {
  const s = mk();
  spawn(s);
  const buf = new Array<number>(COLS * ROWS).fill(0);
  const a = toCells(s, s.opts, buf);
  tryMove(s, -1, 0);
  const b = toCells(s, s.opts, buf);
  return [a === buf, b === buf];
}, [true, true]);

// --- 결과 -----------------------------------------------------------------

console.log('');
console.log(`${pass}/${total} PASS`);
if (pass < total) {
  const proc = (globalThis as { process?: { exit(code: number): void } }).process;
  if (proc) proc.exit(1);
}
