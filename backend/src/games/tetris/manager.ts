// 테트리스 서버측 중재 (docs/games/tetris-design.md T1/T3).
// 판 시뮬레이션은 클라가 60fps로 돌린다 — 입력 지연이 손맛을 직접 망가뜨리기 때문(T1).
// 서버가 소유하는 건 이것뿐이다: 공격량 계산 · 대상 선택 · 쓰레기 줄(구멍 열) · 상쇄 원장 ·
// 탈락/완주 등수 · 프레임 릴레이 · 레이트 리밋.
// io/DB 의존 없음 — 바깥으로 나가는 건 전부 hooks 로만 나간다(gameManager 가 주입).

import {
  B2B_BONUS,
  COLS,
  COMBO_TABLE,
  GARBAGE_BASE,
  PERFECT_CLEAR_BONUS,
  TetrisClearMsg,
  TetrisFrame,
  TetrisOptions,
} from './types';

/** 프레임 묶음 브로드캐스트 주기 — 8Hz (T3). 클라는 이걸로 상대 미니보드를 그린다. */
const FRAME_BROADCAST_MS = 125;
/** 클라 프레임 상한 — 초당 15회 (T3). 넘치면 조용히 버린다(에러 응답도 없다). */
const FRAME_RATE_LIMIT = 15;
const FRAME_WINDOW_MS = 1000;
/** 서바이벌 바닥 상승은 한 번에 1줄 (T3) */
const RISE_AMOUNT = 1;
/** 구멍 열을 바꾸는 단위 — 가이드라인 방식: 한 묶음은 같은 열, 4줄 넘으면 열을 바꾼다 */
const HOLE_RUN = 4;

/** 서버가 들고 있는 한 플레이어의 테트리스 상태. 판(field)은 서버가 갖지 않는다. */
export interface TetrisPlayer {
  userId: string;
  /** 마지막으로 받은 클라 프레임(그대로 릴레이한다). 아직 없으면 null */
  frame: TetrisFrame | null;
  /** 아직 클라가 받아 내지 못한 쓰레기 줄 — 상쇄 원장(T3.1) */
  pending: number;
  alive: boolean;
  ko: number;
  lines: number;
  score: number;
  maxCombo: number;
  deadAt: number | null;
  finishedAt: number | null;
  finishTimeMs: number | null;
  /** 탈락/완주 시점에 확정된 등수(결과 정렬과 일치해야 한다). 아직이면 null */
  rank: number | null;
  /** 마지막으로 나에게 쓰레기를 보낸 사람 — 탑아웃 시 KO 크레딧 대상 */
  lastHitBy: string | null;
  /** 레이트 리밋 창 시작 시각 */
  lastFrameAt: number;
  /** 현재 창에서 받은 프레임 수 */
  frameCount: number;
}

export interface TetrisHooks {
  /** 방 전체 브로드캐스트. tetris:garbage 도 방으로 나가고 클라가 `to` 로 걸러 본다. */
  broadcast: (event: string, payload: unknown) => void;
  /** 등수·KO·완주가 확정됐다 → gameManager 가 플레이어 상태를 싱크하고 game:state 를 다시 쏜다 */
  onPlayerUpdate: () => void;
  /** 종료 조건 충족 (T3.2) */
  onEnd: (reason: string) => void;
  /** 판 시드에서 나온 rng — 구멍 열/대상 동률을 여기서 뽑는다 */
  rng: () => number;
  /** phase === 'playing' 인가 */
  isPlaying: () => boolean;
}

export interface TetrisRuntime {
  options: TetrisOptions;
  players: Map<string, TetrisPlayer>;
  hooks: TetrisHooks;
  /**
   * tetris:* 이벤트 전용 시퀀스. game.seq 를 쓰지 않는 이유 — 8Hz 프레임 릴레이가
   * 판 상태 seq(사천성 델타 순서 보장용)를 초당 8씩 밀어 올릴 이유가 없다.
   */
  seq: number;
  /** 완주 순서 카운터(sprint 등수) */
  finishCount: number;
  frameTimer: ReturnType<typeof setInterval> | null;
  riseTimer: ReturnType<typeof setInterval> | null;
}

export interface SentGarbage {
  to: string;
  amount: number;
  holes: number[];
}

// --- 순수 규칙 --------------------------------------------------------------

/**
 * 공격량 (T3.1). base + 콤보 + B2B + 퍼펙트클리어 를 더한 뒤 배수를 곱하고 버린다.
 * COMBO_TABLE 은 인덱스가 곧 콤보라서 표를 넘으면 마지막 값으로 고정한다.
 */
