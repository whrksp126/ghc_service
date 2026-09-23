// 방 안 미니게임 상태 머신 (docs/games/shisen-design.md §3, §1.6, §1.7).
// io 의존 없음 — 브로드캐스트는 setBroadcast()로 주입된 콜백으로만 나간다.
// 플레이어 식별은 userId. 같은 유저가 여러 기기로 들어와도 플레이어는 1명.

import {
  AttackEvent,
  AttackType,
  BOARD_DIMS,
  Board,
  BoardPatch,
  BoardSize,
  COMBO_WINDOW_MS,
  COUNTDOWN_MS,
  DEFAULT_OPTIONS,
  EMPTY,
  Effect,
  GameId,
  GameMode,
  GameOptions,
  GamePhase,
  GameSnapshot,
  HintAck,
  ItemAck,
  KEY_BASE,
  KEY_TYPES_PER_SIZE,
  MAX_KEY_TYPES,
  MAX_PLAYERS,
  NUMBER_BASE,
  PLAYER_COLORS,
  PickAck,
  PeekAck,
  PlayerItems,
  PlayerState,
  ResultRow,
  ScoreboardRow,
  SpecialToggles,
  TOOL_LIMITS,
  isKey,
} from './types';
import {
  NO_HIDDEN,
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
  pickShape,
  shuffleNormals,
} from './shisen/engine';
import {
  DEFAULT_TETRIS_OPTIONS,
  TETRIS_LIMITS,
  TetrisAck,
  TetrisClearMsg,
  TetrisFrame,
  TetrisMode,
  TetrisOptions,
} from './tetris/types';
import * as tetris from './tetris/manager';

export type Broadcast = (roomSlug: string, event: string, payload: unknown) => void;

export interface GameActor {
  userId: string;
  nickname: string;
}

export type StateResult = { error: string } | { state: GameSnapshot };

const WAND_SCORE = 10;
const DISCONNECT_FORFEIT_MS = 30000;
const ATTACK_COMBO_STEPS = [3, 6, 9];
const ATTACK_TYPES: AttackType[] = ['freeze', 'fog', 'shuffle'];
const FREEZE_MS = 3000;
const FOG_MS = 4000;
const FOG_RATIO = 0.4;
const SHUFFLE_FX_MS = 250;
const MAX_COMBO = 10;
const SHARED_BOARD_ID = 'shared';
/** 숫자 순서 타일 쌍 수 (v2 §V3) */
const NUMBERS_PER_SIZE: Record<BoardSize, number> = { s: 3, m: 4, l: 5 };
const SYSTEM_USER = 'system';
/**
 * 종료 후 자동으로 로비로 돌아가기까지 (tetris-design.md §Z3).
 * 결과 화면에서 방장이 바로 다시 시작해 버리는 걸 막고, 항상 로비(=준비 단계)를 거치게 한다.
 */
const LOBBY_RETURN_MS = 12000;
let lobbyReturnDelayMs = LOBBY_RETURN_MS;
/**
 * 셀프체크 전용 — 12초를 실제로 기다리지 않으려고 지연만 줄인다.
 * 0 이하를 주면 기본값(LOBBY_RETURN_MS)으로 되돌린다. 운영 코드에서는 호출하지 말 것.
 */
export function __setLobbyReturnDelayMs(ms: number): void {
  lobbyReturnDelayMs = ms > 0 ? ms : LOBBY_RETURN_MS;
}

interface InternalPlayer extends PlayerState {
  /** playing 중 기권(게임에는 남아 결과 최하위 그룹으로 집계) */
  forfeited: boolean;
  /** 힌트를 쓴 직후 한 번은 콤보를 끊는다 (§1.5) */
  hintBreak: boolean;
}

/** 서버가 들고 있는 진실 판. 클라로 나갈 때는 항상 maskForClient를 거친다. */
interface ServerBoard {
  id: string;
  cols: number;
  rows: number;
  cells: number[];         // 진실(물음표/자물쇠 마스킹 없음)
  hidden: Set<number>;         // 물음표로 가려진 칸(엿보기 가능, 진실 심볼로 판정)
  locks: Map<number, number>;  // 자물쇠 칸 → 열쇠 종류(1..MAX_KEY_TYPES)
  remaining: number;       // 벽 제외 남은 타일 수
  total: number;           // 시작 시 타일 수(진행률용)
  effects: Effect[];
  shape: Shape;
  nextNumber: number;      // 다음에 지워야 할 숫자(없으면 0)
  maxNumber: number;
  keysLeft: number;            // 남은 열쇠 쌍 수
  movesLeft: number;       // v2.1: 지금 연결 가능한 쌍 수(stuckView 기준)
}

interface RoomGame {
  slug: string;
  gameId: GameId;
  phase: GamePhase;
  hostUserId: string;
  mode: GameMode;
  options: GameOptions;
  /** 테트리스 설정 — gameId==='tetris' 일 때만 non-null */
  tetris: TetrisOptions | null;
  /** 테트리스 진행 상태(시작할 때 만들고 끝나면 타이머만 끈다) */
  tetrisRun: tetris.TetrisRuntime | null;
  seed: number;
  startAt: number | null;
  endedAt: number | null;
  players: Map<string, InternalPlayer>; // 삽입 순서 = 참가 순서
  boards: Map<string, ServerBoard>;
  spectators: Map<string, { userId: string; nickname: string }>;
  results: ResultRow[] | null;
  seq: number;
  rng: () => number;
  sharedItems: PlayerItems;   // 쟁탈전 공유 카운트
  countdownTimer: ReturnType<typeof setTimeout> | null;
  limitTimer: ReturnType<typeof setTimeout> | null;
  /** finished → lobby 자동 복귀 타이머 (§Z3). 수동 복귀·종료 시 반드시 끈다. */
  lobbyTimer: ReturnType<typeof setTimeout> | null;
  forfeitTimers: Map<string, ReturnType<typeof setTimeout>>;
  effectTimers: Set<ReturnType<typeof setTimeout>>;
}

const games = new Map<string, RoomGame>();
/** 방 슬러그별 누적 전적. 게임을 지워도 남고, 방이 사라질 때 같이 지워진다. */
const scoreboards = new Map<string, Map<string, ScoreboardRow>>();

let broadcast: Broadcast = () => {};

export function setBroadcast(fn: Broadcast): void {
  broadcast = fn;
}

// --- 내부 헬퍼 -------------------------------------------------------------

function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function boardIdFor(mode: GameMode, userId: string): string {
  return mode === 'coop' ? SHARED_BOARD_ID : userId;
}

function nextColor(game: RoomGame): string {
  const used = new Set([...game.players.values()].map((p) => p.color));
  return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[game.players.size % PLAYER_COLORS.length];
}

function makePlayer(game: RoomGame, actor: GameActor): InternalPlayer {
  return {
    userId: actor.userId,
    nickname: actor.nickname,
    color: nextColor(game),
    boardId: boardIdFor(game.mode, actor.userId),
    score: 0,
    combo: 0,
    maxCombo: 0,
    pairsCleared: 0,
    lines: 0,
    ko: 0,
    lastMatchAt: 0,
    items: { ...(game.mode === 'coop' ? game.sharedItems : game.options.tools) },
    finishedAt: null,
    connected: true,
    forfeited: false,
    rank: 1,
    ready: false,   // 들어오면 항상 미준비부터 (§Z3)
    hintBreak: false,
  };
}

/** 테트리스 런타임 값을 공용 PlayerState 에 옮긴다(스냅샷/등수/결과가 전부 이걸 본다). */
function syncTetrisPlayers(game: RoomGame): void {
  const rt = game.tetrisRun;
  if (!rt) return;
  for (const p of game.players.values()) {
    const tp = rt.players.get(p.userId);
    if (!tp) continue;
    p.lines = tp.lines;
    p.ko = tp.ko;
    p.score = tp.score;
    p.maxCombo = tp.maxCombo;
    p.finishedAt = tp.finishedAt;
  }
}

/**
 * 실시간 등수 (v4 §X2.5): 완주자 먼저(완주 시각 오름차순) → 레이스는 남은 패 오름차순 /
 * 쟁탈전은 지운 쌍 내림차순 → 점수 내림차순. 동률은 같은 등수를 공유한다.
 */
