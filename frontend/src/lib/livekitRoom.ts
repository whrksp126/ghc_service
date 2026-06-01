import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalVideoTrack,
} from 'livekit-client';
import { LIVEKIT_URL } from '../config/constants';
import { useRoomStore } from '../stores/roomStore';
import type { ConsumerInfo } from '../types/room';

// Single LiveKit Room per browser tab. Both the foreground room UI (RoomPage) and the
// headless "remote-started device" path (backgroundCamera) drive this one connection —
// LiveKit rejects a second connection from the same identity, so it must be a singleton.
let room: Room | null = null;
// Mic is published as a CLONE so the noise gate can mute the sent track while the local
// voice-activity analyser keeps reading the original (muting disables the MediaStreamTrack).
const cloneBySid = new Map<string, MediaStreamTrack>();

function parseIdentity(identity: string): { userId: string; deviceId: string } {
  const i = identity.indexOf(':');
  if (i < 0) return { userId: identity, deviceId: '' };
  return { userId: identity.slice(0, i), deviceId: identity.slice(i + 1) };
}

function metaOf(p: RemoteParticipant): { nickname?: string; deviceLabel?: string } {
  try {
    return p.metadata ? JSON.parse(p.metadata) : {};
  } catch {
    return {};
  }
}

function sourceOf(pub: RemoteTrackPublication): ConsumerInfo['source'] {
  switch (pub.source) {
    case Track.Source.Camera: return 'camera';
    case Track.Source.ScreenShare: return 'screen';
    case Track.Source.Microphone: return 'microphone';
    default: return 'unknown';
  }
}

function onTrackSubscribed(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) {
  if (track.kind !== Track.Kind.Audio && track.kind !== Track.Kind.Video) return;
  const { userId, deviceId } = parseIdentity(participant.identity);
  const meta = metaOf(participant);
  useRoomStore.getState().addConsumer({
    consumerId: pub.trackSid,
    producerId: pub.trackSid,
    userId,
    deviceId,
    kind: track.kind === Track.Kind.Audio ? 'audio' : 'video',
    track: track.mediaStreamTrack,
    paused: false,
    nickname: meta.nickname,
    deviceLabel: meta.deviceLabel,
    source: sourceOf(pub),
    lkTrack: track,
  });
}

function onTrackUnsubscribed(_t: RemoteTrack, pub: RemoteTrackPublication) {
  useRoomStore.getState().removeConsumer(pub.trackSid);
}

export function getLivekitRoom(): Room | null {
  return room;
}

export function isRoomConnected(): boolean {
  return room?.state === 'connected';
}

export async function connectToRoom(token: string): Promise<Room> {
  if (room && (room.state === 'connected' || room.state === 'connecting')) return room;
  if (room) {
    try { await room.disconnect(); } catch { /* ignore */ }
    room = null;
  }

  const r = new Room({
    adaptiveStream: true,
    dynacast: true,
    publishDefaults: {
      simulcast: true,
      // 1080p / 540p / 180p simulcast. The top layer is a ceiling, not a fixed rate —
      // LiveKit's send-side congestion control scales it down automatically on a weak
      // link (no stutter), while dynacast only forwards the layer each viewer is actually
      // watching, so a small room stays well under the 100 Mb/s server NIC.
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h540],
      videoEncoding: { maxBitrate: 3_500_000, maxFramerate: 30 },
      screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 15 },
      dtx: true,
      red: true,
    },
  });

  r.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
  r.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
  r.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
    for (const pub of p.trackPublications.values()) {
      useRoomStore.getState().removeConsumer(pub.trackSid);
    }
  });
  r.on(RoomEvent.Reconnecting, () => useRoomStore.getState().setReconnecting(true));
  r.on(RoomEvent.Reconnected, () => useRoomStore.getState().setReconnecting(false));

  await r.connect(LIVEKIT_URL, token);
  room = r;
  return r;
}

export async function disconnectRoom(): Promise<void> {
  for (const clone of cloneBySid.values()) clone.stop();
  cloneBySid.clear();
  if (room) {
    try { await room.disconnect(); } catch { /* ignore */ }
    room = null;
  }
}

/**
 * Publish a local track. Mic is cloned (see cloneBySid). Returns the publication's
 * trackSid, used everywhere else as the producerId equivalent.
 */
export async function publishTrack(
  track: MediaStreamTrack,
  source: 'camera' | 'microphone' | 'screen'
): Promise<string | null> {
  if (!room || room.state !== 'connected') return null;

  if (source === 'microphone') {
    const clone = track.clone();
    const pub = await room.localParticipant.publishTrack(clone, {
      source: Track.Source.Microphone,
      name: 'microphone',
    });
    cloneBySid.set(pub.trackSid, clone);
    return pub.trackSid;
  }

  if (source === 'screen') {
    const pub = await room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShare,
      name: 'screen',
      simulcast: false,
      videoEncoding: { maxBitrate: 2_000_000, maxFramerate: 15 },
    });
    return pub.trackSid;
  }

  const pub = await room.localParticipant.publishTrack(track, {
    source: Track.Source.Camera,
    name: 'camera',
  });
  return pub.trackSid;
}

export async function unpublishTrack(trackSid: string | null): Promise<void> {
  if (!room || !trackSid) return;
  const pub = room.localParticipant.trackPublications.get(trackSid);
  if (pub?.track) {
    await room.localParticipant.unpublishTrack(pub.track);
  }
  const clone = cloneBySid.get(trackSid);
  if (clone) {
    clone.stop();
    cloneBySid.delete(trackSid);
  }
}

/** Pause/resume sending a published track (mic button + noise gate). */
export async function setTrackMuted(trackSid: string | null, muted: boolean): Promise<void> {
  if (!room || !trackSid) return;
  const pub = room.localParticipant.trackPublications.get(trackSid);
  if (!pub) return;
  if (muted) await pub.mute();
  else await pub.unmute();
}

/** Swap the underlying device track of a published video track (camera switch). */
export async function replacePublishedTrack(trackSid: string | null, newTrack: MediaStreamTrack): Promise<void> {
  if (!room || !trackSid) return;
  const pub = room.localParticipant.trackPublications.get(trackSid);
  const lt = pub?.track as LocalVideoTrack | undefined;
  if (lt && typeof lt.replaceTrack === 'function') {
    await lt.replaceTrack(newTrack);
  }
}
