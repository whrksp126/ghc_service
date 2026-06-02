import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Room, RoomMember } from '../models';
import { authMiddleware } from '../middleware/auth';
import { forceCloseRoom } from '../signaling/socketHandler';

const JWT_SECRET = process.env.JWT_SECRET || 'longdcam_dev_secret';

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

router.post('/rooms/:slug/join', authMiddleware, async (req, res) => {
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

export default router;
