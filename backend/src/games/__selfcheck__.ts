// 사천성 엔진/매니저 셀프체크. 실행: npx tsx src/games/__selfcheck__.ts
// DB·소켓 의존 없음. 모든 검사가 PASS여야 하고, 하나라도 FAIL이면 exit code 1.

import {
  countRemaining,
  findAnyPair,
  findPath,
  generateBoard,
  mulberry32,
  shuffleRemaining,
} from './shisen/engine';
import { BOARD_DIMS, BoardSize, GameSnapshot, Point } from './types';
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

// --- 1. 판 생성: 구성 검증 + 탐욕 재생으로 풀이 가능 증명 -------------------

const SIZES: BoardSize[] = ['s', 'm', 'l'];

for (const size of SIZES) {
  const { cols, rows } = BOARD_DIMS[size];
  check(`board ${size} (${cols}x${rows}) — 100개 생성: 심볼 정확히 4개씩`, () => {
    for (let i = 0; i < 100; i++) {
      const cells = generateBoard(cols, rows, mulberry32(1_000_000 + i));
      assert(cells.length === cols * rows, `cell count ${cells.length}`);
      const counts = new Map<number, number>();
      for (const v of cells) {
        assert(v !== 0, 'generated board must be full');
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      assert(counts.size === (cols * rows) / 4, `symbol kinds ${counts.size} != ${(cols * rows) / 4}`);
      for (const [sym, n] of counts) assert(n === 4, `symbol ${sym} appears ${n} times (seed ${1_000_000 + i})`);
    }
    return '100/100';
  });

  check(`board ${size} — 100개 재생 풀이(findAnyPair 반복)로 전부 제거`, () => {
    let maxShuffleNeeded = 0;
    for (let i = 0; i < 100; i++) {
      const cells = generateBoard(cols, rows, mulberry32(2_000_000 + i));
      const work = cells.slice();
      let left = countRemaining(work);
      let steps = 0;
      while (left > 0) {
        const pair = findAnyPair(work, cols, rows);
        assert(pair !== null, `stuck with ${left} tiles left (seed ${2_000_000 + i})`);
        const [a, b] = pair!;
        assert(work[a] === work[b] && work[a] !== 0, 'findAnyPair returned a bad pair');
        assert(findPath(work, cols, rows, a, b) !== null, 'findAnyPair pair has no path');
        work[a] = 0;
        work[b] = 0;
        left -= 2;
        steps++;
      }
      assert(steps === (cols * rows) / 2, `cleared in ${steps} steps`);
      maxShuffleNeeded = Math.max(maxShuffleNeeded, steps);
    }
    return `100/100 (${maxShuffleNeeded} pairs each)`;
  });
}

// --- 2. findPath 단위 케이스 ------------------------------------------------

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
  assert(path !== null, 'expected a path');
  assert(path!.length === 2, `expected 2 points, got ${fmt(path)}`);
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
  assert(path !== null, 'expected a path');
  assert(path!.length === 3, `expected 3 points (1 turn), got ${fmt(path)}`);
  return fmt(path);
});

check('findPath — 꺾임 2회(판 안쪽 우회)', () => {
  // 위쪽 테두리로 빠지는 길은 (0,0)/(0,4) 타일이 막아서, 판 안쪽 1행으로 돌아가야만 한다.
  const g = grid(['x...x', '.....', 'AxxxA', '.....', '.....']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 2, 0), at(g.cols, 2, 4));
  assert(path !== null, 'expected a path');
  assert(path!.length === 4, `expected 4 points (2 turns), got ${fmt(path)}`);
  assert(path![0].r === 2 && path![0].c === 0, 'path must start at a');
  assert(path![3].r === 2 && path![3].c === 4, 'path must end at b');
  assert(path![1].r === 1 && path![2].r === 1, `corners must stay inside the grid, got ${fmt(path)}`);
  return fmt(path);
});

check('findPath — 바깥 테두리를 지나는 경로', () => {
  const g = grid(['AxxxA', 'xxxxx', 'xxxxx']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 0, 0), at(g.cols, 0, 4));
  assert(path !== null, 'expected a path through the padding ring');
  assert(path!.length === 4, `expected 4 points, got ${fmt(path)}`);
  assert(path![1].r === -1 && path![2].r === -1, `corners must sit on the ring, got ${fmt(path)}`);
  return fmt(path);
});

