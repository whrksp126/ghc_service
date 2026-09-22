// KEEP IN SYNC with ghc_service/backend/src/games/shisen/engine.ts
// 사천성 순수 엔진 (docs/games/shisen-design.md §1). 서버가 권위이고, 클라이언트는 `findPath`만
// 예측(optimistic removal)에 쓴다. 나머지는 백엔드 복사본과 동일하게 두어 diff가 깨끗하도록 유지한다.

import type { Point } from '../types';

/** 결정적 PRNG. 서버가 시드를 만들고 스냅샷에 담는다(로그/리매치용). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

export function countRemaining(cells: number[]): number {
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) n++;
  return n;
}

/* ------------------------------------------------------------------ *
 * findPath — 빈칸만 지나는 꺾임 ≤ 2회 경로. 판 바깥 테두리 1칸 통과 허용.
 * 반환: 꼭짓점만 담은 원 격자 좌표 Point[] (길이 2~4), 없으면 null.
 * ------------------------------------------------------------------ */

const DR = [-1, 1, 0, 0];
const DC = [0, 0, -1, 1];

export function findPath(
  cells: number[], cols: number, rows: number, a: number, b: number,
): Point[] | null {
  if (a === b) return null;
  if (a < 0 || b < 0 || a >= cells.length || b >= cells.length) return null;
  if (cells[a] === 0 || cells[b] === 0) return null;
  if (cells[a] !== cells[b]) return null;

  // 패딩 격자 (cols+2) x (rows+2). 테두리는 항상 빈칸.
  const W = cols + 2;
  const H = rows + 2;
  const pad = new Uint8Array(W * H); // 1 = 막힘
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (cells[r * cols + c] !== 0) pad[(r + 1) * W + (c + 1)] = 1;
    }
  }
  const toPad = (idx: number) => {
    const r = Math.floor(idx / cols);
    const c = idx % cols;
    return (r + 1) * W + (c + 1);
  };
  const start = toPad(a);
  const goal = toPad(b);
  const toPoint = (p: number): Point => ({ r: Math.floor(p / W) - 1, c: (p % W) - 1 });

  // state key = padIdx * 4 + dir ("dir 방향으로 이동해서 padIdx에 서 있다")
  const STATES = W * H * 4;
  const turnsAt = new Int8Array(STATES).fill(-1);
  const parent = new Int32Array(STATES).fill(-2); // -1 = 시작점에서 바로, -2 = 미방문
  const queue: number[] = [];

  // 경로 복원: 꼭짓점 = [a, ...꺾임점들, b]
  const build = (lastState: number): Point[] => {
    const corners: number[] = [];
    let s = lastState;
    while (s >= 0) {
      corners.push(Math.floor(s / 4));
      s = parent[s];
    }
    corners.reverse();
    return [toPoint(start), ...corners.map(toPoint), toPoint(goal)];
  };

  // 한 방향으로 직선 주행. goal에 닿으면 즉시 성공.
  const walk = (from: number, dir: number, turns: number, fromState: number): Point[] | null => {
    let p = from;
    for (;;) {
      p += DR[dir] * W + DC[dir];
      const pr = Math.floor(p / W);
      const pc = p % W;
      if (pr < 0 || pr >= H || pc < 0 || pc >= W) return null;
      // 상하 이동이 격자 밖으로 새는 것 방지 (좌우는 위 범위 검사로 충분하지 않음)
      if (dir >= 2 && Math.floor(from / W) !== pr) return null;
      if (p === goal) return build(fromState);
      if (pad[p] === 1) return null;
      const st = p * 4 + dir;
      if (turnsAt[st] === -1 || turnsAt[st] > turns) {
        turnsAt[st] = turns;
        parent[st] = fromState;
        queue.push(st);
      }
    }
  };

  // 0회 꺾임: 시작점에서 4방향 직선
  for (let d = 0; d < 4; d++) {
    let p = start;
    for (;;) {
      const prevR = Math.floor(p / W);
      p += DR[d] * W + DC[d];
      const pr = Math.floor(p / W);
      const pc = p % W;
      if (pr < 0 || pr >= H || pc < 0 || pc >= W) break;
      if (d >= 2 && prevR !== pr) break;
      if (p === goal) return [toPoint(start), toPoint(goal)];
      if (pad[p] === 1) break;
      const st = p * 4 + d;
      if (turnsAt[st] === -1) {
        turnsAt[st] = 0;
        parent[st] = -1;
        queue.push(st);
      }
    }
  }

  // BFS: 꺾을 때마다 turns + 1 (최대 2)
  for (let qi = 0; qi < queue.length; qi++) {
    const st = queue[qi];
    const idx = Math.floor(st / 4);
    const dir = st % 4;
    const t = turnsAt[st];
    if (t >= 2) continue;
    for (let d = 0; d < 4; d++) {
      // 같은 축(정방향/역방향)은 꺾임이 아니므로 직선 주행에서 이미 처리됨
      if (d === dir || (d >> 1) === (dir >> 1)) continue;
      const found = walk(idx, d, t + 1, st);
      if (found) return found;
    }
  }
  return null;
}

