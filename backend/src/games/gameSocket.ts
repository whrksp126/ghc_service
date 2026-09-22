// 방 안 미니게임 소켓 바인딩 (docs/games/shisen-design.md §3).
// 여기서는 파싱(zod)·권한 위임·ack·브로드캐스트만 한다. 규칙과 상태는 전부 gameManager.

import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { JwtPayload } from '../middleware/auth';
import { Room } from '../models';
import { gameManager, GameActor, StateResult } from './gameManager';

export interface GameHandlerContext {
  /** 현재 소켓이 들어가 있는 방 슬러그(없으면 null) */
  getRoomSlug: () => string | null;
  user: JwtPayload;
}

const optionsSchema = z
  .object({
    boardSize: z.enum(['s', 'm', 'l']),
    items: z.boolean(),
    timeLimitSec: z.number().int().min(0).max(3600),
  })
  .partial();

const createSchema = z.object({
  gameId: z.literal('shisen'),
  mode: z.enum(['race', 'coop']),
  options: optionsSchema.optional(),
});

const updateOptionsSchema = z.object({
  mode: z.enum(['race', 'coop']).optional(),
  options: optionsSchema.optional(),
});

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
      const parsed = createSchema.safeParse(payload);
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

  socket.on('game:start', (_payload: unknown, callback: Ack) => {
    withRoom((slug) => ackState(callback)(gameManager.start(slug, actor)), callback);
  });

  socket.on('game:pick', (payload: unknown, callback: Ack) => {
    withRoom(
      (slug) => {
        const parsed = pickSchema.safeParse(payload);
        if (!parsed.success) return callback?.({ ok: false, reason: 'gone' });
        callback?.(gameManager.pick(slug, actor, parsed.data.a, parsed.data.b));
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

  socket.on('game:hint', (_payload: unknown, callback: Ack) => {
    withRoom(
      (slug) => callback?.(gameManager.hint(slug, actor)),
      callback,
      { ok: false, reason: 'none' }
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
      callback?.(gameManager.close(slug, actor, !!room));
    } catch (err: any) {
      console.error(`[game] close error in room ${slug}:`, err?.message || err);
      callback?.({ error: err?.message || 'game error' });
    }
  });
}
