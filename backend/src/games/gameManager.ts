// 방 안 미니게임 상태 머신 (docs/games/shisen-design.md §3, §1.6, §1.7).
// io 의존 없음 — 브로드캐스트는 setBroadcast()로 주입된 콜백으로만 나간다.
// 플레이어 식별은 userId. 같은 유저가 여러 기기로 들어와도 플레이어는 1명.

import {
  AttackEvent,
  AttackType,
  BOARD_DIMS,
  Board,
  COMBO_WINDOW_MS,
  COUNTDOWN_MS,
  DEFAULT_OPTIONS,
  Effect,
  GameId,
  GameMode,
  GameOptions,
  GamePhase,
  GameSnapshot,
  HintAck,
  MAX_PLAYERS,
  PLAYER_COLORS,
  PickAck,
  PlayerState,
  ResultRow,
  ScoreboardRow,
} from './types';
import {
  countRemaining,
  findAnyPair,
  findPath,
  generateBoard,
  mulberry32,
  shuffleRemaining,
} from './shisen/engine';

export type Broadcast = (roomSlug: string, event: string, payload: unknown) => void;

export interface GameActor {
  userId: string;
  nickname: string;
}

export type StateResult = { error: string } | { state: GameSnapshot };

const RACE_HINTS = 3;
const COOP_HINTS = 5;
const DISCONNECT_FORFEIT_MS = 30000;
const ATTACK_COMBO_STEPS = [3, 6, 9];
const ATTACK_TYPES: AttackType[] = ['freeze', 'fog', 'shuffle'];
const FREEZE_MS = 3000;
const FOG_MS = 4000;
const FOG_RATIO = 0.4;
const SHUFFLE_FX_MS = 250;
const MAX_COMBO = 10;
const SHARED_BOARD_ID = 'shared';

interface InternalPlayer extends PlayerState {
  /** playing 중 기권(게임에는 남아 결과 최하위 그룹으로 집계) */
  forfeited: boolean;
  /** 힌트를 쓴 직후 한 번은 콤보를 끊는다 (§1.5) */
  hintBreak: boolean;
}

interface RoomGame {
  slug: string;
  gameId: GameId;
  phase: GamePhase;
  hostUserId: string;
  mode: GameMode;
  options: GameOptions;
  seed: number;
  startAt: number | null;
  endedAt: number | null;
  players: Map<string, InternalPlayer>; // 삽입 순서 = 참가 순서
  boards: Map<string, Board>;
  spectators: Map<string, { userId: string; nickname: string }>;
  results: ResultRow[] | null;
  seq: number;
  rng: () => number;
  sharedHintsLeft: number;
  countdownTimer: ReturnType<typeof setTimeout> | null;
  limitTimer: ReturnType<typeof setTimeout> | null;
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
    lastMatchAt: 0,
    hintsLeft: game.mode === 'coop' ? COOP_HINTS : RACE_HINTS,
    finishedAt: null,
    connected: true,
    forfeited: false,
    hintBreak: false,
  };
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
    lastMatchAt: p.lastMatchAt,
    hintsLeft: p.hintsLeft,
    finishedAt: p.finishedAt,
    connected: p.connected,
    forfeited: p.forfeited,
  };
}

