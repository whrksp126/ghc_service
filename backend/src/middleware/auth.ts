import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireSecret } from '../lib/requireSecret';

const JWT_SECRET = requireSecret('JWT_SECRET', 'longdcam_dev_secret');

export interface JwtPayload {
  userId: string;
  nickname: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