function recomputeRanks(game: RoomGame): void {
  const players = [...game.players.values()];
  if (players.length === 0) return;
  const remainingOf = (p: InternalPlayer) => boardOf(game, p)?.remaining ?? 0;
  const rt = game.tetrisRun;
  // 테트리스는 판을 서버가 갖고 있지 않다 — 생존 → 지운 줄 → 점수로만 줄 세운다 (T3.2)
  const keyOf =
    game.gameId === 'tetris'
      ? (p: InternalPlayer): [number, number, number, number] => [
          rt?.players.get(p.userId)?.alive === false ? 1 : 0,
          -p.lines,
          -p.score,
          0,
        ]
      : (p: InternalPlayer): [number, number, number, number] => [
          p.finishedAt !== null ? 0 : 1,
          p.finishedAt ?? 0,
          game.mode === 'coop' ? -p.pairsCleared : remainingOf(p),
          -p.score,
        ];
  const sorted = players
    .map((p) => ({ p, key: keyOf(p) }))
    .sort((x, y) => {
      for (let i = 0; i < x.key.length; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i];
      return 0;
    });
  let rank = 0;
  let prev: number[] | null = null;
  sorted.forEach((entry, i) => {
    if (!prev || prev.some((v, k) => v !== entry.key[k])) rank = i + 1;
    entry.p.rank = rank;
    prev = entry.key;
  });
}

function purgeEffects(game: RoomGame, now: number): void {
  for (const board of game.boards.values()) {
    if (board.effects.length === 0) continue;
    board.effects = board.effects.filter((e) => e.until > now);
  }
}

function toPublicPlayer(p: InternalPlayer): PlayerState {
  return {
    userId: p.userId,
    nickname: p.nickname,
    color: p.color,
    boardId: p.boardId,
    score: p.score,
    combo: p.combo,
    maxCombo: p.maxCombo,
    pairsCleared: p.pairsCleared,
    lines: p.lines,
    ko: p.ko,
    lastMatchAt: p.lastMatchAt,
    items: { ...p.items },
    finishedAt: p.finishedAt,
    connected: p.connected,
    forfeited: p.forfeited,
    rank: p.rank,
    ready: p.ready,
  };
}

function snapshot(game: RoomGame): GameSnapshot {
  purgeEffects(game, Date.now());
  syncTetrisPlayers(game);
  recomputeRanks(game);
  const boards: Record<string, Board> = {};
  for (const [id, b] of game.boards) boards[id] = toPublicBoard(b);
  return {
    gameId: game.gameId,
    phase: game.phase,
    hostUserId: game.hostUserId,
    mode: game.mode,
    options: { ...game.options },
    tetris: game.tetris ? { ...game.tetris } : null,
    seed: game.seed,
    startAt: game.startAt,
    endedAt: game.endedAt,
    players: [...game.players.values()].map(toPublicPlayer),
    boards,
    spectators: [...game.spectators.values()].map((s) => ({ ...s })),
    results: game.results ? game.results.map((r) => ({ ...r })) : null,
    scoreboard: buildScoreboard(game.slug),
    seq: game.seq,
  };
}

function emitState(game: RoomGame): GameSnapshot {
  game.seq++;
  const state = snapshot(game);
  broadcast(game.slug, 'game:state', { state });
  return state;
}

function buildScoreboard(slug: string): ScoreboardRow[] {
  const table = scoreboards.get(slug);
  if (!table) return [];
  return [...table.values()]
    .map((r) => ({ ...r }))
    .sort((a, b) => b.wins - a.wins || b.games - a.games || a.nickname.localeCompare(b.nickname));
}

function clearTimers(game: RoomGame): void {
  tetris.stopTetris(game.tetrisRun); // 8Hz 프레임·서바이벌 상승 타이머도 같이 끈다
  if (game.countdownTimer) clearTimeout(game.countdownTimer);
  if (game.limitTimer) clearTimeout(game.limitTimer);
  if (game.lobbyTimer) clearTimeout(game.lobbyTimer);
  game.countdownTimer = null;
  game.limitTimer = null;
  game.lobbyTimer = null;
  for (const t of game.forfeitTimers.values()) clearTimeout(t);
  game.forfeitTimers.clear();
  for (const t of game.effectTimers) clearTimeout(t);
  game.effectTimers.clear();
}

/**
 * 준비 전원 해제 (§Z3). 시작 / 로비 복귀 / 입퇴장·관전 전환 / 설정 변경이 호출한다.
 * 바뀐 게 없으면 false — 호출부가 쓸데없는 방송을 하지 않게 한다.
 */
function clearReady(game: RoomGame): boolean {
  let changed = false;
  for (const p of game.players.values()) {
    if (!p.ready) continue;
    p.ready = false;
    changed = true;
  }
  return changed;
}

/**
 * 설정 지문. 옵션 변경으로 준비를 풀 때 **값이 실제로 바뀐 경우에만** 풀려고 비교용으로 쓴다
 * (같은 값을 다시 보내는 프론트 스테퍼/토글에 준비가 풀리면 로비가 못 쓰게 된다).
 */
function settingsFingerprint(game: RoomGame): string {
  const o = game.options;
  const t = game.tetris;
  return [
    game.gameId,
    game.mode,
    o.boardSize,
    o.mapShape,
    o.difficulty,
    o.items,
    o.timeLimitSec,
    o.specials.mystery,
    o.specials.numbers,
    o.specials.keys,
    o.specials.walls,
    o.tools.hint,
    o.tools.shuffle,
    o.tools.wand,
    t
      ? [t.mode, t.sprintLines, t.startLevel, t.levelUpLines, t.hold, t.ghost, t.nextCount, t.garbageMul, t.riseSec, t.timeLimitSec].join(':')
      : '-',
  ].join('|');
}

function isPlayable(game: RoomGame, p: InternalPlayer, now: number): boolean {
  return (
    game.phase === 'playing' &&
    game.startAt !== null &&
    now >= game.startAt &&
    !p.forfeited &&
    p.finishedAt === null
  );
}

function boardOf(game: RoomGame, p: InternalPlayer): ServerBoard | undefined {
  return game.boards.get(p.boardId);
}

/**
 * 규칙 판정·막힘 검사용 뷰. v3부터 물음표 타일도 **진실 심볼로 판정**하므로(엿보기가 공짜라서)
 * 자물쇠만 장애물로 씌운다. pick/hint/movesLeft 전부 이 뷰를 쓴다.
 */
function ruleView(board: ServerBoard): PickView {
  return {
    cells: maskForClient(board.cells, NO_HIDDEN, board.locks),
    cols: board.cols,
    rows: board.rows,
    nextNumber: board.nextNumber,
    keysLeft: board.keysLeft,
  };
}

function toPublicBoard(b: ServerBoard): Board {
  return {
    id: b.id,
    cols: b.cols,
    rows: b.rows,
    cells: maskForClient(b.cells, b.hidden, b.locks),
    remaining: b.remaining,
    total: b.total,
    effects: b.effects.map((e) => ({ ...e })),
    shape: b.shape,
    nextNumber: b.nextNumber,
    keysLeft: b.keysLeft,
    movesLeft: b.movesLeft,
  };
}

/** 델타에 같이 싣는 보드 요약. 부수효과가 전부 끝난 뒤 값으로 찍는다(v2.1 A5). */
function boardPatch(b: ServerBoard): BoardPatch {
  return {
    remaining: b.remaining,
    total: b.total,
    nextNumber: b.nextNumber,
    keysLeft: b.keysLeft,
    movesLeft: b.movesLeft,
  };
}

/** v2.1: 연결 가능 쌍 수를 다시 센다. 판이 바뀔 때마다 호출. */
function recomputeMoves(board: ServerBoard): number {
  board.movesLeft = board.remaining > 0 ? findAllMoves(ruleView(board)).length : 0;
  return board.movesLeft;
}

interface ShuffledPayload {
  seq: number;
  boardId: string;
  cells: number[];
  cause: 'stuck' | 'attack' | 'item';
  movesLeft: number;
  board: BoardPatch;
  userId?: string;
}

/** 일반 심볼만 섞고 seq를 올린 페이로드를 만든다(브로드캐스트는 호출자가 순서를 맞춰서). */
function shuffleBoard(
  game: RoomGame,
  board: ServerBoard,
  cause: 'stuck' | 'attack' | 'item',
  userId?: string
): ShuffledPayload {
  board.cells = shuffleNormals({ ...ruleView(board), cells: board.cells }, board.hidden, board.locks, game.rng);
  recomputeMoves(board);
  game.seq++;
  return {
    seq: game.seq,
    boardId: board.id,
    cells: maskForClient(board.cells, board.hidden, board.locks),
    cause,
    movesLeft: board.movesLeft,
    board: boardPatch(board),
    ...(userId ? { userId } : {}),
  };
}