export function computeGarbage(msg: TetrisClearMsg, mul: number): number {
  const base = GARBAGE_BASE[msg.kind] ?? 0;
  const comboIdx = Math.min(Math.max(Math.floor(msg.combo) || 0, 0), COMBO_TABLE.length - 1);
  const combo = COMBO_TABLE[comboIdx];
  const b2b = msg.b2b ? B2B_BONUS : 0;
  const pc = msg.perfect ? PERFECT_CLEAR_BONUS : 0;
  const raw = Math.floor((base + combo + b2b + pc) * mul);
  return raw > 0 ? raw : 0;
}

/**
 * 대상 선택 (T3.1). 3인 이상이면 살아 있는 사람 중 지운 줄이 가장 많은 사람(선두)을 친다 —
 * 선두를 때려야 판이 늘어진다. 동률이면 랜덤. 후보가 1명(=2인 판)이면 무조건 그 사람.
 */
export function pickTarget(
  players: TetrisPlayer[],
  attackerId: string,
  rng: () => number
): TetrisPlayer | null {
  const candidates = players.filter((p) => p.userId !== attackerId && p.alive && p.finishedAt === null);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  let best = -Infinity;
  const leaders: TetrisPlayer[] = [];
  for (const p of candidates) {
    if (p.lines > best) {
      best = p.lines;
      leaders.length = 0;
      leaders.push(p);
    } else if (p.lines === best) {
      leaders.push(p);
    }
  }
  return leaders[Math.floor(rng() * leaders.length)] ?? leaders[0];
}

/**
 * 구멍 열 (T3.1). 한 묶음은 같은 열에 구멍을 뚫되, 4줄을 넘으면 열을 바꾼다 —
 * 안 바꾸면 테트리스 4줄 이상이 그냥 한 줄짜리 계단이 되어 너무 쉽다.
 */
export function makeHoles(rng: () => number, amount: number): number[] {
  const holes: number[] = [];
  if (amount <= 0) return holes;
  let col = Math.floor(rng() * COLS) % COLS;
  for (let i = 0; i < amount; i++) {
    if (i > 0 && i % HOLE_RUN === 0) {
      // 같은 열이 또 나오면 한 칸 밀어 "바뀌었다"를 보장한다
      let next = Math.floor(rng() * COLS) % COLS;
      if (next === col) next = (next + 1) % COLS;
      col = next;
    }
    holes.push(col);
  }
  return holes;
}

// --- 런타임 ----------------------------------------------------------------

function makeTetrisPlayer(userId: string): TetrisPlayer {
  return {
    userId,
    frame: null,
    pending: 0,
    alive: true,
    ko: 0,
    lines: 0,
    score: 0,
    maxCombo: 0,
    deadAt: null,
    finishedAt: null,
    finishTimeMs: null,
    rank: null,
    lastHitBy: null,
    lastFrameAt: 0,
    frameCount: 0,
  };
}

export function createTetris(
  options: TetrisOptions,
  userIds: string[],
  hooks: TetrisHooks
): TetrisRuntime {
  const players = new Map<string, TetrisPlayer>();
  for (const id of userIds) players.set(id, makeTetrisPlayer(id));
  return {
    options: { ...options },
    players,
    hooks,
    seq: 0,
    finishCount: 0,
    frameTimer: null,
    riseTimer: null,
  };
}

/** 카운트다운이 끝나 playing 으로 들어갈 때 호출. 타이머는 여기서만 켠다. */
export function beginTetris(rt: TetrisRuntime): void {
  stopTetris(rt); // 중복 시작 방지 — 타이머가 새는 순간 방이 죽을 때까지 안 멈춘다
  rt.frameTimer = setInterval(() => {
    const frames = [...rt.players.values()].map((p) => p.frame).filter((f): f is TetrisFrame => !!f);
    if (frames.length === 0) return;
    rt.hooks.broadcast('tetris:frames', { seq: ++rt.seq, frames });
  }, FRAME_BROADCAST_MS);

  if (rt.options.riseSec > 0) {
    rt.riseTimer = setInterval(() => {
      if (!rt.hooks.isPlaying()) return;
      rt.hooks.broadcast('tetris:rise', {
        seq: ++rt.seq,
        amount: RISE_AMOUNT,
        holes: makeHoles(rt.hooks.rng, RISE_AMOUNT),
        at: Date.now(),
      });
    }, rt.options.riseSec * 1000);
  }
}

/** 게임 종료/닫힘/리매치에서 반드시 호출 (gameManager.clearTimers 와 같은 규칙). */
export function stopTetris(rt: TetrisRuntime | null): void {
  if (!rt) return;
  if (rt.frameTimer) clearInterval(rt.frameTimer);
  if (rt.riseTimer) clearInterval(rt.riseTimer);
  rt.frameTimer = null;
  rt.riseTimer = null;
}

