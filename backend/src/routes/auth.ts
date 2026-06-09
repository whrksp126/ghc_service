import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User, Device } from '../models';
import { signToken, authMiddleware } from '../middleware/auth';

// 로그인·회원가입 브루트포스 방지: IP당 분당 10회
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' },
});

const router = Router();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3100';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  nickname: z.string().min(1).max(50),
  deviceFingerprint: z.string().min(1).max(255),
  deviceType: z.enum(['phone', 'tablet', 'desktop', 'other']).default('other'),
  deviceLabel: z.string().min(1).max(100).default('My Device'),
});

router.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);

    const existing = await User.findOne({ where: { email: data.email } });
    if (existing) {
      return res.status(409).json({ error: '이미 등록된 이메일입니다' });
    }

    const userId = uuidv4();
    const passwordHash = await bcrypt.hash(data.password, 10);

    const user = await User.create({
      id: userId,
      nickname: data.nickname,
      email: data.email,
      password_hash: passwordHash,
      auth_provider: 'local',
    });

    const device = await Device.create({
      user_id: userId,
      label: data.deviceLabel,
      device_fingerprint: data.deviceFingerprint,
      device_type: data.deviceType,
      last_seen_at: new Date(),
    });

    const token = signToken({ userId: user.id, nickname: user.nickname });

    res.status(201).json({
      token,
      user: { id: user.id, nickname: user.nickname, email: user.email },
      device: { id: device.id, label: device.label },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }
    throw err;
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  deviceFingerprint: z.string().min(1).max(255),
  deviceType: z.enum(['phone', 'tablet', 'desktop', 'other']).default('other'),
  deviceLabel: z.string().min(1).max(100).default('My Device'),
});

router.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const data = loginSchema.parse(req.body);

    const user = await User.findOne({ where: { email: data.email, auth_provider: 'local' } });
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 일치하지 않습니다' });
    }

    const valid = await bcrypt.compare(data.password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '이메일 또는 비밀번호가 일치하지 않습니다' });
    }

    let device = await Device.findOne({
      where: { user_id: user.id, device_fingerprint: data.deviceFingerprint },
    });

    if (device) {
      await device.update({ last_seen_at: new Date() });
    } else {
      device = await Device.create({
        user_id: user.id,
        label: data.deviceLabel,
        device_fingerprint: data.deviceFingerprint,
        device_type: data.deviceType,
        last_seen_at: new Date(),
      });
    }

    const token = signToken({ userId: user.id, nickname: user.nickname });

    res.json({
      token,
      user: { id: user.id, nickname: user.nickname, email: user.email },
      device: { id: device.id, label: device.label },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: err.errors });
    }
    throw err;
  }
});

router.get('/auth/google', (_req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google OAuth not configured' });
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/auth/google/callback', async (req, res) => {
  try {
    const code = req.query.code as string;
    if (!code) {
      return res.redirect(`${FRONTEND_URL}/login?error=google_auth_failed`);
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string };

    if (!tokenData.access_token) {
      console.error('Google token exchange failed:', tokenData.error, tokenData.error_description);
      return res.redirect(`${FRONTEND_URL}/login?error=google_token_failed`);
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json() as { id: string; email: string; name?: string; picture?: string };

    let user = await User.findOne({
      where: { auth_provider: 'google', auth_provider_id: profile.id },
    });

    if (!user) {
      user = await User.findOne({ where: { email: profile.email } });
      if (user) {
        await user.update({
          auth_provider: 'google',
          auth_provider_id: profile.id,
          avatar_url: user.avatar_url || profile.picture || null,
        });
      } else {
        user = await User.create({
          id: uuidv4(),
          nickname: profile.name || profile.email.split('@')[0],
          email: profile.email,
          auth_provider: 'google',
          auth_provider_id: profile.id,
          avatar_url: profile.picture || null,
        });
      }
    }

    const token = signToken({ userId: user.id, nickname: user.nickname });

    res.redirect(`${FRONTEND_URL}/auth/callback?token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.redirect(`${FRONTEND_URL}/login?error=google_auth_failed`);
  }
});

router.get('/auth/me', authMiddleware, async (req, res) => {
  const user = await User.findByPk(req.user!.userId, {
    attributes: ['id', 'nickname', 'avatar_url', 'auth_provider', 'email'],
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

export default router;