// --- 공격 (§1.7) -----------------------------------------------------------

function pickAttackTarget(game: RoomGame, attackerId: string): InternalPlayer | null {
  const candidates = [...game.players.values()].filter(
    (p) => p.userId !== attackerId && !p.forfeited && p.finishedAt === null
  );
  if (candidates.length === 0) return null;
  let best = Infinity;
  const leaders: InternalPlayer[] = [];
  for (const p of candidates) {
    const board = boardOf(game, p);
    const remaining = board ? board.remaining : Infinity;
    if (remaining < best) {
      best = remaining;
      leaders.length = 0;
      leaders.push(p);
    } else if (remaining === best) {
      leaders.push(p);
    }
  }
  if (leaders.length === 0) return null;
  return leaders[Math.floor(game.rng() * leaders.length)];
}

interface FiredAttack {
  event: AttackEvent;
  shuffled: ShuffledPayload | null;
}

function fireAttack(game: RoomGame, attacker: InternalPlayer, now: number): FiredAttack | null {
  const target = pickAttackTarget(game, attacker.userId);
  if (!target) return null;
  const board = boardOf(game, target);
  if (!board) return null;

  const type = ATTACK_TYPES[Math.floor(game.rng() * ATTACK_TYPES.length)];
  let until = now;
  let hidden: number[] | undefined;

  if (type === 'freeze') {
    until = now + FREEZE_MS;
    const effect: Effect = { type, until };
    board.effects.push(effect);
    scheduleEffectPurge(game, FREEZE_MS);
  } else if (type === 'fog') {
    until = now + FOG_MS;
    const tiles: number[] = [];
    for (let i = 0; i < board.cells.length; i++) if (board.cells[i] > 0) tiles.push(i);
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(game.rng() * (i + 1));
      const tmp = tiles[i];
      tiles[i] = tiles[j];
      tiles[j] = tmp;
    }
    hidden = tiles.slice(0, Math.max(1, Math.round(tiles.length * FOG_RATIO))).sort((a, b) => a - b);
    const effect: Effect = { type, until, hidden };
    board.effects.push(effect);
    scheduleEffectPurge(game, FOG_MS);
  } else {
    until = now + SHUFFLE_FX_MS;
  }

  game.seq++;
  const event: AttackEvent = {
    seq: game.seq,
    from: attacker.userId,
    to: target.userId,
    boardId: board.id,
    type,
    until,
    ...(hidden ? { hidden } : {}),
  };
  // shuffle은 즉시 효과: effects에 남기지 않고 판만 바꾼다(재접속 복구는 cells로 충분).
  const shuffled = type === 'shuffle' ? shuffleBoard(game, board, 'attack') : null;
  return { event, shuffled };
}

function scheduleEffectPurge(game: RoomGame, ms: number): void {
  const t = setTimeout(() => {
    game.effectTimers.delete(t);
    purgeEffects(game, Date.now());
  }, ms + 50);
  game.effectTimers.add(t);
}

// --- 종료·결과 (§1.6) ------------------------------------------------------

function buildResults(game: RoomGame): ResultRow[] {
  const players = [...game.players.values()];
  const remainingOf = (p: InternalPlayer) => boardOf(game, p)?.remaining ?? 0;

  if (game.gameId === 'tetris' && game.tetrisRun) {
    // 테트리스에는 "남은 패"가 없다 — ResultRow.remaining 자리에는 **지운 줄 수**를 넣는다.
    const rt = game.tetrisRun;
    return tetris
      .sortForResults(rt)
      .map((tp, i) => {
        const p = game.players.get(tp.userId);
        return {
          rank: i + 1,
          userId: tp.userId,
          nickname: p?.nickname ?? tp.userId,
          color: p?.color ?? PLAYER_COLORS[i % PLAYER_COLORS.length],
          score: tp.score,
          timeMs: tp.finishTimeMs,
          remaining: tp.lines,
          maxCombo: tp.maxCombo,
          pairsCleared: tp.lines,
        };
      });
  }

  if (game.mode === 'coop') {
    const shared = game.boards.get(SHARED_BOARD_ID);
    const cleared = !!shared && shared.remaining === 0;
    const teamTime =
      cleared && game.startAt !== null && game.endedAt !== null ? game.endedAt - game.startAt : null;
    return players
      .slice()
      .sort((a, b) => b.pairsCleared - a.pairsCleared || b.score - a.score)
      .map((p, i) => ({
        rank: i + 1,
        userId: p.userId,
        nickname: p.nickname,
        color: p.color,
        score: p.score,
        timeMs: teamTime, // 협동은 순위 대신 팀 기록 — 모든 행이 같은 클리어 시간을 갖는다
        remaining: remainingOf(p),
        maxCombo: p.maxCombo,
        pairsCleared: p.pairsCleared,
      }));
  }

  const groupOf = (p: InternalPlayer) => (p.finishedAt !== null ? 0 : p.forfeited ? 2 : 1);
  return players
    .slice()
    .sort((a, b) => {
      const ga = groupOf(a);
      const gb = groupOf(b);
      if (ga !== gb) return ga - gb;
      if (ga === 0) return (a.finishedAt ?? 0) - (b.finishedAt ?? 0);
      return remainingOf(a) - remainingOf(b) || b.score - a.score;
    })
    .map((p, i) => ({
      rank: i + 1,
      userId: p.userId,
      nickname: p.nickname,
      color: p.color,
      score: p.score,
      timeMs: p.finishedAt !== null && game.startAt !== null ? p.finishedAt - game.startAt : null,
      remaining: remainingOf(p),
      maxCombo: p.maxCombo,
      pairsCleared: p.pairsCleared,
    }));
}

function updateScoreboard(game: RoomGame, results: ResultRow[]): void {
  let table = scoreboards.get(game.slug);
  if (!table) {
    table = new Map();
    scoreboards.set(game.slug, table);
  }
  for (const row of results) {
    const prev = table.get(row.userId) ?? {
      userId: row.userId,
      nickname: row.nickname,
      wins: 0,
      games: 0,
      bestTimeMs: null,
    };
    prev.nickname = row.nickname;
    prev.games += 1;
    // 사천성 협동만 승패가 없다. 테트리스는 3종 모두 등수가 나오므로 승수를 센다.
    if (game.gameId === 'tetris' || game.mode === 'race') {
      if (row.rank === 1) prev.wins += 1;
      if (row.timeMs !== null && (prev.bestTimeMs === null || row.timeMs < prev.bestTimeMs)) {
        prev.bestTimeMs = row.timeMs;
      }
    }
    table.set(row.userId, prev);
  }
}

/**
 * finished → lobby 복귀 (§Z3). 자동 타이머와 수동 `rematch` 가 같은 길을 쓴다.
 * 결과(results)는 비운다 — 로비 화면에 지난 판 결과가 남으면 안 된다.
 * 누적 전적(scoreboard)은 방 단위라 여기서 건드리지 않는다.
 */
function returnToLobby(game: RoomGame, reason: string): GameSnapshot {
  clearTimers(game); // 자동 복귀 타이머 포함해서 전부 정리
  // 기권했던 사람도 다음 판 기본 참가(아래 루프에서 forfeited 까지 리셋된다). 빠지려면 game:spectate.
  game.phase = 'lobby';
  game.startAt = null;
  game.endedAt = null;
  game.results = null;
  game.boards.clear();
  game.tetrisRun = null; // 타이머는 위 clearTimers 에서 이미 껐다
  game.sharedItems = { ...game.options.tools };
  for (const p of game.players.values()) {
    p.score = 0;
    p.combo = 0;
    p.maxCombo = 0;
    p.pairsCleared = 0;
    p.lines = 0;
    p.ko = 0;
    p.lastMatchAt = 0;
    p.items = { ...(game.mode === 'coop' ? game.sharedItems : game.options.tools) };
    p.finishedAt = null;
    p.forfeited = false;
    p.hintBreak = false;
    p.ready = false; // 로비로 왔으면 다시 준비를 받아야 한다
  }
  console.log(`[game] ${game.slug} back to lobby (${reason})`);
  return emitState(game);
}

