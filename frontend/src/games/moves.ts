import { canPick } from './shisen/engine';
import { EMPTY, LOCKED, MYSTERY, WALL } from './types';

export interface MoveView {
  cells: number[]; cols: number; rows: number; nextNumber: number; keysLeft: number;
}

/**
 * 지금 **보이는 판**에서 연결 가능한 쌍 수. 서버의 `Board.movesLeft`(진실 판 기준)가 오기 전/없을 때
 * HUD에 쓴다. 같은 값끼리만 비교하므로 findPath 호출이 몇백 번을 넘지 않는다.
 */
export function countMoves(view: MoveView): number {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < view.cells.length; i++) {
    const v = view.cells[i];
    if (v === EMPTY || v === WALL || v === LOCKED || v === MYSTERY) continue;
    const list = groups.get(v);
    if (list) list.push(i); else groups.set(v, [i]);
  }
  let n = 0;
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (canPick(view, list[i], list[j]) === null) n++;
      }
    }
  }
  return n;
}