// --- 클라 → 서버 -------------------------------------------------------------

/**
 * 내 판 스냅샷 (T3). 저장만 하고 브로드캐스트는 8Hz 타이머가 묶어서 한다.
 * - 초당 15회를 넘으면 조용히 버린다.
 * - lines/score 는 단조 증가만 인정한다(줄어드는 값은 무시).
 * - pending 은 **서버 원장이 진실**이다. 클라가 실제로 받아 낸 만큼 줄이는 것만 반영하고,
 *   늘리는 건 서버 공격으로만 일어난다.
 * @returns 받아들였으면 true, 레이트 리밋으로 버렸으면 false
 */
export function onFrame(
  rt: TetrisRuntime,
  userId: string,
  frame: Omit<TetrisFrame, 'userId'>,
  now: number = Date.now()
): boolean {
  const p = rt.players.get(userId);
  if (!p) return false;

  if (now - p.lastFrameAt >= FRAME_WINDOW_MS) {
    p.lastFrameAt = now;
    p.frameCount = 0;
  }
  if (p.frameCount >= FRAME_RATE_LIMIT) return false;
  p.frameCount += 1;

  p.lines = Math.max(p.lines, Math.floor(frame.lines) || 0);
  p.score = Math.max(p.score, Math.floor(frame.score) || 0);
  p.maxCombo = Math.max(p.maxCombo, Math.floor(frame.combo) || 0);
  const reported = Math.max(0, Math.floor(frame.pending) || 0);
  if (reported < p.pending) p.pending = reported;

  p.frame = {
    ...frame,
    userId,
    lines: p.lines,
    score: p.score,
    pending: p.pending,
    alive: p.alive,
    ko: p.ko,
  };
  return true;
}

/**
 * 줄을 지웠다 (T3.1). 순서가 중요하다:
 * 1) 공격량을 계산하고 2) **공격자 자신의 pending 을 먼저 상쇄**한 뒤 3) 남은 만큼만 보낸다.
 * 전부 상쇄돼 남는 게 없으면 tetris:sent 도 보내지 않는다(0줄짜리 연출은 노이즈다).
 * 상쇄로 줄어든 공격자 pending 은 다음 frame 에 자연히 실려 나간다.
 */
export function onClear(rt: TetrisRuntime, userId: string, msg: TetrisClearMsg): SentGarbage | null {
  const p = rt.players.get(userId);
  if (!p || !p.alive || p.finishedAt !== null) return null;
  p.maxCombo = Math.max(p.maxCombo, Math.floor(msg.combo) || 0);

  // 레이스는 '방해 없이 기록 경쟁'이 정의다 — 배수가 0이 아니어도 공격은 나가지 않는다.
  if (rt.options.mode === 'sprint') return null;

  const raw = computeGarbage(msg, rt.options.garbageMul);
  if (raw <= 0) return null;

  const canceled = Math.min(p.pending, raw);
  p.pending -= canceled;
  const amount = raw - canceled;
  if (amount <= 0) return null;

  const target = pickTarget([...rt.players.values()], userId, rt.hooks.rng);
  if (!target) return null;

  const holes = makeHoles(rt.hooks.rng, amount);
  target.pending += amount;
  target.lastHitBy = userId;

  const seq = ++rt.seq;
  rt.hooks.broadcast('tetris:garbage', { seq, to: target.userId, from: userId, amount, holes });
  rt.hooks.broadcast('tetris:sent', {
    seq,
    from: userId,
    to: target.userId,
    amount,
    kind: msg.kind,
    b2b: msg.b2b,
    combo: msg.combo,
  });
  return { to: target.userId, amount, holes };
}

/** 탈락/기권 공통 처리 — 등수 확정 + tetris:down + 종료 검사 */
function down(
  rt: TetrisRuntime,
  p: TetrisPlayer,
  reason: 'topout' | 'forfeit',
  now: number
): number | null {
  if (!p.alive) return null;
  p.alive = false;
  p.deadAt = now;
  if (p.frame) p.frame.alive = false;

  // 나중에 죽을수록 좋은 등수 — 지금 죽으면 "아직 살아 있는 사람 수 + 1" 등이다 (T3.2)
  const aliveLeft = [...rt.players.values()].filter((x) => x.alive && x.finishedAt === null).length;
  p.rank = aliveLeft + 1;

  let by: string | null = null;
  if (reason === 'topout' && p.lastHitBy && p.lastHitBy !== p.userId) {
    const killer = rt.players.get(p.lastHitBy);
    if (killer) {
      killer.ko += 1;
      if (killer.frame) killer.frame.ko = killer.ko;
      by = killer.userId;
    }
  }

  rt.hooks.broadcast('tetris:down', { seq: ++rt.seq, userId: p.userId, by, rank: p.rank, reason });
  rt.hooks.onPlayerUpdate();
  checkEnd(rt);
  return p.rank;
}

