import { AccessToken, RoomServiceClient, IngressClient, IngressInput } from 'livekit-server-sdk';
import { livekitConfig } from '../config/livekit';

// RoomServiceClient talks to the LiveKit HTTP API (room delete / kick). It needs the
// http(s):// origin, while clients connect over ws(s):// — derive one from the other.
const httpUrl = livekitConfig.url.replace(/^ws/, 'http');
const roomService = new RoomServiceClient(httpUrl, livekitConfig.apiKey, livekitConfig.apiSecret);
const ingressClient = new IngressClient(httpUrl, livekitConfig.apiKey, livekitConfig.apiSecret);

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

export interface RoomIngress {
  ingressId: string;
  /** RTMP server URL to paste into OBS (Settings → Stream → Custom). */
  url: string;
  /** Stream key to paste into OBS. */
  streamKey: string;
}

// LiveKit returns the RTMP URL with the server's own (often internal) IP. Rewrite the host
// to the publicly reachable one so OBS — which may run anywhere — can connect. Set
// INGRESS_RTMP_HOST to the forwarded hostname (e.g. longdcam-rtmp.ghmate.com).
function toPublicRtmpUrl(url: string): string {
  const host = process.env.INGRESS_RTMP_HOST;
  if (!host) return url;
  try {
    const u = new URL(url);
    u.hostname = host;
    return u.toString();
  } catch {
    return url;
  }
}

function toRoomIngress(info: { ingressId: string; url: string; streamKey: string }): RoomIngress {
  return { ingressId: info.ingressId, url: toPublicRtmpUrl(info.url), streamKey: info.streamKey };
}

/**
 * Create (or reuse) an RTMP ingress that publishes an OBS broadcast into a room as a
 * participant. High-quality path: OBS → RTMP → LiveKit Ingress → room track. The track then
 * shows up like any other participant via the client's auto-subscribe.
 */
export async function createRoomIngress(roomName: string, displayName = 'OBS 라이브'): Promise<RoomIngress> {
  // Reuse an existing RTMP ingress for this room so we don't pile up stream keys.
  try {
    const existing = await ingressClient.listIngress({ roomName });
    const rtmp = existing.find((i) => i.inputType === IngressInput.RTMP_INPUT && i.streamKey);
    if (rtmp) return toRoomIngress(rtmp);
  } catch {
    // listing failed — fall through to create.
  }

  const info = await ingressClient.createIngress(IngressInput.RTMP_INPUT, {
    name: `${roomName}-obs`,
    roomName,
    participantIdentity: `obs:${roomName}`,
    participantName: displayName,
  });
  return toRoomIngress(info);
}

export async function listRoomIngress(roomName: string): Promise<RoomIngress[]> {
  try {
    const list = await ingressClient.listIngress({ roomName });
    return list.filter((i) => i.streamKey).map(toRoomIngress);
  } catch {
    return [];
  }
}

export async function deleteRoomIngress(ingressId: string): Promise<void> {
  try {
    await ingressClient.deleteIngress(ingressId);
  } catch {
    // Already gone — ignore.
  }
}
