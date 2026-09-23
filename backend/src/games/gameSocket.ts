// 방 안 미니게임 소켓 바인딩 (docs/games/shisen-design.md §3).
// 여기서는 파싱(zod)·권한 위임·ack·브로드캐스트만 한다. 규칙과 상태는 전부 gameManager.

import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { JwtPayload } from '../middleware/auth';
import { Room } from '../models';
import { gameManager, GameActor, StateResult } from './gameManager';
import { TETRIS_LIMITS } from './tetris/types';

export interface GameHandlerContext {
  /** 현재 소켓이 들어가 있는 방 슬러그(없으면 null) */
  getRoomSlug: () => string | null;
  user: JwtPayload;
}

const specialsSchema = z
  .object({
    mystery: z.boolean(),
    numbers: z.boolean(),
    keys: z.boolean(),
    walls: z.boolean(),
  })
  .partial();

// 아이템 횟수는 범위를 벗어나면 잘라서 받는다(클램프) — 프론트 스테퍼가 넘겨도 에러 대신 보정.
const clampTool = (max: number) =>
  z.number().int().transform((v) => Math.max(0, Math.min(max, v)));
const toolsSchema = z
  .object({ hint: clampTool(9), shuffle: clampTool(9), wand: clampTool(3) })
  .partial();

const optionsSchema = z
  .object({
    boardSize: z.enum(['s', 'm', 'l']),
    mapShape: z.enum(['random', 'rect', 'diamond', 'frame', 'towers', 'pyramid', 'cross', 'blob']),
    specials: specialsSchema,
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    tools: toolsSchema,
    items: z.boolean(),
    timeLimitSec: z.number().int().min(0).max(3600),
  })
  .partial();

// 테트리스 설정 (docs/games/tetris-design.md T2). 범위를 벗어나면 에러 대신 잘라서 받는다 —
// 목록형(줄 수·배수 등)은 gameManager.mergeTetris 가 허용값으로 스냅한다.
const clampNum = (min: number, max: number) =>
  z.number().transform((v) => Math.max(min, Math.min(max, v)));
const tetrisSchema = z
  .object({
    mode: z.enum(['versus', 'sprint', 'survival']),
    sprintLines: clampNum(TETRIS_LIMITS.sprintLines[0], TETRIS_LIMITS.sprintLines[TETRIS_LIMITS.sprintLines.length - 1]),
    startLevel: clampNum(TETRIS_LIMITS.startLevel.min, TETRIS_LIMITS.startLevel.max),
    levelUpLines: clampNum(0, TETRIS_LIMITS.levelUpLines[TETRIS_LIMITS.levelUpLines.length - 1]),
    hold: z.boolean(),
    ghost: z.boolean(),
    nextCount: clampNum(TETRIS_LIMITS.nextCount.min, TETRIS_LIMITS.nextCount.max),
    garbageMul: clampNum(0, TETRIS_LIMITS.garbageMul[TETRIS_LIMITS.garbageMul.length - 1]),
    riseSec: clampNum(0, TETRIS_LIMITS.riseSec[TETRIS_LIMITS.riseSec.length - 1]),
    timeLimitSec: z.number().int().min(0).max(3600),
  })
  .partial();

// v2: gameId·mode·options 전부 optional(기본 shisen/race/DEFAULT_OPTIONS.race).
const createSchema = z.object({
  gameId: z.enum(['shisen', 'tetris']).optional(),
  mode: z.enum(['race', 'coop']).optional(),
  options: optionsSchema.optional(),
  tetris: tetrisSchema.optional(),
});

const updateOptionsSchema = z.object({
  gameId: z.enum(['shisen', 'tetris']).optional(),
  mode: z.enum(['race', 'coop']).optional(),
  options: optionsSchema.optional(),
  tetris: tetrisSchema.optional(),
});

// --- 테트리스 실시간 (T3) ---
// cells 는 보이는 20행(200칸)만. 값 = 0 | 1..8 | 9(그림자) | 10+pieceId(현재 조각)
const tetrisFrameSchema = z.object({
  cells: z.array(z.number().int().min(0).max(20)).length(200),
  lines: z.number().int().min(0).max(100000),
  score: z.number().int().min(0).max(1_000_000_000),
  level: z.number().int().min(1).max(99),
  combo: z.number().int().min(0).max(9999),
  b2b: z.number().int().min(0).max(9999),
  hold: z.number().int().min(0).max(7),
  next: z.array(z.number().int().min(1).max(7)).max(8),
  pending: z.number().int().min(0).max(999),
  alive: z.boolean(),
  ko: z.number().int().min(0).max(99),
  t: z.number(),
});