check('findPath — 사방이 막힌 타일 → null', () => {
  const g = grid(['A....', '..x..', '.xAx.', '..x..', '.....']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 2, 2), at(g.cols, 0, 0));
  assert(path === null, `expected null, got ${fmt(path)}`);
  return 'null';
});

check('findPath — 꺾임 3회가 필요하면 → null', () => {
  const g = grid(['Axxxx', 'xxxxx', 'xxxxx', 'xxxxx', 'xxxxA']);
  const path = findPath(g.cells, g.cols, g.rows, at(g.cols, 0, 0), at(g.cols, 4, 4));
  assert(path === null, `expected null (needs 3 turns), got ${fmt(path)}`);
  return 'null';
});

check('findPath — 같은 칸 / 범위 밖 → null', () => {
  const g = grid(['AA..', '....']);
  assert(findPath(g.cells, g.cols, g.rows, 0, 0) === null, 'same index must be null');
  assert(findPath(g.cells, g.cols, g.rows, 0, 999) === null, 'out of range must be null');
  assert(findPath(g.cells, g.cols, g.rows, -1, 1) === null, 'negative must be null');
  return 'null';
});

// --- 3. shuffleRemaining ----------------------------------------------------

check('shuffleRemaining — 위치·심볼 개수 유지 + 항상 한 수 이상', () => {
  const rng = mulberry32(4242);
  let tested = 0;
  for (const size of SIZES) {
    const { cols, rows } = BOARD_DIMS[size];
    for (let i = 0; i < 40; i++) {
      const cells = generateBoard(cols, rows, mulberry32(3_000_000 + i));
      // 무작위로 몇 쌍 지워 잔여 상태를 만든다
      const work = cells.slice();
      const removeCount = Math.floor(rng() * ((cols * rows) / 2 - 2));
      for (let k = 0; k < removeCount; k++) {
        const pair = findAnyPair(work, cols, rows);
        if (!pair) break;
        work[pair[0]] = 0;
        work[pair[1]] = 0;
      }
      if (countRemaining(work) === 0) continue;
      const next = shuffleRemaining(work, cols, rows, rng);
      assert(next.length === work.length, 'length changed');
      for (let idx = 0; idx < work.length; idx++) {
        assert((work[idx] === 0) === (next[idx] === 0), `tile position changed at ${idx}`);
      }
      const before = work.filter((v) => v !== 0).sort((a, b) => a - b);
      const after = next.filter((v) => v !== 0).sort((a, b) => a - b);
      assert(before.join(',') === after.join(','), 'symbol multiset changed');
      assert(findAnyPair(next, cols, rows) !== null, 'no move after shuffle');
      tested++;
    }
  }
  return `${tested} boards`;
});

// --- 4. 생성 성능 -----------------------------------------------------------

check('generateBoard 성능 — size l 20회 < 50ms', () => {
  const { cols, rows } = BOARD_DIMS.l;
  generateBoard(cols, rows, mulberry32(1)); // warm-up
  let worst = 0;
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const t = process.hrtime.bigint();
    generateBoard(cols, rows, mulberry32(5_000_000 + i));
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    worst = Math.max(worst, ms);
    total += ms;
  }
  assert(worst < 50, `worst generation took ${worst.toFixed(1)}ms`);
  return `avg ${(total / 20).toFixed(1)}ms, worst ${worst.toFixed(1)}ms`;
});