function endGame(game: RoomGame, reason: string): void {
  if (game.phase === 'finished') return;
  clearTimers(game);
  game.phase = 'finished';
  game.endedAt = Date.now();
  game.results = buildResults(game);
  updateScoreboard(game, game.results);
  console.log(`[game] ${game.slug} finished (${game.mode}, ${reason})`);
  emitState(game);

  // 결과를 잠깐 보여준 뒤 자동으로 로비(=준비 단계)로. 그 사이에 수동 복귀하면 clearTimers 가 끈다.
  game.lobbyTimer = setTimeout(() => {
    game.lobbyTimer = null;
    if (games.get(game.slug) !== game) return; // 이미 닫힌 게임
    if (game.phase !== 'finished') return;
    returnToLobby(game, 'auto');
  }, lobbyReturnDelayMs);
}

function maybeEndByExhaustion(game: RoomGame): void {
  if (game.phase !== 'playing') return;
  const players = [...game.players.values()];
  if (players.length === 0) return;
  if (game.gameId === 'tetris') {
    if (game.tetrisRun) tetris.checkEnd(game.tetrisRun);
    return;
  }
  if (game.mode === 'coop') {
    const board = game.boards.get(SHARED_BOARD_ID);
    if (board && board.remaining === 0) endGame(game, 'board cleared');
    else if (players.every((p) => p.forfeited)) endGame(game, 'all forfeited');
    return;
  }
  if (players.every((p) => p.finishedAt !== null || p.forfeited)) endGame(game, 'all players done');
}

function transferHostIfNeeded(game: RoomGame, leavingUserId: string): void {
  if (game.hostUserId !== leavingUserId) return;
  const nextPlayer =
    [...game.players.values()].find((p) => p.connected && p.userId !== leavingUserId) ??
    [...game.players.values()].find((p) => p.userId !== leavingUserId);
  if (nextPlayer) {
    game.hostUserId = nextPlayer.userId;
    console.log(`[game] ${game.slug} host -> ${nextPlayer.userId}`);
    return;
  }
  const nextSpectator = [...game.spectators.values()].find((s) => s.userId !== leavingUserId);
  if (nextSpectator) {
    game.hostUserId = nextSpectator.userId;
    console.log(`[game] ${game.slug} host -> spectator ${nextSpectator.userId}`);
  }
}

function deleteGame(game: RoomGame, notify: boolean): void {
  clearTimers(game);
  games.delete(game.slug);
  if (notify) broadcast(game.slug, 'game:state', { state: null });
}

/** 소모품 1개 사용. 쟁탈전은 공유 카운트라 전원에 미러한다. 남은 게 없으면 false. */
function consumeItem(game: RoomGame, player: InternalPlayer, kind: keyof PlayerItems): boolean {
  if (game.mode === 'coop') {
    if (game.sharedItems[kind] <= 0) return false;
    game.sharedItems[kind] -= 1;
    for (const p of game.players.values()) p.items = { ...game.sharedItems };
    return true;
  }
  if (player.items[kind] <= 0) return false;
  player.items[kind] -= 1;
  return true;
}

/** 아이템 사용은 콤보를 끊는다 (v3 §W1). */
function breakCombo(player: InternalPlayer): void {
  player.combo = 0;
  player.lastMatchAt = 0;
  player.hintBreak = false;
}

/** 판을 다 지웠을 때의 종료 처리 (pick / 여의봉 공용) */
function finishBoard(game: RoomGame, player: InternalPlayer): void {
  if (game.mode === 'race') {
    player.finishedAt = Date.now();
    endGame(game, `${player.userId} cleared`); // 레이스는 1등이 나오면 즉시 종료
  } else {
    endGame(game, 'coop cleared');
  }
}

// --- 옵션 병합 (v2 §V2: 전부 optional, 부분 병합) ----------------------------

/** GameOptions 의 모든 필드를 optional 로 — 새 필드를 넣으면 여기와 mergeOptions 둘 다 고칠 것. */
export type OptionsPatch = Partial<Omit<GameOptions, 'specials' | 'tools'>> & {
  specials?: Partial<SpecialToggles>;
  tools?: Partial<PlayerItems>;
};

/** 아이템 횟수를 허용 범위로 자른다 (v4 §X2.3) */
function clampTools(tools: PlayerItems): PlayerItems {
  const clamp = (v: number, kind: keyof PlayerItems) =>
    Math.max(TOOL_LIMITS[kind].min, Math.min(TOOL_LIMITS[kind].max, Math.round(v) || 0));
  return { hint: clamp(tools.hint, 'hint'), shuffle: clamp(tools.shuffle, 'shuffle'), wand: clamp(tools.wand, 'wand') };
}

function mergeOptions(base: GameOptions, patch: OptionsPatch | undefined, mode: GameMode): GameOptions {
  const next: GameOptions = { ...base, specials: { ...base.specials }, tools: { ...base.tools } };
  if (patch) {
    if (patch.boardSize) next.boardSize = patch.boardSize;
    if (patch.mapShape) next.mapShape = patch.mapShape;
    if (patch.difficulty) next.difficulty = patch.difficulty;
    if (patch.tools) {
      next.tools = clampTools({ ...next.tools, ...patch.tools });
    }
    if (typeof patch.items === 'boolean') next.items = patch.items;
    if (typeof patch.timeLimitSec === 'number') next.timeLimitSec = patch.timeLimitSec;
    if (patch.specials) next.specials = { ...next.specials, ...patch.specials };
  }
  if (mode === 'coop') next.items = false; // 협동에는 방해 아이템 없음
  return next;
}

// --- 테트리스 옵션 (T2) -----------------------------------------------------

export type TetrisPatch = Partial<TetrisOptions>;

/** 허용 목록에서 가장 가까운 값으로 스냅한다 — 프론트가 이상한 값을 보내도 에러 대신 보정. */
function snapTo(list: readonly number[], v: number): number {
  let best = list[0];
  for (const x of list) if (Math.abs(x - v) < Math.abs(best - v)) best = x;
  return best;
}

function clampRange(v: number, range: { min: number; max: number }): number {
  return Math.max(range.min, Math.min(range.max, Math.round(v) || range.min));
}

/**
 * 부분 병합 + 범위 보정. 대전 방식이 바뀌면 **그 모드 기본값**을 바탕으로 다시 쌓는다 —
 * 레이스에 쓰레기 배수가, 서바이벌에 상승 주기 0이 남아 있으면 모드가 무의미해지기 때문.
 */
function mergeTetris(base: TetrisOptions, patch: TetrisPatch | undefined): TetrisOptions {
  let next: TetrisOptions = { ...base };
  if (patch?.mode && patch.mode !== base.mode) next = { ...DEFAULT_TETRIS_OPTIONS[patch.mode] };
  if (patch) {
    if (typeof patch.sprintLines === 'number') next.sprintLines = snapTo(TETRIS_LIMITS.sprintLines, patch.sprintLines);
    if (typeof patch.startLevel === 'number') next.startLevel = clampRange(patch.startLevel, TETRIS_LIMITS.startLevel);
    if (typeof patch.levelUpLines === 'number') next.levelUpLines = snapTo(TETRIS_LIMITS.levelUpLines, patch.levelUpLines);
    if (typeof patch.hold === 'boolean') next.hold = patch.hold;
    if (typeof patch.ghost === 'boolean') next.ghost = patch.ghost;
    if (typeof patch.nextCount === 'number') next.nextCount = clampRange(patch.nextCount, TETRIS_LIMITS.nextCount);
    if (typeof patch.garbageMul === 'number') next.garbageMul = snapTo(TETRIS_LIMITS.garbageMul, patch.garbageMul);
    if (typeof patch.riseSec === 'number') next.riseSec = snapTo(TETRIS_LIMITS.riseSec, patch.riseSec);
    if (typeof patch.timeLimitSec === 'number') {
      next.timeLimitSec = Math.max(0, Math.min(3600, Math.round(patch.timeLimitSec) || 0));
    }
  }
  return next;
}

/** 제한 시간은 게임마다 다른 옵션에 들어 있다. */
function timeLimitSecOf(game: RoomGame): number {
  if (game.gameId === 'tetris') return game.tetris?.timeLimitSec ?? 0;
  return game.options.timeLimitSec;
}

/**
 * 테트리스 입력을 받을 수 있는 상태인가. 게임이 없거나 사천성이거나 아직 안 시작했으면 null —
 * 호출부는 조용히 무시한다(클라가 늦게 보낸 프레임에 에러를 띄울 이유가 없다).
 */