const tetrisClearSchema = z.object({
  kind: z.enum(['single', 'double', 'triple', 'tetris', 'tsm', 'tss', 'tsd', 'tst']),
  lines: z.number().int().min(1).max(4),
  combo: z.number().int().min(0).max(9999),
  b2b: z.boolean(),
  perfect: z.boolean(),
});

const tetrisFinishSchema = z.object({
  timeMs: z.number().int().min(0).max(24 * 3600 * 1000),
  lines: z.number().int().min(0).max(100000),
});

// 로비 준비 토글 (docs/games/tetris-design.md §Z3)
const readySchema = z.object({ ready: z.boolean() });

const peekSchema = z.object({ idx: z.number().int().min(0).max(4095) });

const pickSchema = z.object({
  a: z.number().int().min(0).max(4095),
  b: z.number().int().min(0).max(4095),
});

const selectSchema = z.object({
  idx: z.number().int().min(0).max(4095).nullable(),
});

const NOT_IN_ROOM = '방에 먼저 입장하세요';
const BAD_PAYLOAD = '잘못된 요청입니다';

type Ack = ((res: unknown) => void) | undefined;

/** io는 브로드캐스트용. 소켓 연결마다 다시 호출돼도 같은 함수라 덮어써도 무해하다. */
export function initGameBroadcast(io: Server): void {
  gameManager.setBroadcast((roomSlug, event, payload) => {
    io.to(roomSlug).emit(event, payload);
  });
}

/**
 * room:join 성공 직후 호출. 소켓당 1회만 바인딩하고, 재접속(같은 소켓의 재입장)에서는
 * 끊겼던 플레이어 복구만 한다.
 */