/** 내가 죽었다 (T3.2). 마지막으로 나를 때린 사람에게 KO 를 준다. */
export function onTopout(rt: TetrisRuntime, userId: string, now: number = Date.now()): number | null {
  const p = rt.players.get(userId);
  if (!p) return null;
  return down(rt, p, 'topout', now);
}

/** 진행 중 관전 전환·접속 끊김 기권. KO 크레딧은 주지 않는다. */
export function onForfeit(rt: TetrisRuntime, userId: string, now: number = Date.now()): number | null {
  const p = rt.players.get(userId);
  if (!p) return null;
  return down(rt, p, 'forfeit', now);
}

/** 레이스 목표 달성 (T3.2). 완주 순서대로 등수를 준다. */
export function onFinish(
  rt: TetrisRuntime,
  userId: string,
  timeMs: number,
  lines: number,
  now: number = Date.now()
): number | null {
  const p = rt.players.get(userId);
  if (!p || !p.alive || p.finishedAt !== null) return null;
  p.finishedAt = now;
  p.finishTimeMs = Math.max(0, Math.floor(timeMs) || 0);
  p.lines = Math.max(p.lines, Math.floor(lines) || 0);
  p.rank = ++rt.finishCount;
  if (p.frame) p.frame.lines = p.lines;

  rt.hooks.broadcast('tetris:finished', {
    seq: ++rt.seq,
    userId: p.userId,
    timeMs: p.finishTimeMs,
    lines: p.lines,
  });
  rt.hooks.onPlayerUpdate();
  checkEnd(rt);
  return p.rank;
}

/**
 * 종료 조건 (T3.2).
 * - sprint: 전원이 완주했거나 죽으면 끝(제한 시간은 gameManager 의 limitTimer 가 본다)
 * - versus/survival: 살아 있는 사람이 1명 이하면 끝. 단 **혼자 하는 판**은 그 1명이 죽어야 끝난다.
 */
export function checkEnd(rt: TetrisRuntime): void {
  if (!rt.hooks.isPlaying()) return;
  const all = [...rt.players.values()];
  if (all.length === 0) return;

  if (rt.options.mode === 'sprint') {
    if (all.every((p) => p.finishedAt !== null || !p.alive)) rt.hooks.onEnd('tetris sprint done');
    return;
  }
  const alive = all.filter((p) => p.alive && p.finishedAt === null).length;
  const done = all.length > 1 ? alive <= 1 : alive === 0;
  if (done) rt.hooks.onEnd('tetris last player standing');
}

/**
 * 결과 정렬 키 (T3.2).
 * - versus/survival: 생존자 먼저 → 늦게 죽은 순 → 지운 줄 많은 순 → 점수
 * - sprint: 완주자 먼저(기록 오름차순) → 미완주는 지운 줄 내림차순
 */
export function sortForResults(rt: TetrisRuntime): TetrisPlayer[] {
  const all = [...rt.players.values()];
  if (rt.options.mode === 'sprint') {
    return all.sort((a, b) => {
      const fa = a.finishTimeMs !== null ? 0 : 1;
      const fb = b.finishTimeMs !== null ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (fa === 0) return (a.finishTimeMs ?? 0) - (b.finishTimeMs ?? 0);
      return b.lines - a.lines || b.score - a.score;
    });
  }
  return all.sort((a, b) => {
    const aa = a.alive ? 0 : 1;
    const ab = b.alive ? 0 : 1;
    if (aa !== ab) return aa - ab;
    if (aa === 1) {
      // 탈락 시점에 이미 등수를 방송했으므로(tetris:down) 결과도 그 번호를 따라가야 한다.
      // 같은 ms 에 두 명이 죽어도 등수는 다르다 — deadAt 으로 다시 재면 순서가 뒤집힌다.
      const ra = (a.rank ?? 0) - (b.rank ?? 0); // 등수 번호가 작을수록 위
      if (ra !== 0) return ra;
      const da = (b.deadAt ?? 0) - (a.deadAt ?? 0); // 늦게 죽은 사람이 위
      if (da !== 0) return da;
    }
    return b.lines - a.lines || b.score - a.score;
  });
}
