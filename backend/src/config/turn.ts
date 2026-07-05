import crypto from 'crypto';
import { requireSecret } from '../lib/requireSecret';

const TURN_SECRET = requireSecret('TURN_SECRET', 'ghc_turn_secret');
const TURN_SERVER = process.env.TURN_SERVER || 'turn:ghc-turn.ghmate.com:3478';
const TURNS_SERVER = process.env.TURNS_SERVER || 'turns:ghc-turn.ghmate.com:5349';
const STUN_SERVER = process.env.STUN_SERVER || 'stun:stun.l.google.com:19302';

export function generateTurnCredentials(userId: string) {
  const ttl = 86400; // 24 hours
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = `${timestamp}:${userId}`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');

  return {
    iceServers: [
      { urls: STUN_SERVER },
      {
        urls: [TURN_SERVER, TURNS_SERVER],
        username,
        credential,
      },
    ],
    iceTransportPolicy: 'all' as const,
  };
}