export function registerGameHandlers(io: Server, socket: Socket, ctx: GameHandlerContext): void {
  const user = ctx.user;
  const actor: GameActor = { userId: user.userId, nickname: user.nickname };

  const slugNow = ctx.getRoomSlug();
  if (slugNow) gameManager.onParticipantJoined(slugNow, user.userId);

  if (socket.data.gameHandlersBound) return;
  socket.data.gameHandlersBound = true;
  initGameBroadcast(io);

  /** 방 컨텍스트가 필요한 핸들러 공통 래퍼 */
  const withRoom = (fn: (slug: string) => void, callback: Ack, onNoRoom: unknown = { error: NOT_IN_ROOM }) => {
    const slug = ctx.getRoomSlug();
    if (!slug) {
      callback?.(onNoRoom);
      return;
    }
    try {
      fn(slug);
    } catch (err: any) {
      console.error(`[game] handler error in room ${slug}:`, err?.message || err);
      callback?.({ error: err?.message || 'game error' });
    }
  };

  const ackState = (callback: Ack) => (res: StateResult) => callback?.(res);

  socket.on('game:sync', (_payload: unknown, callback: Ack) => {
    const slug = ctx.getRoomSlug();
    if (!slug) return callback?.({ error: NOT_IN_ROOM });
    callback?.({ state: gameManager.getSnapshot(slug) });
  });

  socket.on('game:create', (payload: unknown, callback: Ack) => {
    withRoom((slug) => {
      const parsed = createSchema.safeParse(payload ?? {});
      if (!parsed.success) return callback?.({ error: BAD_PAYLOAD });
      ackState(callback)(gameManager.create(slug, actor, parsed.data));
    }, callback);
  });

  socket.on('game:join', (_payload: unknown, callback: Ack) => {
    withRoom((slug) => ackState(callback)(gameManager.join(slug, actor)), callback);
  });

  socket.on('game:spectate', (_payload: unknown, callback: Ack) => {
    withRoom((slug) => ackState(callback)(gameManager.spectate(slug, actor)), callback);
  });

  socket.on('game:updateOptions', (payload: unknown, callback: Ack) => {
    withRoom((slug) => {
      const parsed = updateOptionsSchema.safeParse(payload ?? {});
      if (!parsed.success) return callback?.({ error: BAD_PAYLOAD });
      ackState(callback)(gameManager.updateOptions(slug, actor, parsed.data));
    }, callback);
  });

  // 준비 토글 (§Z3). ack 가 없어도 반드시 실행되도록 "먼저 실행 → 그다음 ack" 순서를 지킨다
  // (`callback?.(gameManager.setReady(...))` 로 쓰면 ack 없이 emit 했을 때 단락 평가로 아예 실행되지 않는다).
  socket.on('game:ready', (payload: unknown, callback: Ack) => {
    withRoom((slug) => {
      const parsed = readySchema.safeParse(payload ?? {});
      if (!parsed.success) return callback?.({ error: BAD_PAYLOAD });
      const res = gameManager.setReady(slug, actor, parsed.data.ready);
      callback?.('error' in res ? res : { ok: true });
    }, callback);
  });

  socket.on('game:start', (_payload: unknown, callback: Ack) => {
    withRoom((slug) => ackState(callback)(gameManager.start(slug, actor)), callback);
  });

  socket.on('game:pick', (payload: unknown, callback: Ack) => {
    withRoom(
      (slug) => {
        const parsed = pickSchema.safeParse(payload);
        if (!parsed.success) return callback?.({ ok: false, reason: 'gone' });
        const res = gameManager.pick(slug, actor, parsed.data.a, parsed.data.b);
        callback?.(res);
      },
      callback,
      { ok: false, reason: 'phase' }
    );
  });

  // ack 없음. 상대에게 내 첫 선택만 알린다(검증 없음, 발신자 제외).
  socket.on('game:select', (payload: unknown) => {
    const slug = ctx.getRoomSlug();
    if (!slug) return;
    const parsed = selectSchema.safeParse(payload);
    if (!parsed.success) return;
    socket.to(slug).emit('game:peerSelect', { userId: user.userId, idx: parsed.data.idx });
  });

  // 물음표 일회성 엿보기 — 요청자에게만, 서버 상태 불변 (v3 §W1)
  socket.on('game:peek', (payload: unknown, callback: Ack) => {
    withRoom(
      (slug) => {
        const parsed = peekSchema.safeParse(payload);
        if (!parsed.success) return callback?.({ ok: false, reason: 'gone' });
        const res = gameManager.peek(slug, actor, parsed.data.idx);
        callback?.(res);
      },
      callback,
      { ok: false, reason: 'phase' }
    );
  });

  // F2 재배치 / F3 여의봉
  socket.on('game:shuffle', (_payload: unknown, callback: Ack) => {
    withRoom((slug) => { const res = gameManager.useShuffle(slug, actor); callback?.(res); }, callback, {
      ok: false,
      reason: 'phase',
    });
  });

  socket.on('game:wand', (_payload: unknown, callback: Ack) => {
    withRoom((slug) => { const res = gameManager.useWand(slug, actor); callback?.(res); }, callback, {
      ok: false,
      reason: 'phase',
    });
  });

  socket.on('game:hint', (_payload: unknown, callback: Ack) => {
    withRoom(
      (slug) => { const res = gameManager.hint(slug, actor); callback?.(res); },
      callback,
      { ok: false, reason: 'none' }
    );
  });

  // --- 테트리스 (T3). 게임이 테트리스가 아니면 gameManager 가 조용히 무시한다. ---

  // ack 없음. 8Hz 릴레이는 서버 타이머가 한다.
  socket.on('tetris:frame', (payload: unknown) => {
    const slug = ctx.getRoomSlug();
    if (!slug) return;
    const parsed = tetrisFrameSchema.safeParse(payload);
    if (!parsed.success) return;
    gameManager.tetrisFrame(slug, actor, parsed.data);
  });

  socket.on('tetris:clear', (payload: unknown, callback: Ack) => {
    withRoom(
      (slug) => {
        const parsed = tetrisClearSchema.safeParse(payload);
        if (!parsed.success) return callback?.({ ok: false, reason: 'bad payload' });
        const res = gameManager.tetrisClear(slug, actor, parsed.data);
        callback?.(res);
      },
      callback,
      { ok: false, reason: 'phase' }
    );
  });

  socket.on('tetris:topout', (_payload: unknown, callback: Ack) => {
    withRoom((slug) => { const res = gameManager.tetrisTopout(slug, actor); callback?.(res); }, callback, {
      ok: false,
      reason: 'phase',
    });
  });

  socket.on('tetris:finish', (payload: unknown, callback: Ack) => {
    withRoom(
      (slug) => {
        const parsed = tetrisFinishSchema.safeParse(payload);
        if (!parsed.success) return callback?.({ ok: false, reason: 'bad payload' });
        const res = gameManager.tetrisFinish(slug, actor, parsed.data.timeMs, parsed.data.lines);
        callback?.(res);
      },
      callback,
      { ok: false, reason: 'phase' }
    );
  });

  socket.on('game:rematch', (_payload: unknown, callback: Ack) => {
    withRoom((slug) => ackState(callback)(gameManager.rematch(slug, actor)), callback);
  });

  socket.on('game:close', async (_payload: unknown, callback: Ack) => {
    const slug = ctx.getRoomSlug();
    if (!slug) return callback?.({ error: NOT_IN_ROOM });
    try {
      // 게임 개설자가 아니어도 방장이면 닫을 수 있다.
      const room = await Room.findOne({ where: { slug, owner_id: user.userId }, attributes: ['id'] });
      const res = gameManager.close(slug, actor, !!room);
      callback?.(res);
    } catch (err: any) {
      console.error(`[game] close error in room ${slug}:`, err?.message || err);
      callback?.({ error: err?.message || 'game error' });
    }
  });
}
