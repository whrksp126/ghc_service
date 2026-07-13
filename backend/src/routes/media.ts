import { Router } from 'express';
import { z } from 'zod';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { sendWithRetry, BUCKET, getPresignedUrl } from '../config/objectstore';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Home-server "watch together" video library lives under this object-store prefix.
const LIBRARY_PREFIX = 'library/';
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v)$/i;

function baseName(key: string): string {
  const file = key.slice(LIBRARY_PREFIX.length);
  return file.replace(VIDEO_EXT, '').replace(/[_-]+/g, ' ').trim() || file;
}

// GET /api/media/library — list playable home-server videos
router.get('/media/library', authMiddleware, async (_req, res) => {
  try {
    const out = await sendWithRetry(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: LIBRARY_PREFIX, MaxKeys: 500 })
    );
    const items = (out.Contents || [])
      .filter((o) => o.Key && VIDEO_EXT.test(o.Key))
      .map((o) => ({ key: o.Key!, name: baseName(o.Key!), size: o.Size ?? 0 }));
    res.json({ items });
  } catch (err: any) {
    console.error('[media:library] list failed:', err.message);
    res.status(500).json({ error: '라이브러리를 불러오지 못했습니다' });
  }
});

const urlSchema = z.object({ key: z.string().min(1).max(500) });

// GET /api/media/library/url?key=library/movie.mp4 — presigned playback URL
router.get('/media/library/url', authMiddleware, async (req, res) => {
  try {
    const { key } = urlSchema.parse({ key: req.query.key });
    if (!key.startsWith(LIBRARY_PREFIX) || !VIDEO_EXT.test(key)) {
      return res.status(400).json({ error: '잘못된 파일입니다' });
    }
    const url = await getPresignedUrl(key, 6 * 3600);
    res.json({ url });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
