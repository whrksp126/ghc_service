import { Router } from 'express';
import { z } from 'zod';
import { Device } from '../models';
import { authMiddleware } from '../middleware/auth';

const router = Router();

const cameraNameDefaults: Record<string, string> = {
  phone: '내 휴대폰',
  tablet: '내 태블릿',
  desktop: '내 데스크톱',
  other: '내 기기',
};

const createDeviceSchema = z.object({
  label: z.string().min(1).max(100),
  deviceFingerprint: z.string().min(1).max(255),
  deviceType: z.enum(['phone', 'tablet', 'desktop', 'other']).default('other'),
  cameraName: z.string().min(1).max(100).optional(),
});

router.post('/devices', authMiddleware, async (req, res) => {
  try {
    const data = createDeviceSchema.parse(req.body);
    const userId = req.user!.userId;

    const existing = await Device.findOne({
      where: { user_id: userId, device_fingerprint: data.deviceFingerprint },
    });

    if (existing) {
      await existing.update({ label: data.label, device_type: data.deviceType, last_seen_at: new Date() });
      return res.json({ device: existing });
    }

    const sameTypeCount = await Device.count({
      where: { user_id: userId, device_type: data.deviceType, is_active: true },
    });

    const baseName = cameraNameDefaults[data.deviceType] || '내 기기';
    const autoName = sameTypeCount > 0 ? `${baseName} ${sameTypeCount + 1}` : baseName;

    const device = await Device.create({
      user_id: userId,
      label: data.label,
      camera_name: data.cameraName || autoName,
      device_fingerprint: data.deviceFingerprint,
      device_type: data.deviceType,
      last_seen_at: new Date(),
    });

    res.status(201).json({ device });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }
    throw err;
  }
});

router.get('/devices', authMiddleware, async (req, res) => {
  // Only currently-connected devices: a device row persists across sessions, but the
  // list should reflect what is logged in right now (is_online is toggled on socket
  // connect/disconnect), not every device the account ever registered.
  const devices = await Device.findAll({
    where: { user_id: req.user!.userId, is_active: true, is_online: true },
    attributes: ['id', 'label', 'camera_name', 'device_type', 'is_online', 'last_seen_at', 'created_at'],
    order: [['last_seen_at', 'DESC']],
  });
  res.json({ devices });
});

router.patch('/devices/:id', authMiddleware, async (req, res) => {
  const device = await Device.findOne({
    where: { id: req.params.id, user_id: req.user!.userId },
  });
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const updateSchema = z.object({
    label: z.string().min(1).max(100).optional(),
    camera_name: z.string().min(1).max(100).optional(),
  });

  const data = updateSchema.parse(req.body);
  await device.update(data);
  res.json({ device });
});

router.delete('/devices/:id', authMiddleware, async (req, res) => {
  const device = await Device.findOne({
    where: { id: req.params.id, user_id: req.user!.userId },
  });
  if (!device) return res.status(404).json({ error: 'Device not found' });

  await device.update({ is_active: false });
  res.json({ success: true });
});

export default router;