/** 연결 가능한 아무 쌍이나 하나. 없으면 null (= 막힘). */
export function findAnyPair(cells: number[], cols: number, rows: number): [number, number] | null {
  const bySymbol = new Map<number, number[]>();
  for (let i = 0; i < cells.length; i++) {
    const s = cells[i];
    if (s === 0) continue;
    const list = bySymbol.get(s);
    if (list) list.push(i); else bySymbol.set(s, [i]);
  }
  for (const list of bySymbol.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (findPath(cells, cols, rows, list[i], list[j])) return [list[i], list[j]];
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 판 생성 — 역재생(reverse-play)으로 풀이 가능 보장 (§1.3)
 *
 * 설계서의 순수 랜덤 후보 선택은 **끝부분에서 거의 항상 막힌다**: 마지막 쌍은 판이 꽉 찬
 * 상태에서 연결돼야 하므로(= 인접하거나 테두리로 도는 경우만) 무작위로 고르면 12×6·14×8은
 * 재시도 50회로도 성공하지 못했다(실측 fail 18/20, 20/20).
 * → 남은 빈칸 집합이 항상 **격자 인접 완전 매칭(perfect matching)** 을 갖도록 유지한다.
 *   - 매칭 간선(= 인접한 두 빈칸)은 판 상태와 무관하게 항상 연결 가능하므로 안전한 폴백이다.
 *   - 무작위 후보는 "지우고 나서도 완전 매칭이 남는지" 확인될 때만 채택한다.
 *   따라서 생성은 절대 실패하지 않고, 앞쪽(먼저 놓이는 = 나중에 지워지는) 쌍은 여전히 무작위다.
 * ------------------------------------------------------------------ */

/** 빈칸 집합이 격자 인접 그래프에서 완전 매칭을 갖는지 + 그 매칭을 돌려준다(없으면 null). */
function perfectMatching(empty: Set<number>, cols: number, rows: number): Map<number, number> | null {
  if (empty.size % 2 !== 0) return null;
  // 격자는 이분 그래프 — (r+c) 짝/홀로 나눈다.
  const left: number[] = [];
  for (const i of empty) {
    const r = Math.floor(i / cols); const c = i % cols;
    if (((r + c) & 1) === 0) left.push(i);
  }
  if (left.length * 2 !== empty.size) return null;
  const matchOf = new Map<number, number>();
  const neighbors = (i: number): number[] => {
    const r = Math.floor(i / cols); const c = i % cols;
    const out: number[] = [];
    if (r > 0) out.push(i - cols);
    if (r < rows - 1) out.push(i + cols);
    if (c > 0) out.push(i - 1);
    if (c < cols - 1) out.push(i + 1);
    return out.filter((n) => empty.has(n));
  };
  const tryAugment = (u: number, seen: Set<number>): boolean => {
    for (const v of neighbors(u)) {
      if (seen.has(v)) continue;
      seen.add(v);
      const cur = matchOf.get(v);
      if (cur === undefined || tryAugment(cur, seen)) {
        matchOf.set(v, u);
        matchOf.set(u, v);
        return true;
      }
    }
    return false;
  };
  for (const u of left) {
    if (matchOf.has(u)) continue;
    if (!tryAugment(u, new Set())) return null;
  }
  return matchOf;
}

export function generateBoard(cols: number, rows: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const cellCount = cols * rows;
  if (cellCount % 4 !== 0) throw new Error(`invalid board dims ${cols}x${rows}`);
  const symbolCount = cellCount / 4;

  const board = new Array<number>(cellCount).fill(0);
  // 심볼 하나당 2쌍 → 쌍 단위 리스트
  const pairs: number[] = [];
  for (let s = 1; s <= symbolCount; s++) { pairs.push(s, s); }
  shuffleInPlace(pairs, rng);

  const empty = new Set<number>();
  for (let i = 0; i < cellCount; i++) empty.add(i);
  let matching = perfectMatching(empty, cols, rows);
  if (!matching) throw new Error(`board ${cols}x${rows} has no perfect matching`);

  for (const sym of pairs) {
    const list = [...empty];
    let chosen: [number, number] | null = null;

    // 1) 무작위 후보 — "현재 빈칸만 지나" 연결되고, 지운 뒤에도 완전 매칭이 남는 것.
    for (let k = 0; k < 12 && !chosen; k++) {
      const p = list[Math.floor(rng() * list.length)];
      const q = list[Math.floor(rng() * list.length)];
      if (p === q) continue;
      board[p] = sym; board[q] = sym;
      const linked = findPath(board, cols, rows, p, q);
      board[p] = 0; board[q] = 0;
      if (!linked) continue;
      const rest = new Set(empty); rest.delete(p); rest.delete(q);
      const m = perfectMatching(rest, cols, rows);
      if (m) { chosen = [p, q]; matching = m; }
    }

    // 2) 폴백 — 현재 매칭의 간선(인접한 두 빈칸). 항상 연결 가능하고 매칭도 유지된다.
    if (!chosen) {
      const p = list[Math.floor(rng() * list.length)];
      const q = matching!.get(p)!;
      chosen = [p, q];
      const rest = new Set(empty); rest.delete(p); rest.delete(q);
      matching = perfectMatching(rest, cols, rows)!;
    }

    board[chosen[0]] = sym; board[chosen[1]] = sym;
    empty.delete(chosen[0]); empty.delete(chosen[1]);
  }
  return board;
}

/** 남은 타일 위치는 유지하고 심볼만 재배치. 최소 1쌍은 연결 가능하도록 재시도. */
export function shuffleRemaining(cells: number[], cols: number, rows: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const filled: number[] = [];
  for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) filled.push(i);
  if (filled.length < 2) return cells.slice();

  for (let attempt = 0; attempt < 100; attempt++) {
    const symbols = filled.map((i) => cells[i]);
    shuffleInPlace(symbols, rng);
    const next = cells.slice();
    filled.forEach((idx, k) => { next[idx] = symbols[k]; });
    if (findAnyPair(next, cols, rows)) return next;
  }
  return cells.slice();
}
