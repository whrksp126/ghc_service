import { Router } from 'express';
import { z } from 'zod';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { s3, BUCKET, getPresignedUrl } from '../config/objectstore';
import path from 'path';

const router = Router();

const RELEASES_PREFIX = 'releases/';

const WIN_EXT = /\.exe$/i;
const MAC_EXT = /\.(dmg|zip)$/i;

const querySchema = z.object({
  platform: z.enum(['win', 'mac']),
});

function isAllowedExt(platform: 'win' | 'mac', key: string): boolean {
  return platform === 'win' ? WIN_EXT.test(key) : MAC_EXT.test(key);
}

// GET /api/releases/latest?platform=win|mac
// Public — no authMiddleware
router.get('/releases/latest', async (req, res) => {
  try {
    const { platform } = querySchema.parse({ platform: req.query.platform });

    const prefix = `${RELEASES_PREFIX}${platform}/`;

    const out = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000 })
    );

    const candidates = (out.Contents || []).filter((o) => {
      if (!o.Key) return false;
      // prefix 화이트리스트: releases/로 시작해야 함
      if (!o.Key.startsWith(RELEASES_PREFIX)) return false;
      // 확장자 화이트리스트
      return isAllowedExt(platform, o.Key);
    });

    if (candidates.length === 0) {
      return res.status(404).json({ error: '아직 배포된 설치파일이 없습니다' });
    }

    // LastModified 기준 최신 객체 선택
    const latest = candidates.reduce((prev, curr) => {
      const prevTime = prev.LastModified?.getTime() ?? 0;
      const currTime = curr.LastModified?.getTime() ?? 0;
      return currTime > prevTime ? curr : prev;
    });

    const key = latest.Key!;
    const url = await getPresignedUrl(key, 6 * 60 * 60);

    return res.json({
      platform,
      key,
      filename: path.basename(key),
      size: latest.Size ?? 0,
      url,
      updatedAt: latest.LastModified?.toISOString() ?? null,
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'platform은 win 또는 mac이어야 합니다' });
    }
    console.error('[releases:latest] failed:', err.message);
    return res.status(500).json({ error: '릴리스 정보를 불러오지 못했습니다' });
  }
});

export default router;