// --- 5. gameManager 한 판 흐름(레이스 2인) ----------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function managerFlow(): Promise<string> {
  const slug = `selfcheck-${Date.now()}`;
  const events: { event: string; payload: any }[] = [];
  gameManager.setBroadcast((_slug, event, payload) => events.push({ event, payload }));

  const p1 = { userId: 'u1', nickname: '하나' };
  const p2 = { userId: 'u2', nickname: '두울' };

  const created = gameManager.create(slug, p1, {
    gameId: 'shisen',
    mode: 'race',
    options: { boardSize: 's', items: true, timeLimitSec: 60 },
  });
  assert('state' in created, 'create failed');
  assert('error' in gameManager.create(slug, p2, { gameId: 'shisen', mode: 'race' }), 'duplicate create must fail');
  assert('state' in gameManager.join(slug, p2), 'join failed');
  assert('error' in gameManager.start(slug, p2), 'non-host start must fail');

  const started = gameManager.start(slug, p1);
  assert('state' in started, 'start failed');
  const startState = (started as { state: GameSnapshot }).state;
  assert(startState.phase === 'countdown', `phase ${startState.phase}`);
  assert(Object.keys(startState.boards).length === 2, 'race needs one board per player');
  assert(
    startState.boards['u1'].cells.join(',') === startState.boards['u2'].cells.join(','),
    'race boards must be identical'
  );
  assert(gameManager.pick(slug, p1, 0, 1).ok === false, 'pick before startAt must be rejected');

  await sleep(3200); // 카운트다운
  const playing = gameManager.getSnapshot(slug)!;
  assert(playing.phase === 'playing', `phase ${playing.phase}`);

  const hint = gameManager.hint(slug, p1);
  assert(hint.ok === true, 'hint should return a pair');
  assert(gameManager.getSnapshot(slug)!.players[0].hintsLeft === 2, 'hint must be consumed');

  // u2가 한 쌍 지워 점수를 남긴다
  const board2 = gameManager.getSnapshot(slug)!.boards['u2'];
  const pair2 = findAnyPair(board2.cells, board2.cols, board2.rows)!;
  assert(gameManager.pick(slug, p2, pair2[0], pair2[1]).ok === true, 'u2 pick failed');
  assert(gameManager.pick(slug, p2, pair2[0], pair2[1]).ok === false, 'removed tiles must be gone');

  // u1이 판을 전부 지운다
  let guard = 0;
  for (;;) {
    const snap = gameManager.getSnapshot(slug);
    if (!snap || snap.phase !== 'playing') break;
    const b = snap.boards['u1'];
    const pair = findAnyPair(b.cells, b.cols, b.rows);
    assert(pair !== null, `u1 board stuck with ${b.remaining} tiles`);
    const ack = gameManager.pick(slug, p1, pair![0], pair![1]);
    assert(ack.ok === true, `pick rejected: ${JSON.stringify(ack)}`);
    assert(++guard < 200, 'pick loop did not terminate');
  }

  const done = gameManager.getSnapshot(slug)!;
  assert(done.phase === 'finished', `phase ${done.phase}`);
  assert(done.results !== null, 'results missing');
  assert(done.results![0].userId === 'u1', 'winner must be u1');
  assert(done.results![0].timeMs !== null, 'winner needs a clear time');
  assert(done.results![1].userId === 'u2', 'u2 must rank second');
  assert(done.scoreboard.find((r) => r.userId === 'u1')!.wins === 1, 'scoreboard wins not recorded');
  assert(done.scoreboard.find((r) => r.userId === 'u2')!.games === 1, 'scoreboard games not recorded');

  const rematched = gameManager.rematch(slug, p1);
  assert('state' in rematched && (rematched as any).state.phase === 'lobby', 'rematch must return to lobby');

  // 이탈 정리: u2 퇴장(다른 기기 없음) → 플레이어 1명, u1까지 나가면 게임 삭제
  gameManager.onParticipantLeft(slug, 'u2', false);
  assert(gameManager.getSnapshot(slug)!.players.length === 1, 'u2 should be removed in lobby');
  gameManager.onParticipantLeft(slug, 'u1', true); // 다른 기기가 방에 남아 있음 → 유지
  assert(gameManager.getSnapshot(slug) !== null, 'stillInRoom=true must keep the player');
  gameManager.onParticipantLeft(slug, 'u1', false);
  assert(gameManager.getSnapshot(slug) === null, 'game must be deleted when no players remain');

  gameManager.destroy(slug);

  const matched = events.filter((e) => e.event === 'game:matched').length;
  const states = events.filter((e) => e.event === 'game:state').length;
  const attacks = events.filter((e) => e.event === 'game:attack');
  const shuffles = events.filter((e) => e.event === 'game:shuffled');
  assert(attacks.length > 0, 'items:true + combo 3 should have fired at least one attack');
  for (const a of attacks) {
    assert(a.payload.from === 'u1' && a.payload.to === 'u2', 'attack must target the other player');
    assert(['freeze', 'fog', 'shuffle'].includes(a.payload.type), `bad attack type ${a.payload.type}`);
    if (a.payload.type === 'fog') assert(Array.isArray(a.payload.hidden), 'fog needs hidden[]');
  }
  // seq는 방출 순서대로 단조 증가해야 한다(클라가 늦은 델타를 seq로 버린다)
  let lastSeq = -1;
  for (const e of events) {
    const seq = e.event === 'game:state' ? e.payload.state?.seq : e.payload.seq;
    if (typeof seq !== 'number') continue;
    assert(seq > lastSeq, `seq went backwards at ${e.event}: ${seq} after ${lastSeq}`);
    lastSeq = seq;
  }
  return `${matched} matched / ${attacks.length} attacks / ${shuffles.length} shuffles / ${states} state, seq monotonic`;
}