function snapshot(game: RoomGame): GameSnapshot {
  purgeEffects(game, Date.now());
  const boards: Record<string, Board> = {};
  for (const [id, b] of game.boards) {
    boards[id] = {
      id: b.id,
      cols: b.cols,
      rows: b.rows,
      cells: b.cells.slice(),
      remaining: b.remaining,
      effects: b.effects.map((e) => ({ ...e })),
    };
  }
  return {
    gameId: game.gameId,
    phase: game.phase,
    hostUserId: game.hostUserId,
    mode: game.mode,
    options: { ...game.options },
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
  if (game.countdownTimer) clearTimeout(game.countdownTimer);
  if (game.limitTimer) clearTimeout(game.limitTimer);
  game.countdownTimer = null;
  game.limitTimer = null;
  for (const t of game.forfeitTimers.values()) clearTimeout(t);
  game.forfeitTimers.clear();
  for (const t of game.effectTimers) clearTimeout(t);
  game.effectTimers.clear();
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

function boardOf(game: RoomGame, p: InternalPlayer): Board | undefined {
  return game.boards.get(p.boardId);
}

interface ShuffledPayload {
  seq: number;
  boardId: string;
  cells: number[];
  cause: 'stuck' | 'attack';
}

/** 판을 섞고 seq를 올린 페이로드만 만든다(브로드캐스트는 호출자가 순서를 맞춰서). */
function shuffleBoard(game: RoomGame, board: Board, cause: 'stuck' | 'attack'): ShuffledPayload {
  board.cells = shuffleRemaining(board.cells, board.cols, board.rows, game.rng);
  if (!findAnyPair(board.cells, board.cols, board.rows)) {
    console.warn(`[game] board ${board.id} has no move even after shuffle (remaining=${board.remaining})`);
  }
  game.seq++;
  return { seq: game.seq, boardId: board.id, cells: board.cells.slice(), cause };
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
    for (let i = 0; i < board.cells.length; i++) if (board.cells[i] !== 0) tiles.push(i);
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
    if (game.mode === 'race') {
      if (row.rank === 1) prev.wins += 1;
      if (row.timeMs !== null && (prev.bestTimeMs === null || row.timeMs < prev.bestTimeMs)) {
        prev.bestTimeMs = row.timeMs;
      }
    }
    table.set(row.userId, prev);
  }
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
}

function maybeEndByExhaustion(game: RoomGame): void {
  if (game.phase !== 'playing') return;
  const players = [...game.players.values()];
  if (players.length === 0) return;
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
    input: { gameId: GameId; mode: GameMode; options?: Partial<GameOptions> }
  ): StateResult {
    if (games.has(slug)) return { error: '이미 게임이 열려 있어요' };
    const mode = input.mode;
    const options: GameOptions = { ...DEFAULT_OPTIONS[mode], ...(input.options ?? {}) };
    if (mode === 'coop') options.items = false; // 협동에는 아이템 없음 (§1.7)

    const game: RoomGame = {
      slug,
      gameId: input.gameId,
      phase: 'lobby',
      hostUserId: actor.userId,
      mode,
      options,
      seed: newSeed(),
      startAt: null,
      endedAt: null,
      players: new Map(),
      boards: new Map(),
      spectators: new Map(),
      results: null,
      seq: 0,
      rng: mulberry32(newSeed()),
      sharedHintsLeft: COOP_HINTS,
      countdownTimer: null,
      limitTimer: null,
      forfeitTimers: new Map(),
      effectTimers: new Set(),
    };
    game.players.set(actor.userId, makePlayer(game, actor));
    games.set(slug, game);
    console.log(`[game] ${slug} created by ${actor.userId} (${mode})`);
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
      }
      maybeEndByExhaustion(game); // 혼자 하던 판이면 기권으로 바로 끝난다
      if ((game.phase as GamePhase) !== 'finished') emitState(game);
      return { state: snapshot(game) };
    }

    if (player) {
      // 로비/종료 상태에서의 관전 전환. host는 관전자가 되어도 그대로 host다(이양은 이탈 때만).
      game.players.delete(actor.userId);
      if (game.mode === 'race') game.boards.delete(player.boardId);
    }
    game.spectators.set(actor.userId, { userId: actor.userId, nickname: actor.nickname });
    return { state: emitState(game) };
  },

  updateOptions(
    slug: string,
    actor: GameActor,
    input: { mode?: GameMode; options?: Partial<GameOptions> }
  ): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    if (game.hostUserId !== actor.userId) return { error: '게임 개설자만 바꿀 수 있어요' };
    if (game.phase !== 'lobby') return { error: '로비에서만 바꿀 수 있어요' };

    if (input.mode && input.mode !== game.mode) {
      game.mode = input.mode;
      game.options = { ...DEFAULT_OPTIONS[input.mode] };
      for (const p of game.players.values()) p.boardId = boardIdFor(game.mode, p.userId);
    }
    if (input.options) game.options = { ...game.options, ...input.options };
    if (game.mode === 'coop') game.options.items = false;
    return { state: emitState(game) };
  },

  start(slug: string, actor: GameActor): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    if (game.hostUserId !== actor.userId) return { error: '게임 개설자만 시작할 수 있어요' };
    if (game.phase !== 'lobby') return { error: '로비에서만 시작할 수 있어요' };
    const players = [...game.players.values()];
    if (players.length === 0) return { error: '플레이어가 최소 1명 필요해요' };

    const { cols, rows } = BOARD_DIMS[game.options.boardSize];
    game.seed = newSeed();
    game.rng = mulberry32(game.seed);
    game.boards.clear();

    const t0 = Date.now();
    if (game.mode === 'coop') {
      const cells = generateBoard(cols, rows, game.rng);
      game.boards.set(SHARED_BOARD_ID, {
        id: SHARED_BOARD_ID,
        cols,
        rows,
        cells,
        remaining: countRemaining(cells),
        effects: [],
      });
    } else {
      const cells = generateBoard(cols, rows, game.rng); // 레이스는 전원 동일한 판
      for (const p of players) {
        game.boards.set(p.userId, {
          id: p.userId,
          cols,
          rows,
          cells: cells.slice(),
          remaining: countRemaining(cells),
          effects: [],
        });
      }
    }
    console.log(`[game] ${slug} board ${cols}x${rows} generated in ${Date.now() - t0}ms (seed ${game.seed})`);

    game.sharedHintsLeft = COOP_HINTS;
    for (const p of players) {
      p.boardId = boardIdFor(game.mode, p.userId);
      p.score = 0;
      p.combo = 0;
      p.maxCombo = 0;
      p.pairsCleared = 0;
      p.lastMatchAt = 0;
      p.hintsLeft = game.mode === 'coop' ? COOP_HINTS : RACE_HINTS;
      p.finishedAt = null;
      p.forfeited = false;
      p.hintBreak = false;
    }

    game.phase = 'countdown';
    game.startAt = Date.now() + COUNTDOWN_MS;
    game.endedAt = null;
    game.results = null;
    const state = emitState(game);

    game.countdownTimer = setTimeout(() => {
      game.countdownTimer = null;
      if (game.phase !== 'countdown') return;
      game.phase = 'playing';
      emitState(game);
      if (game.options.timeLimitSec > 0) {
        game.limitTimer = setTimeout(() => {
          game.limitTimer = null;
          endGame(game, 'time limit');
        }, game.options.timeLimitSec * 1000);
      }
    }, COUNTDOWN_MS);

    return { state };
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
    if (a === b) return { ok: false, reason: 'same' };
    if (a < 0 || b < 0 || a >= board.cells.length || b >= board.cells.length) {
      return { ok: false, reason: 'gone' };
    }
    if (board.cells[a] === 0 || board.cells[b] === 0) return { ok: false, reason: 'gone' };
    if (board.cells[a] !== board.cells[b]) return { ok: false, reason: 'symbol' };

    const path = findPath(board.cells, board.cols, board.rows, a, b);
    if (!path) return { ok: false, reason: 'nopath' };

    // --- 제거 확정 ---
    board.cells[a] = 0;
    board.cells[b] = 0;
    board.remaining -= 2;

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

    // seq는 실제 방출 순서대로 올라가야 한다(클라가 seq로 늦은 델타를 버리므로).
    const matchedSeq = ++game.seq;
    let attack: FiredAttack | null = null;
    if (game.mode === 'race' && game.options.items && ATTACK_COMBO_STEPS.includes(player.combo)) {
      attack = fireAttack(game, player, now);
    }

    broadcast(game.slug, 'game:matched', {
      seq: matchedSeq,
      userId: player.userId,
      boardId: board.id,
      a,
      b,
      path,
      combo: player.combo,
      score: player.score,
      remaining: board.remaining,
      ...(attack ? { attack: attack.event } : {}),
    });
    if (attack) {
      broadcast(game.slug, 'game:attack', attack.event);
      if (attack.shuffled) broadcast(game.slug, 'game:shuffled', attack.shuffled);
    }

    // 막힘 검사 (§1.4)
    if (board.remaining > 0 && !findAnyPair(board.cells, board.cols, board.rows)) {
      broadcast(game.slug, 'game:shuffled', shuffleBoard(game, board, 'stuck'));
    }

    if (board.remaining === 0) {
      if (game.mode === 'race') {
        player.finishedAt = Date.now();
        endGame(game, `${player.userId} cleared`); // 레이스는 1등이 나오면 즉시 종료
      } else {
        endGame(game, 'coop cleared');
      }
    }

    return { ok: true, path };
  },

  hint(slug: string, actor: GameActor): HintAck {
    const game = games.get(slug);
    if (!game) return { ok: false, reason: 'none' };
    const player = game.players.get(actor.userId);
    if (!player) return { ok: false, reason: 'none' };
    if (!isPlayable(game, player, Date.now())) return { ok: false, reason: 'none' };
    const board = boardOf(game, player);
    if (!board) return { ok: false, reason: 'none' };

    const available = game.mode === 'coop' ? game.sharedHintsLeft : player.hintsLeft;
    if (available <= 0) return { ok: false, reason: 'none' };

    const pair = findAnyPair(board.cells, board.cols, board.rows);
    if (!pair) return { ok: false, reason: 'none' };

    if (game.mode === 'coop') {
      game.sharedHintsLeft -= 1;
      for (const p of game.players.values()) p.hintsLeft = game.sharedHintsLeft; // 협동은 힌트 공유
    } else {
      player.hintsLeft -= 1;
    }
    player.hintBreak = true;
    emitState(game);
    return { ok: true, pair };
  },

  rematch(slug: string, actor: GameActor): StateResult {
    const game = games.get(slug);
    if (!game) return { error: '게임이 없어요' };
    if (game.hostUserId !== actor.userId) return { error: '게임 개설자만 다시 시작할 수 있어요' };
    if (game.phase !== 'finished') return { error: '끝난 뒤에만 다시 할 수 있어요' };

    clearTimers(game);
    // 기권했던 사람은 관전자로 내린다(다시 참가하려면 game:join).
    for (const p of [...game.players.values()]) {
      if (p.forfeited) {
        game.players.delete(p.userId);
        game.spectators.set(p.userId, { userId: p.userId, nickname: p.nickname });
      }
    }
    game.phase = 'lobby';
    game.startAt = null;
    game.endedAt = null;
    game.results = null;
    game.boards.clear();
    game.sharedHintsLeft = COOP_HINTS;
    for (const p of game.players.values()) {
      p.score = 0;
      p.combo = 0;
      p.maxCombo = 0;
      p.pairsCleared = 0;
      p.lastMatchAt = 0;
      p.hintsLeft = game.mode === 'coop' ? COOP_HINTS : RACE_HINTS;
      p.finishedAt = null;
      p.forfeited = false;
      p.hintBreak = false;
    }
    return { state: emitState(game) };
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