function activeTetris(slug: string, userId: string): tetris.TetrisRuntime | null {
  const game = games.get(slug);
  if (!game || game.gameId !== 'tetris' || !game.tetrisRun) return null;
  if (game.phase !== 'playing') return null;
  if (!game.players.has(userId)) return null;
  if (game.startAt !== null && Date.now() < game.startAt) return null;
  return game.tetrisRun;
}

/** 진행 중 기권(관전 전환·접속 끊김)을 테트리스 쪽에도 알린다. */
function tetrisForfeit(game: RoomGame, userId: string): void {
  if (game.gameId !== 'tetris' || !game.tetrisRun) return;
  if (game.phase !== 'playing' && game.phase !== 'countdown') return;
  tetris.onForfeit(game.tetrisRun, userId);
}

// --- 제거 부수효과 (v2 §V3) -------------------------------------------------

interface TilesPayload {
  seq: number;
  boardId: string;
  tiles: { idx: number; symbol: number }[];
  movesLeft: number;
  board: BoardPatch;
  keyType?: number;
}

interface RemovalEffects {
  unlocked: TilesPayload | null;
}

/**
 * 두 칸을 실제로 지우고 규칙 상태를 갱신한다.
 * - 열쇠 쌍이었으면 자물쇠 전부 해제 → game:unlocked
 * - 숫자 쌍이었으면 nextNumber 진행
 * seq는 방출 순서(matched → unlocked)에 맞춰 여기서 올린다.
 */
function applyRemoval(game: RoomGame, board: ServerBoard, a: number, b: number): RemovalEffects {
  const value = board.cells[a];
  const keyType = isKey(value) ? value - KEY_BASE : 0;
  const wasNumber = value > NUMBER_BASE;

  board.cells[a] = EMPTY;
  board.cells[b] = EMPTY;
  for (const idx of [a, b]) {
    board.hidden.delete(idx);
    board.locks.delete(idx);
  }
  board.remaining -= 2;

  // v4: 인접 물음표 자동 공개는 없다. `?` 는 오직 game:peek 로 본인에게만 보인다.
  recomputeMoves(board);

  let unlocked: TilesPayload | null = null;
  if (keyType > 0) {
    board.keysLeft = Math.max(0, board.keysLeft - 1);
    // 같은 색 자물쇠만 풀린다 (v3 §W1)
    const freed = [...board.locks.entries()].filter(([, k]) => k === keyType).map(([idx]) => idx);
    if (freed.length > 0) {
      for (const idx of freed) board.locks.delete(idx);
      recomputeMoves(board); // 자물쇠가 풀리면 연결 가능 쌍이 늘어난다
      unlocked = {
        seq: ++game.seq,
        boardId: board.id,
        tiles: freed.sort((x, y) => x - y).map((idx) => ({ idx, symbol: board.cells[idx] })),
        movesLeft: board.movesLeft,
        board: boardPatch(board),
        keyType,
      };
    }
  }
  if (wasNumber) {
    board.nextNumber = board.nextNumber < board.maxNumber ? board.nextNumber + 1 : 0;
  }
  recomputeMoves(board);
  return { unlocked };
}

interface StuckResolution {
  shuffled: ShuffledPayload | null;
  systemMatch: { seq: number; a: number; b: number; effects: RemovalEffects } | null;
}

/**
 * 막힘 처리 (v2 §V3): 일반 심볼 셔플로 먼저 풀고, 그래도 수가 없으면 규칙 장애물(열쇠 → 숫자 → 아무 쌍)
 * 한 쌍을 서버가 직접 치운다. 이 마지막 수단은 selfcheck에서 1% 미만이어야 한다.
 */
function resolveStuck(game: RoomGame, board: ServerBoard): StuckResolution {
  if (board.remaining <= 0) return { shuffled: null, systemMatch: null };
  if (board.movesLeft > 0) return { shuffled: null, systemMatch: null };

  const shuffled = shuffleBoard(game, board, 'stuck');
  if (board.movesLeft > 0) return { shuffled, systemMatch: null };

  const pair = findBlockerPair(board);
  if (!pair) {
    console.warn(`[game] board ${board.id} stuck with no removable pair (remaining=${board.remaining})`);
    return { shuffled, systemMatch: null };
  }
  console.log(`[game] ${game.slug} board ${board.id} unstuck by system removal`);
  const seq = ++game.seq;
  const effects = applyRemoval(game, board, pair[0], pair[1]);
  return { shuffled, systemMatch: { seq, a: pair[0], b: pair[1], effects } };
}

/** 방출 대기 중인 델타. board는 마지막에 최종 patch를 찍기 위한 참조. */
interface PendingDelta {
  event: string;
  payload: Record<string, unknown>;
  board: ServerBoard;
}

/** 막힘 처리 결과를 순서대로 모은다(브로드캐스트는 호출자가 마지막에 한다). */
function collectStuckResolution(game: RoomGame, board: ServerBoard): PendingDelta[] {
  const out: PendingDelta[] = [];
  for (let round = 0; round < 3; round++) {
    const res = resolveStuck(game, board);
    if (res.shuffled) out.push({ event: 'game:shuffled', payload: { ...res.shuffled }, board });
    if (!res.systemMatch) return out;
    const { seq, a, b, effects } = res.systemMatch;
    out.push({
      event: 'game:matched',
      payload: {
        seq,
        userId: SYSTEM_USER,
        boardId: board.id,
        a,
        b,
        path: [],
        combo: 0,
        score: 0,
        remaining: board.remaining,
        movesLeft: board.movesLeft,
      },
      board,
    });
    if (effects.unlocked) out.push({ event: 'game:unlocked', payload: { ...effects.unlocked }, board });
    if (board.remaining === 0) return out;
  }
  return out;
}

/**
 * 모은 델타를 순서대로 방출한다. board patch는 **판 변화가 전부 끝난 지금** 값으로 다시 찍는다 —
 * 그래야 클라가 마지막 델타만 적용해도 nextNumber/keysLeft/movesLeft가 서버와 일치한다.
 */
const BOARD_DELTA_EVENTS = new Set(['game:matched', 'game:unlocked', 'game:shuffled']);

function flushDeltas(game: RoomGame, deltas: PendingDelta[]): void {
  recomputeRanks(game); // 판이 바뀌었으니 등수도 갱신 (다음 스냅샷에 실린다)
  for (const d of deltas) {
    if (BOARD_DELTA_EVENTS.has(d.event)) d.payload.board = boardPatch(d.board);
    broadcast(game.slug, d.event, d.payload);
  }
}

/** 막힘 해소용: 열쇠 쌍 → nextNumber 쌍 → 아무 같은 값 쌍(경로 무시) 순으로 한 쌍 고른다. */
function findBlockerPair(board: ServerBoard): [number, number] | null {
  const pick = (test: (v: number) => boolean): [number, number] | null => {
    const found: number[] = [];
    for (let i = 0; i < board.cells.length; i++) {
      if (board.cells[i] > 0 && test(board.cells[i])) found.push(i);
      if (found.length === 2) return [found[0], found[1]];
    }
    return null;
  };
  if (board.keysLeft > 0) {
    for (let k = 1; k <= MAX_KEY_TYPES; k++) {
      const keyPair = pick((v) => v === KEY_BASE + k);
      if (keyPair) return keyPair;
    }
  }
  if (board.nextNumber > 0) {
    const numberPair = pick((v) => v === NUMBER_BASE + board.nextNumber);
    if (numberPair) return numberPair;
  }
  const byValue = new Map<number, number>();
  for (let i = 0; i < board.cells.length; i++) {
    const v = board.cells[i];
    if (v <= 0 || v > NUMBER_BASE) continue;
    const first = byValue.get(v);
    if (first !== undefined) return [first, i];
    byValue.set(v, i);
  }
  return null;
}

/**
 * 카운트다운 → playing 전환. 사천성/테트리스가 같은 흐름을 쓴다(연출 타이밍이 같아야 하므로).
 * 제한 시간 타이머는 각 게임의 옵션에서 읽는다.
 */
