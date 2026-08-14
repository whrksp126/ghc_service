import {
  AccessToken, RoomServiceClient, IngressClient, IngressInput,
  IngressVideoOptions, IngressVideoEncodingPreset, TrackSource,
} from 'livekit-server-sdk';
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
// Join token lifetime. Kept to a single room session length rather than 12h so a leaked
// token can't be replayed for long. Override with LIVEKIT_TOKEN_TTL if needed.
const TOKEN_TTL = process.env.LIVEKIT_TOKEN_TTL || '4h';

export async function createJoinToken(opts: {
  roomName: string;
  userId: string;
  deviceId: string;
  nickname: string;
  deviceLabel: string;
  // Owners/members publish; viewers (no membership in a public room) subscribe only.
  canPublish: boolean;
}): Promise<string> {
  const at = new AccessToken(livekitConfig.apiKey, livekitConfig.apiSecret, {
    identity: `${opts.userId}:${opts.deviceId}`,
    name: opts.nickname,
    metadata: JSON.stringify({ nickname: opts.nickname, deviceLabel: opts.deviceLabel }),
    ttl: TOKEN_TTL,
  });
  at.addGrant({
    roomJoin: true,
    room: opts.roomName,
    canPublish: opts.canPublish,
    canSubscribe: true,
    canPublishData: true,
    // Lets the device update its own metadata at runtime (e.g. the active camera's facing,
    // so peers can mirror a front/selfie feed to match how the sender sees themselves).
    canUpdateOwnMetadata: true,
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

// Build the public RTMP server URL OBS should use. A self-hosted ingress often returns an
// empty (or internal-IP) url, so we construct it from INGRESS_RTMP_HOST — the hostname
// forwarded to port 1935. LiveKit ingress' RTMP application path is `/x` (OBS: Server =
// rtmp://<host>:1935/x, Stream Key = the key). When LiveKit does report a url we keep its
// path/port and only swap the host.
function buildServerUrl(infoUrl: string): string {
  const host = process.env.INGRESS_RTMP_HOST;
  if (!host) return infoUrl || '';
  if (infoUrl) {
    try {
      const u = new URL(infoUrl);
      u.hostname = host;
      return u.toString();
    } catch {
      /* fall through to the standard form */
    }
  }
  return `rtmp://${host}:1935/x`;
}

function toRoomIngress(info: { ingressId: string; url: string; streamKey: string }): RoomIngress {
  return { ingressId: info.ingressId, url: buildServerUrl(info.url), streamKey: info.streamKey };
}

/**
 * Create (or reuse) an RTMP ingress that publishes an OBS broadcast into a room as a
 * participant. High-quality path: OBS → RTMP → LiveKit Ingress → room track. The track then
 * shows up like any other participant via the client's auto-subscribe.
 */
/**
 * Ingress transcode profile. LiveKit's DEFAULT for an RTMP ingress is H264_720P_30FPS_3_LAYERS —
 * 1280x720 @ ~1.9Mbps — so a pristine 1080p browser-live push was being re-encoded down to 720p at
 * a modest bitrate before it ever reached a viewer. That, not the sender, was the quality ceiling.
 * We ask for real 1080p with simulcast kept (3.5Mbps main layer + 540p + 180p), so a good viewer
 * gets a sharp picture while a phone on cellular can still drop to a lower layer.
 *
 * Cost: 1080p×3 layers is roughly 2× the ingress CPU of 720p×3, and the prod compose caps the
 * ingress container at 4 CPUs — so this trades concurrent-live headroom for picture quality.
 * Tune with INGRESS_VIDEO_PRESET (any IngressVideoEncodingPreset name):
 *   H264_1080P_30FPS_3_LAYERS_HIGH_MOTION  4.5Mbps — best for video playback, most CPU
 *   H264_1080P_30FPS_3_LAYERS              3.5Mbps — default
 *   H264_720P_30FPS_3_LAYERS               1.9Mbps — LiveKit's old default, cheapest
 */
const INGRESS_PRESET: IngressVideoEncodingPreset =
  (IngressVideoEncodingPreset as unknown as Record<string, number>)[
    process.env.INGRESS_VIDEO_PRESET || ''
  ] ?? IngressVideoEncodingPreset.H264_1080P_30FPS_3_LAYERS;

function ingressVideoOptions(): IngressVideoOptions {
  return new IngressVideoOptions({
    // Keep publishing as CAMERA: the room UI files a live in with the camera tiles (the OBS /
    // browser-live tile), not the separate screen-share row. Only the encoding changes here.
    source: TrackSource.CAMERA,
    encodingOptions: { case: 'preset', value: INGRESS_PRESET },
  });
}

export async function createRoomIngress(roomName: string, displayName = 'OBS 라이브'): Promise<RoomIngress> {
  // The room UI reads the display name from the participant's *metadata* (nickname), not the
  // LiveKit `name` field — so we set both. Without metadata the tile falls back to "참가자".
  const participantMetadata = JSON.stringify({ nickname: displayName, deviceLabel: 'OBS' });

  // Reuse an existing RTMP ingress for this room so we don't pile up stream keys. If the
  // caller asked for a different name, update it in place (takes effect on the next connect).
  try {
    const existing = await ingressClient.listIngress({ roomName });
    const rtmp = existing.find((i) => i.inputType === IngressInput.RTMP_INPUT && i.streamKey);
    if (rtmp) {
      // Always push the video options through, not just on a name change: ingresses created
      // before the explicit preset existed are still pinned to LiveKit's 720p default, and they
      // are reused forever (one per room). This upgrades them on the next "라이브 열기".
      const needsRename = rtmp.participantName !== displayName;
      const needsPreset =
        rtmp.video?.encodingOptions?.case !== 'preset' ||
        rtmp.video.encodingOptions.value !== INGRESS_PRESET;
      if (needsRename || needsPreset) {
        try {
          await ingressClient.updateIngress(rtmp.ingressId, {
            name: rtmp.name || `${roomName}-obs`,
            participantName: displayName,
            participantMetadata,
            video: ingressVideoOptions(),
          });
        } catch {
          // Update unsupported/failed — keep the existing ingress as-is.
        }
      }
      return toRoomIngress(rtmp);
    }
  } catch {
    // listing failed — fall through to create.
  }

  const info = await ingressClient.createIngress(IngressInput.RTMP_INPUT, {
    name: `${roomName}-obs`,
    roomName,
    participantIdentity: `obs:${roomName}`,
    participantName: displayName,
    participantMetadata,
    video: ingressVideoOptions(),
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

/**
 * Count concurrent live broadcasts (used to enforce MAX_CONCURRENT_LIVES). Counts RTMP
 * ingresses that are actively buffering/publishing media — idle stream keys that were
 * created but never connected don't count. On a listing error we fall back to the active
 * room count (conservative) rather than 0, so the cap isn't silently disabled.
 *
 * IngressState.Status numeric values: ENDPOINT_BUFFERING = 1, ENDPOINT_PUBLISHING = 2.
 */
export async function countActiveLives(): Promise<number> {
  try {
    const all = await ingressClient.listIngress({});
    return all.filter(
      (i) => i.inputType === IngressInput.RTMP_INPUT && (i.state?.status === 1 || i.state?.status === 2)
    ).length;
  } catch {
    try {
      const rooms = await roomService.listRooms();
      return rooms.length;
    } catch {
      return 0;
    }
  }
}