async function coopFlow(): Promise<string> {
  const slug = `selfcheck-coop-${Date.now()}`;
  gameManager.setBroadcast(() => {});
  const p1 = { userId: 'c1', nickname: '하나' };
  const p2 = { userId: 'c2', nickname: '두울' };

  gameManager.create(slug, p1, { gameId: 'shisen', mode: 'coop', options: { boardSize: 's', items: true } });
  gameManager.join(slug, p2);
  const lobby = gameManager.getSnapshot(slug)!;
  assert(lobby.options.items === false, '협동에는 아이템이 없어야 한다');
  assert(lobby.players.every((p) => p.boardId === 'shared'), 'coop players must share one board');

  gameManager.start(slug, p1);
  await sleep(3200);
  const playing = gameManager.getSnapshot(slug)!;
  assert(Object.keys(playing.boards).join(',') === 'shared', `coop boards: ${Object.keys(playing.boards)}`);
  assert(playing.players[0].hintsLeft === 5, '협동 힌트는 5회 공유');

  assert(gameManager.hint(slug, p2).ok === true, 'coop hint failed');
  const afterHint = gameManager.getSnapshot(slug)!;
  assert(
    afterHint.players.every((p) => p.hintsLeft === 4),
    `shared hints must drop for everyone: ${afterHint.players.map((p) => p.hintsLeft)}`
  );

  // 동시 클릭 충돌: 같은 쌍을 두 번 제출하면 두 번째는 gone
  const b0 = gameManager.getSnapshot(slug)!.boards['shared'];
  const first = findAnyPair(b0.cells, b0.cols, b0.rows)!;
  assert(gameManager.pick(slug, p1, first[0], first[1]).ok === true, 'first coop pick failed');
  const dup = gameManager.pick(slug, p2, first[0], first[1]);
  assert(dup.ok === false && dup.reason === 'gone', `expected gone, got ${JSON.stringify(dup)}`);

  let turn = 0;
  for (let guard = 0; guard < 200; guard++) {
    const snap = gameManager.getSnapshot(slug);
    if (!snap || snap.phase !== 'playing') break;
    const b = snap.boards['shared'];
    const pair = findAnyPair(b.cells, b.cols, b.rows)!;
    assert(pair !== null, `shared board stuck with ${b.remaining}`);
    const who = turn++ % 2 === 0 ? p1 : p2; // 번갈아 지우기
    assert(gameManager.pick(slug, who, pair[0], pair[1]).ok === true, 'coop pick rejected');
  }

  const done = gameManager.getSnapshot(slug)!;
  assert(done.phase === 'finished', `phase ${done.phase}`);
  assert(done.results !== null && done.results.length === 2, 'coop results missing');
  const [r1, r2] = done.results!;
  assert(r1.timeMs !== null && r1.timeMs === r2.timeMs, '협동 결과는 모든 행이 같은 팀 기록');
  assert(r1.pairsCleared >= r2.pairsCleared, 'coop rank = 기여도(제거 쌍) 내림차순');
  assert(done.scoreboard.every((r) => r.wins === 0 && r.games === 1), 'coop은 games만 올라간다');
  gameManager.destroy(slug);
  return `team ${r1.timeMs}ms, ${r1.pairsCleared}+${r2.pairsCleared} pairs`;
}

async function main(): Promise<void> {
  await checkAsync('gameManager — 레이스 2인 한 판(생성→시작→제거→결과→리매치→이탈)', managerFlow);
  await checkAsync('gameManager — 협동 한 판(공유 보드·공유 힌트·충돌 gone·팀 기록)', coopFlow);

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('all checks PASS');
  process.exit(0);
}

void main();