function beginCountdown(game: RoomGame): GameSnapshot {
  game.phase = 'countdown';
  game.startAt = Date.now() + COUNTDOWN_MS;
  game.endedAt = null;
  game.results = null;
  const state = emitState(game);

  game.countdownTimer = setTimeout(() => {
    game.countdownTimer = null;
    if (game.phase !== 'countdown') return;
    game.phase = 'playing';
    if (game.tetrisRun) tetris.beginTetris(game.tetrisRun); // 프레임 릴레이/바닥 상승은 지금부터
    emitState(game);
    const limit = timeLimitSecOf(game);
    if (limit > 0) {
      game.limitTimer = setTimeout(() => {
        game.limitTimer = null;
        endGame(game, 'time limit');
      }, limit * 1000);
    }
  }, COUNTDOWN_MS);

  return state;
}

// --- 공개 API --------------------------------------------------------------

export const gameManager = {
  setBroadcast,

  getSnapshot(slug: string): GameSnapshot | null {
    const game = games.get(slug);
    return game ? snapshot(game) : null;
  },

  create(
    slug: string,
    actor: GameActor,
    input: { gameId?: GameId; mode?: GameMode; options?: OptionsPatch; tetris?: TetrisPatch }
  ): StateResult {
    if (games.has(slug)) return { error: '이미 게임이 열려 있어요' };
    const mode: GameMode = input.mode ?? 'race';
    const options = mergeOptions(DEFAULT_OPTIONS[mode], input.options, mode);
    const gameId: GameId = input.gameId ?? 'shisen';
    const tetrisMode: TetrisMode = input.tetris?.mode ?? 'versus';

    const game: RoomGame = {
      slug,
      gameId,
      phase: 'lobby',
      hostUserId: actor.userId,
      mode,
      options,
      tetris: gameId === 'tetris' ? mergeTetris(DEFAULT_TETRIS_OPTIONS[tetrisMode], input.tetris) : null,
      tetrisRun: null,
      seed: newSeed(),
      startAt: null,
      endedAt: null,
      players: new Map(),
      boards: new Map(),
      spectators: new Map(),
      results: null,
      seq: 0,
      rng: mulberry32(newSeed()),
      sharedItems: { ...options.tools },
      countdownTimer: null,
      limitTimer: null,
      lobbyTimer: null,
      forfeitTimers: new Map(),
      effectTimers: new Set(),
    };
    game.players.set(actor.userId, makePlayer(game, actor));
    games.set(slug, game);
    console.log(`[game] ${slug} created by ${actor.userId} (${gameId}/${gameId === 'tetris' ? tetrisMode : mode})`);
    return { state: emitState(game) };
  },

  join(slug: string, actor: GameActor): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    const existing = game.players.get(actor.userId);
    if (existing) {
      existing.connected = true;
      existing.nickname = actor.nickname;
      return { state: emitState(game) };
    }
    if (game.phase !== 'lobby') return { error: '게임이 이미 시작됐어요' };
    if (game.players.size >= MAX_PLAYERS) return { error: `플레이어가 가득 찼어요 (최대 ${MAX_PLAYERS}명)` };
    game.spectators.delete(actor.userId);
    game.players.set(actor.userId, makePlayer(game, actor));
    clearReady(game); // 사람이 늘었으면 전원 다시 준비 (§Z3)
    return { state: emitState(game) };
  },

  spectate(slug: string, actor: GameActor): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    const player = game.players.get(actor.userId);

    if (player && (game.phase === 'playing' || game.phase === 'countdown')) {
      // 진행 중 관전 전환 = 기권. 결과 집계를 위해 플레이어 목록에는 남긴다(최하위 그룹).
      if (!player.forfeited) {
        player.forfeited = true;
        player.combo = 0;
        console.log(`[game] ${slug} ${actor.userId} forfeited`);
        tetrisForfeit(game, actor.userId);
      }
      maybeEndByExhaustion(game); // 혼자 하던 판이면 기권으로 바로 끝난다
      if ((game.phase as GamePhase) !== 'finished') emitState(game);
      return { state: snapshot(game) };
    }

    if (player) {
      // 로비/종료 상태에서의 관전 전환. host는 관전자가 되어도 그대로 host다(이양은 이탈 때만).
      game.players.delete(actor.userId);
      if (game.mode === 'race') game.boards.delete(player.boardId);
      clearReady(game); // 구성이 바뀌었으니 전원 다시 준비 (§Z3)
    }
    game.spectators.set(actor.userId, { userId: actor.userId, nickname: actor.nickname });
    return { state: emitState(game) };
  },

  updateOptions(
    slug: string,
    actor: GameActor,
    input: { gameId?: GameId; mode?: GameMode; options?: OptionsPatch; tetris?: TetrisPatch }
  ): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    if (game.hostUserId !== actor.userId) return { error: '게임 개설자만 바꿀 수 있어요' };
    if (game.phase !== 'lobby') return { error: '로비에서만 바꿀 수 있어요' };
    const before = settingsFingerprint(game);

    if (input.gameId && input.gameId !== game.gameId) {
      // 게임을 갈아타면 그 게임의 기본 설정으로 시작한다(사천성으로 돌아가면 테트리스 설정은 버린다)
      game.gameId = input.gameId;
      game.tetris =
        input.gameId === 'tetris' ? { ...DEFAULT_TETRIS_OPTIONS[input.tetris?.mode ?? 'versus'] } : null;
      game.tetrisRun = null;
      for (const p of game.players.values()) {
        p.lines = 0;
        p.ko = 0;
        p.score = 0;
      }
    }
    if (game.gameId === 'tetris') {
      game.tetris = mergeTetris(game.tetris ?? DEFAULT_TETRIS_OPTIONS.versus, input.tetris);
    }
    // 대전 방식이 바뀌어도 맵 모양·특수 타일은 그대로 두고, 판 크기/제한 시간만 새 모드 기본값으로
    // 되돌린다(coop은 mergeOptions에서 items=false 강제). — A6
    let base = game.options;
    if (input.mode && input.mode !== game.mode) {
      game.mode = input.mode;
      const defaults = DEFAULT_OPTIONS[input.mode];
      base = {
        ...game.options,
        boardSize: defaults.boardSize,
        timeLimitSec: defaults.timeLimitSec,
        tools: { ...defaults.tools }, // 아이템 횟수는 모드 기본값으로 (v4 §X2.3)
      };
      for (const p of game.players.values()) p.boardId = boardIdFor(game.mode, p.userId);
    }
    game.options = mergeOptions(base, input.options, game.mode);
    // 설정을 바꿔 놓고 바로 시작하는 걸 막는다. 단, 같은 값을 다시 보낸 경우엔 풀지 않는다 (§Z3).
    if (settingsFingerprint(game) !== before) clearReady(game);
    return { state: emitState(game) };
  },

  /** 로비 준비 토글 (§Z3). 로비에서, 플레이어만. */
  setReady(slug: string, actor: GameActor, ready: boolean): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    if (game.phase !== 'lobby') return { error: '로비에서만 준비할 수 있어요' };
    const player = game.players.get(actor.userId);
    if (!player) return { error: '참가한 사람만 준비할 수 있어요' };
    if (player.ready === ready) return { state: snapshot(game) }; // 변화 없으면 방송하지 않는다
    player.ready = ready;
    return { state: emitState(game) };
  },

  start(slug: string, actor: GameActor): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    if (game.hostUserId !== actor.userId) return { error: '게임 개설자만 시작할 수 있어요' };
    if (game.phase !== 'lobby') return { error: '로비에서만 시작할 수 있어요' };
    const players = [...game.players.values()];
    if (players.length === 0) return { error: '플레이어가 최소 1명 필요해요' };
    // 방장 본인의 준비는 보지 않는다 — 시작 버튼을 누르는 것이 곧 동의다 (§Z3).
    // 방장 혼자면(플레이어 1명) 준비 없이 바로 시작.
    if (players.some((p) => p.userId !== game.hostUserId && !p.ready)) {
      return { error: '아직 준비하지 않은 사람이 있어요' };
    }
    for (const p of players) p.ready = false; // 다음 로비에서 다시 받는다

    game.seed = newSeed();
    game.rng = mulberry32(game.seed);
    game.boards.clear();

    if (game.gameId === 'tetris') {
      // 테트리스 판은 클라가 seed 로 직접 만든다(T1) — 서버는 보드를 갖지 않는다.
      const options = game.tetris ?? { ...DEFAULT_TETRIS_OPTIONS.versus };
      game.tetris = options;
      tetris.stopTetris(game.tetrisRun);
      game.tetrisRun = tetris.createTetris(options, [...game.players.keys()], {
        broadcast: (event, payload) => broadcast(game.slug, event, payload),
        onPlayerUpdate: () => emitState(game),
        onEnd: (reason) => endGame(game, reason),
        rng: () => game.rng(),
        isPlaying: () => game.phase === 'playing',
      });
      for (const p of players) {
        p.score = 0;
        p.combo = 0;
        p.maxCombo = 0;
        p.pairsCleared = 0;
        p.lines = 0;
        p.ko = 0;
        p.lastMatchAt = 0;
        p.finishedAt = null;
        p.forfeited = false;
        p.hintBreak = false;
      }
      console.log(
        `[game] ${slug} tetris ${options.mode} lv${options.startLevel} mul${options.garbageMul} ` +
          `rise${options.riseSec} (seed ${game.seed})`
      );
      return { state: beginCountdown(game) };
    }

    const { cols, rows } = BOARD_DIMS[game.options.boardSize];
    const specials = game.options.specials;

    const t0 = Date.now();
    const shape: Shape = game.options.mapShape === 'random' ? pickShape(game.rng) : game.options.mapShape;
    const numbers = specials.numbers ? NUMBERS_PER_SIZE[game.options.boardSize] : 0;
    const keyTypes = specials.keys ? KEY_TYPES_PER_SIZE[game.options.boardSize] : 0;
    // 일반 심볼이 4타일 단위로 딱 떨어지도록 열쇠 쌍 수만큼 여분을 둔다
    const wantMod4Plus = ((keyTypes * 2) % 4) as 0 | 2;
    const mask = buildMask(shape, cols, rows, game.rng, wantMod4Plus);
    const generated = generateBoardV2(
      {
        cols,
        rows,
        mask,
        walls: specials.walls,
        numbers,
        keyTypes,
        mystery: specials.mystery,
        difficulty: game.options.difficulty,
      },
      game.rng
    );
    const makeBoard = (id: string): ServerBoard => ({
      id,
      cols,
      rows,
      cells: generated.cells.slice(),
      hidden: new Set(generated.hidden),
      locks: new Map(generated.locks),
      remaining: countRemaining(generated.cells),
      total: countRemaining(generated.cells),
      effects: [],
      shape,
      nextNumber: numbers > 0 ? 1 : 0,
      maxNumber: numbers,
      keysLeft: keyTypes,
      movesLeft: 0,
    });
    if (game.mode === 'coop') {
      game.boards.set(SHARED_BOARD_ID, makeBoard(SHARED_BOARD_ID));
    } else {
      for (const p of players) game.boards.set(p.userId, makeBoard(p.userId)); // 레이스는 전원 동일한 판
    }
    for (const b of game.boards.values()) recomputeMoves(b);
    console.log(
      `[game] ${slug} board ${shape} ${cols}x${rows} tiles=${countRemaining(generated.cells)} ` +
        `walls=${specials.walls} numbers=${numbers} keyTypes=${keyTypes} mystery=${specials.mystery} ` +
        `d=${game.options.difficulty} ` +
        `in ${Date.now() - t0}ms (seed ${game.seed})`
    );

    game.sharedItems = { ...game.options.tools };
    for (const p of players) {
      p.boardId = boardIdFor(game.mode, p.userId);
      p.score = 0;
      p.combo = 0;
      p.maxCombo = 0;
      p.pairsCleared = 0;
      p.lines = 0; // 테트리스 전용 필드 — 게임을 갈아탄 방에 지난 판 값이 남지 않게 한다
      p.ko = 0;
      p.lastMatchAt = 0;
      p.items = { ...(game.mode === 'coop' ? game.sharedItems : game.options.tools) };
      p.finishedAt = null;
      p.forfeited = false;
      p.hintBreak = false;
    }

    return { state: beginCountdown(game) };
  },

  pick(slug: string, actor: GameActor, a: number, b: number): PickAck {
    const game = games.get(slug);
    if (!game) return { ok: false, reason: 'phase' };
    const player = game.players.get(actor.userId);
    if (!player) return { ok: false, reason: 'phase' };
    const now = Date.now();
    if (!isPlayable(game, player, now)) return { ok: false, reason: 'phase' };
    const board = boardOf(game, player);
    if (!board) return { ok: false, reason: 'phase' };

    if (board.effects.some((e) => e.type === 'freeze' && e.until > now)) {
      return { ok: false, reason: 'frozen' };
    }
    // v3: 물음표도 진실 심볼로 판정한다(엿보기가 공짜라서). 자물쇠만 장애물.
    const view = ruleView(board);
    const reason = canPick(view, a, b);
    if (reason) return { ok: false, reason };
    const path = findPath(view.cells, board.cols, board.rows, a, b)!;

    // --- 제거 확정 ---
    // seq는 실제 방출 순서대로 올라가야 한다(클라가 seq로 늦은 델타를 버리므로):
    // matched → unlocked → attack → shuffled.
    const matchedSeq = ++game.seq;
    const effects = applyRemoval(game, board, a, b);

    if (player.hintBreak) {
      player.combo = 1;
      player.hintBreak = false;
    } else if (player.lastMatchAt > 0 && now - player.lastMatchAt <= COMBO_WINDOW_MS) {
      player.combo = Math.min(player.combo + 1, MAX_COMBO);
    } else {
      player.combo = 1;
    }
    player.maxCombo = Math.max(player.maxCombo, player.combo);
    player.lastMatchAt = now;
    player.pairsCleared += 1;
    player.score += 10 + 5 * (player.combo - 1);

    let attack: FiredAttack | null = null;
    if (game.mode === 'race' && game.options.items && ATTACK_COMBO_STEPS.includes(player.combo)) {
      attack = fireAttack(game, player, now);
    }

    const deltas: PendingDelta[] = [
      {
        event: 'game:matched',
        payload: {
          seq: matchedSeq,
          userId: player.userId,
          boardId: board.id,
          a,
          b,
          path,
          combo: player.combo,
          score: player.score,
          remaining: board.remaining,
          movesLeft: board.movesLeft,
          ...(attack ? { attack: attack.event } : {}),
        },
        board,
      },
    ];
    if (effects.unlocked) deltas.push({ event: 'game:unlocked', payload: { ...effects.unlocked }, board });

    const targetBoard = attack ? game.boards.get(attack.event.boardId) ?? board : board;
    if (attack) {
      deltas.push({ event: 'game:attack', payload: { ...attack.event }, board: targetBoard });
      if (attack.shuffled) {
        deltas.push({ event: 'game:shuffled', payload: { ...attack.shuffled }, board: targetBoard });
      }
      // 공격 맞은 판도 막히면 바로 재배치 (v2.1)
      if (targetBoard !== board) deltas.push(...collectStuckResolution(game, targetBoard));
    }

    // 막힘 검사 (§1.4 + v2 §V3)
    deltas.push(...collectStuckResolution(game, board));
    flushDeltas(game, deltas);

    if (board.remaining === 0) finishBoard(game, player);

    return { ok: true, path };
  },

  /**
   * 물음표 일회성 엿보기 (v3 §W1). 요청자에게만 심볼을 알려 주고 **서버 상태는 바뀌지 않는다**
   * (브로드캐스트 없음). 영구 공개는 인접 제거(game:revealed)로만 일어난다.
   */
  peek(slug: string, actor: GameActor, idx: number): PeekAck {
    const game = games.get(slug);
    if (!game) return { ok: false, reason: 'phase' };
    const player = game.players.get(actor.userId);
    if (!player) return { ok: false, reason: 'phase' };
    const now = Date.now();
    if (!isPlayable(game, player, now)) return { ok: false, reason: 'phase' };
    const board = boardOf(game, player);
    if (!board) return { ok: false, reason: 'phase' };
    if (board.effects.some((e) => e.type === 'freeze' && e.until > now)) {
      return { ok: false, reason: 'frozen' };
    }
    if (idx < 0 || idx >= board.cells.length || board.cells[idx] <= 0) return { ok: false, reason: 'gone' };
    if (board.locks.has(idx)) return { ok: false, reason: 'locked' };
    if (!board.hidden.has(idx)) return { ok: false, reason: 'gone' };
    return { ok: true, symbol: board.cells[idx] };
  },

  /** F2 재배치: 자기 판(쟁탈전=공유 판)을 섞는다. 콤보는 끊긴다. */
  useShuffle(slug: string, actor: GameActor): ItemAck {
    const game = games.get(slug);
    if (!game) return { ok: false, reason: 'phase' };
    const player = game.players.get(actor.userId);
    if (!player) return { ok: false, reason: 'phase' };
    const now = Date.now();
    if (!isPlayable(game, player, now)) return { ok: false, reason: 'phase' };
    const board = boardOf(game, player);
    if (!board) return { ok: false, reason: 'phase' };
    if (board.effects.some((e) => e.type === 'freeze' && e.until > now)) return { ok: false, reason: 'frozen' };
    if (!consumeItem(game, player, 'shuffle')) return { ok: false, reason: 'none' };

    breakCombo(player);
    const deltas: PendingDelta[] = [
      { event: 'game:shuffled', payload: { ...shuffleBoard(game, board, 'item', player.userId) }, board },
    ];
    deltas.push(...collectStuckResolution(game, board));
    flushDeltas(game, deltas);
    emitState(game);
    return { ok: true };
  },

  /** F3 여의봉: 서버가 유효한 쌍 하나를 대신 지워 준다. 점수 +10 고정, 콤보는 끊긴다. */
  useWand(slug: string, actor: GameActor): ItemAck {
    const game = games.get(slug);
    if (!game) return { ok: false, reason: 'phase' };
    const player = game.players.get(actor.userId);
    if (!player) return { ok: false, reason: 'phase' };
    const now = Date.now();
    if (!isPlayable(game, player, now)) return { ok: false, reason: 'phase' };
    const board = boardOf(game, player);
    if (!board) return { ok: false, reason: 'phase' };
    if (board.effects.some((e) => e.type === 'freeze' && e.until > now)) return { ok: false, reason: 'frozen' };

    const pair = findAnyMove(ruleView(board));
    if (!pair) return { ok: false, reason: 'none' };
    if (!consumeItem(game, player, 'wand')) return { ok: false, reason: 'none' };

    breakCombo(player);
    player.pairsCleared += 1;
    player.score += WAND_SCORE;
    const [a, b] = pair;
    const path = findPath(ruleView(board).cells, board.cols, board.rows, a, b) ?? [];
    const matchedSeq = ++game.seq;
    const effects = applyRemoval(game, board, a, b);
    const deltas: PendingDelta[] = [
      {
        event: 'game:matched',
        payload: {
          seq: matchedSeq,
          userId: player.userId,
          boardId: board.id,
          a,
          b,
          path,
          combo: player.combo,
          score: player.score,
          remaining: board.remaining,
          movesLeft: board.movesLeft,
          byItem: 'wand',
        },
        board,
      },
    ];
    if (effects.unlocked) deltas.push({ event: 'game:unlocked', payload: { ...effects.unlocked }, board });
    deltas.push(...collectStuckResolution(game, board));
    flushDeltas(game, deltas);
    emitState(game);
    if (board.remaining === 0) finishBoard(game, player);
    return { ok: true };
  },

  hint(slug: string, actor: GameActor): HintAck {
    const game = games.get(slug);
    if (!game) return { ok: false, reason: 'none' };
    const player = game.players.get(actor.userId);
    if (!player) return { ok: false, reason: 'none' };
    if (!isPlayable(game, player, Date.now())) return { ok: false, reason: 'none' };
    const board = boardOf(game, player);
    if (!board) return { ok: false, reason: 'none' };

    const pair = findAnyMove(ruleView(board));
    if (!pair) return { ok: false, reason: 'none' };
    if (!consumeItem(game, player, 'hint')) return { ok: false, reason: 'none' };
    player.hintBreak = true;
    emitState(game);
    return { ok: true, pair };
  },

  // --- 테트리스 (docs/games/tetris-design.md T3) ---

  /** 내 판 스냅샷. ack 없음 — 레이트 리밋에 걸리면 조용히 버린다. */
  tetrisFrame(slug: string, actor: GameActor, frame: Omit<TetrisFrame, 'userId'>): void {
    const rt = activeTetris(slug, actor.userId);
    if (!rt) return;
    tetris.onFrame(rt, actor.userId, frame);
  },

  /** 줄을 지웠다 → 공격량 계산·상쇄·대상 전달 */
  tetrisClear(slug: string, actor: GameActor, msg: TetrisClearMsg): TetrisAck {
    const rt = activeTetris(slug, actor.userId);
    if (!rt) return { ok: false, reason: 'phase' };
    tetris.onClear(rt, actor.userId, msg);
    return { ok: true };
  },

  /** 내가 죽었다 → 등수 부여 + 종료 검사 */
  tetrisTopout(slug: string, actor: GameActor): TetrisAck {
    const rt = activeTetris(slug, actor.userId);
    if (!rt) return { ok: false, reason: 'phase' };
    tetris.onTopout(rt, actor.userId);
    return { ok: true };
  },

  /** 레이스 목표 달성 */
  tetrisFinish(slug: string, actor: GameActor, timeMs: number, lines: number): TetrisAck {
    const rt = activeTetris(slug, actor.userId);
    if (!rt) return { ok: false, reason: 'phase' };
    tetris.onFinish(rt, actor.userId, timeMs, lines);
    return { ok: true };
  },

  /**
   * 결과 화면의 `로비로` (§Z3). 즉시 재시작이 아니라 **로비 복귀**이고, 방장이 아니어도 누를 수 있다.
   * 자동 복귀 타이머가 남아 있으면 returnToLobby 안의 clearTimers 가 취소한다.
   */
  rematch(slug: string, actor: GameActor): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    if (game.phase !== 'finished') return { error: '끝난 뒤에만 로비로 갈 수 있어요' };
    return { state: returnToLobby(game, `manual by ${actor.userId}`) };
  },

  close(slug: string, actor: GameActor, isRoomOwner: boolean): { error: string } | { ok: true } {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    if (game.hostUserId !== actor.userId && !isRoomOwner) {
      return { error: '게임 개설자 또는 방장만 닫을 수 있어요' };
    }
    console.log(`[game] ${slug} closed by ${actor.userId}`);
    deleteGame(game, true);
    return { ok: true };
  },

  /** room:join(재접속 포함) 직후. 끊김 상태였던 플레이어를 복구한다. */
  onParticipantJoined(slug: string, userId: string): void {
    const game = games.get(slug);
    if (!game) return;
    const timer = game.forfeitTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      game.forfeitTimers.delete(userId);
    }
    const player = game.players.get(userId);
    if (player && !player.connected) {
      player.connected = true;
      console.log(`[game] ${slug} ${userId} reconnected`);
      emitState(game);
    }
  },

  /** performParticipantLeave에서 호출. stillInRoom = 그 유저의 다른 기기가 아직 방에 있음. */
  onParticipantLeft(slug: string, userId: string, stillInRoom: boolean): void {
    if (stillInRoom) return;
    const game = games.get(slug);
    if (!game) return;

    const wasSpectator = game.spectators.delete(userId);
    const player = game.players.get(userId);

    if (!player) {
      if (wasSpectator) {
        transferHostIfNeeded(game, userId);
        if (game.players.size === 0 && game.spectators.size === 0) deleteGame(game, true);
        else emitState(game);
      }
      return;
    }

    if (game.phase === 'countdown' || game.phase === 'playing') {
      player.connected = false;
      transferHostIfNeeded(game, userId);
      const timer = setTimeout(() => {
        game.forfeitTimers.delete(userId);
        const p = game.players.get(userId);
        if (!p || p.connected) return;
        p.forfeited = true;
        p.combo = 0;
        console.log(`[game] ${slug} ${userId} forfeited (disconnected ${DISCONNECT_FORFEIT_MS}ms)`);
        tetrisForfeit(game, userId);
        emitState(game);
        maybeEndByExhaustion(game);
      }, DISCONNECT_FORFEIT_MS);
      const prev = game.forfeitTimers.get(userId);
      if (prev) clearTimeout(prev);
      game.forfeitTimers.set(userId, timer);
      emitState(game);
      return;
    }

    // lobby / finished: 바로 제거
    game.players.delete(userId);
    if (game.mode === 'race') game.boards.delete(player.boardId);
    clearReady(game); // 구성이 바뀌었으니 전원 다시 준비 (§Z3)
    transferHostIfNeeded(game, userId);
    if (game.players.size === 0) {
      console.log(`[game] ${slug} deleted (no players left)`);
      deleteGame(game, true);
      return;
    }
    emitState(game);
  },

  /** 방 자체가 사라질 때. 전적판까지 같이 버린다. */
  destroy(slug: string): void {
    const game = games.get(slug);
    if (game) {
      deleteGame(game, false);
      console.log(`[game] ${slug} destroyed with room`);
    }
    scoreboards.delete(slug);
  },
};
