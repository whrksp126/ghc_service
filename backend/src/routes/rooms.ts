import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Room, RoomMember } from '../models';
import { authMiddleware } from '../middleware/auth';
import { requireSecret } from '../lib/requireSecret';
import { forceCloseRoom } from '../signaling/socketHandler';
import { createRoomIngress, listRoomIngress, deleteRoomIngress, countActiveLives } from '../services/livekitService';

const JWT_SECRET = requireSecret('JWT_SECRET', 'longdcam_dev_secret');

// PIN 브루트포스 방지: 방+IP 기준 분당 10회
const joinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${req.params.slug}:${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
});

const router = Router();

function generateSlug(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let slug = '';
  for (let i = 0; i < 8; i++) {
    slug += chars[Math.floor(Math.random() * chars.length)];
  }
  return slug;
}

const createRoomSchema = z.object({
  name: z.string().min(1).max(100),
  pin: z.string().min(4).max(6).optional(),
  maxParticipants: z.number().int().min(2).max(20).default(8),
  allowViewers: z.boolean().default(true),
});

router.post('/rooms', authMiddleware, async (req, res) => {
  try {
    const data = createRoomSchema.parse(req.body);
    const userId = req.user!.userId;

    const roomId = uuidv4();
    let slug = generateSlug();

    while (await Room.findOne({ where: { slug } })) {
      slug = generateSlug();
    }

    const hashedPin = data.pin ? await bcrypt.hash(data.pin, 10) : null;

    const room = await Room.create({
      id: roomId,
      name: data.name,
      slug,
      pin: hashedPin,
      owner_id: userId,
      max_participants: data.maxParticipants,
      allow_viewers: data.allowViewers,
    });

    await RoomMember.create({
      room_id: roomId,
      user_id: userId,
      role: 'owner',
      joined_at: new Date(),
    });

    res.status(201).json({
      room: {
        id: room.id,
        name: room.name,
        slug: room.slug,
        hasPin: !!room.pin,
        maxParticipants: room.max_participants,
        allowViewers: room.allow_viewers,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }
    throw err;
  }
});

router.get('/rooms/:slug', async (req, res) => {
  const room = await Room.findOne({
    where: { slug: req.params.slug, is_active: true },
    attributes: ['id', 'name', 'slug', 'pin', 'max_participants', 'allow_viewers'],
  });
  if (!room) return res.status(404).json({ error: 'Room not found' });

  res.json({
    room: {
      id: room.id,
      name: room.name,
      slug: room.slug,
      hasPin: !!room.pin,
      maxParticipants: room.max_participants,
      allowViewers: room.allow_viewers,
    },
  });
});

router.post('/rooms/:slug/invite', authMiddleware, async (req, res) => {
  const room = await Room.findOne({
    where: { slug: req.params.slug, owner_id: req.user!.userId, is_active: true },
  });
  if (!room) return res.status(404).json({ error: 'Room not found or not owner' });

  const inviteToken = jwt.sign(
    { roomId: room.id, roomSlug: room.slug, bypassPin: true },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  res.json({ inviteToken, expiresAt });
});

const joinRoomSchema = z.object({
  pin: z.string().optional(),
  inviteToken: z.string().optional(),
});

router.post('/rooms/:slug/join', authMiddleware, joinLimiter, async (req, res) => {
  try {
    const data = joinRoomSchema.parse(req.body);
    const userId = req.user!.userId;

    const room = await Room.findOne({
      where: { slug: req.params.slug, is_active: true },
    });
    if (!room) return res.status(404).json({ error: 'Room not found' });

    let bypassPin = false;
    if (data.inviteToken) {
      try {
        const payload = jwt.verify(data.inviteToken, JWT_SECRET) as any;
        if (payload.roomSlug === req.params.slug && payload.bypassPin) {
          bypassPin = true;
        }
      } catch {
        // invalid token, continue with normal flow
      }
    }

    let member = await RoomMember.findOne({
      where: { room_id: room.id, user_id: userId },
    });

    // Remember the password: once you've joined (become a member), you never have to
    // re-enter the PIN. Only first-time joiners of a PIN room are challenged.
    if (room.pin && !bypassPin && !member) {
      if (!data.pin) return res.status(403).json({ error: 'PIN required' });
      const valid = await bcrypt.compare(data.pin, room.pin);
      if (!valid) return res.status(403).json({ error: 'Invalid PIN' });
    }

    if (!member) {
      member = await RoomMember.create({
        room_id: room.id,
        user_id: userId,
        role: 'member',
        joined_at: new Date(),
      });
    }

    res.json({
      room: {
        id: room.id,
        name: room.name,
        slug: room.slug,
        maxParticipants: room.max_participants,
        allowViewers: room.allow_viewers,
      },
      role: member.role,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }
    throw err;
  }
});

router.get('/rooms', authMiddleware, async (req, res) => {
  const memberships = await RoomMember.findAll({
    where: { user_id: req.user!.userId },
    include: [{ model: Room, as: 'room', where: { is_active: true } }],
  });

  const rooms = memberships.map((m) => {
    const room = (m as any).room;
    return {
      id: room.id,
      name: room.name,
      slug: room.slug,
      role: m.role,
      hasPin: !!room.pin,
    };
  });

  res.json({ rooms });
});

router.delete('/rooms/:slug', authMiddleware, async (req, res) => {
  const room = await Room.findOne({
    where: { slug: req.params.slug, owner_id: req.user!.userId },
  });
  if (!room) return res.status(404).json({ error: 'Room not found or not owner' });

  await room.update({ is_active: false });
  // Notify anyone currently connected to this room and tear down their media.
  await forceCloseRoom(room.slug);
  res.json({ success: true });
});

// Rename a room (owner only).
const renameRoomSchema = z.object({ name: z.string().min(1).max(100) });
router.patch('/rooms/:slug', authMiddleware, async (req, res) => {
  try {
    const data = renameRoomSchema.parse(req.body);
    const room = await Room.findOne({
      where: { slug: req.params.slug, owner_id: req.user!.userId },
    });
    if (!room) return res.status(404).json({ error: '방을 찾을 수 없거나 방장이 아닙니다' });
    await room.update({ name: data.name });
    res.json({ room: { id: room.id, name: room.name, slug: room.slug } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }
    throw err;
  }
});

// --- OBS live broadcast (RTMP ingress) — owner only -----------------------------------
// Returns the RTMP server URL + stream key for the room owner to paste into OBS. The
// ingress publishes into the room as an "OBS 라이브" participant.
router.post('/rooms/:slug/ingress', authMiddleware, async (req, res) => {
  const room = await Room.findOne({
    where: { slug: req.params.slug, owner_id: req.user!.userId, is_active: true },
  });
  if (!room) return res.status(404).json({ error: '방을 찾을 수 없거나 방장이 아닙니다' });
  try {
    const parsed = z.object({ name: z.string().trim().min(1).max(30).optional() }).safeParse(req.body ?? {});
    const name = parsed.success ? parsed.data.name : undefined;

    // 이 방의 ingress가 이미 존재하면 재사용 — 카운트 초과 여부와 무관하게 허용.
    const existing = await listRoomIngress(room.slug);
    if (existing.length === 0) {
      // 신규 생성 시점에만 동시 라이브 상한 검사.
      const maxLives = Number(process.env.MAX_CONCURRENT_LIVES || 8);
      const activeCount = await countActiveLives();
      if (activeCount >= maxLives) {
        return res.status(503).json({
          error: '동시 라이브 송출 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
        });
      }
    }

    const ingress = await createRoomIngress(room.slug, name || 'OBS 라이브');
    res.json({ ingress });
  } catch (err) {
    console.error('createRoomIngress failed:', err);
    res.status(502).json({ error: 'OBS 라이브 설정에 실패했습니다' });
  }
});

router.get('/rooms/:slug/ingress', authMiddleware, async (req, res) => {
  const room = await Room.findOne({
    where: { slug: req.params.slug, owner_id: req.user!.userId, is_active: true },
  });
  if (!room) return res.status(404).json({ error: '방을 찾을 수 없거나 방장이 아닙니다' });
  const ingresses = await listRoomIngress(room.slug);
  res.json({ ingresses });
});

router.delete('/rooms/:slug/ingress/:id', authMiddleware, async (req, res) => {
  const room = await Room.findOne({
    where: { slug: req.params.slug, owner_id: req.user!.userId, is_active: true },
  });
  if (!room) return res.status(404).json({ error: '방을 찾을 수 없거나 방장이 아닙니다' });
  await deleteRoomIngress(String(req.params.id));
  res.json({ success: true });
});

// Leave a room — removes the caller's membership ("내 목록에서 삭제"). Owners delete instead.
router.post('/rooms/:slug/leave', authMiddleware, async (req, res) => {
  const userId = req.user!.userId;
  const room = await Room.findOne({ where: { slug: req.params.slug } });
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.owner_id === userId) {
    return res.status(400).json({ error: '방장은 나갈 수 없습니다. 방을 삭제해주세요.' });
  }
  await RoomMember.destroy({ where: { room_id: room.id, user_id: userId } });
  res.json({ success: true });
});

export default router;
