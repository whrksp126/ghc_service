import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { livekitConfig } from '../config/livekit';

// RoomServiceClient talks to the LiveKit HTTP API (room delete / kick). It needs the
// http(s):// origin, while clients connect over ws(s):// — derive one from the other.
const httpUrl = livekitConfig.url.replace(/^ws/, 'http');
const roomService = new RoomServiceClient(httpUrl, livekitConfig.apiKey, livekitConfig.apiSecret);

/**
 * Mint a join token for one device. identity is `${userId}:${deviceId}` so a single
 * user's multiple devices are distinct LiveKit participants; metadata carries the
 * display info the room UI needs.
 */
export async function createJoinToken(opts: {
  roomName: string;
  userId: string;
  deviceId: string;
  nickname: string;
  deviceLabel: string;
}): Promise<string> {
  const at = new AccessToken(livekitConfig.apiKey, livekitConfig.apiSecret, {
    identity: `${opts.userId}:${opts.deviceId}`,
    name: opts.nickname,
    metadata: JSON.stringify({ nickname: opts.nickname, deviceLabel: opts.deviceLabel }),
    ttl: '12h',
  });
  at.addGrant({
    roomJoin: true,
    room: opts.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

/** Tear down a room on the SFU (owner ends the room). Best-effort. */
export async function deleteLivekitRoom(roomName: string): Promise<void> {
  try {
    await roomService.deleteRoom(roomName);
  } catch {
    // Room may not exist on the SFU yet (nobody published) — ignore.
  }
}
