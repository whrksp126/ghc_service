// LiveKit SFU connection settings.
// API key/secret sign the join tokens and authenticate the RoomServiceClient; the
// same pair is fed to the livekit-server container via the LIVEKIT_KEYS env var.
import { requireSecret } from '../lib/requireSecret';

export const livekitConfig = {
  apiKey: requireSecret('LIVEKIT_API_KEY', 'devkey'),
  apiSecret: requireSecret('LIVEKIT_API_SECRET', 'localdevsecret0123456789abcdefghij'),
  // ws(s):// URL. RoomServiceClient derives the http(s):// form from this.
  url: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880',
};
