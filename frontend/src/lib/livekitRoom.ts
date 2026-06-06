import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  AudioPresets,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalVideoTrack,
} from 'livekit-client';
import { LIVEKIT_URL } from '../config/constants';
import { useRoomStore } from '../stores/roomStore';
import type { ConsumerInfo } from '../types/room';

// Phones can't sustain a 1080p uplink and mobile Chrome's H.264 simulcast is unreliable
// (often only the lowest layer is actually sent → blocky). So phones publish a single
// solid 720p H.264 stream; desktops keep 1080p simulcast.
const isMobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Single LiveKit Room per browser tab. Both the foreground room UI (RoomPage) and the
// headless "remote-started device" path (backgroundCamera) drive this one connection —
// LiveKit rejects a second connection from the same identity, so it must be a singleton.
let room: Room | null = null;

// Mic is published through a Web Audio graph (source → gain → MediaStreamDestination) instead of a
// raw track, so the noise gate can fade the SENT audio with a GainNode (continuous RTP) rather than
// muting the LiveKit publication on every utterance — pub.mute()/unmute() causes a "tick"/glitch at
// each speech onset on some receivers (esp. iPad/WebKit). The gain graph is orthogonal to the manual
// mic-mute button (pub.mute()), so they don't fight. The local voice-activity analyser keeps reading
// the ORIGINAL track, so it still detects speech to re-open the gate even while gain is 0.
interface MicGraph {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  dest: MediaStreamAudioDestinationNode;
  out: MediaStreamTrack;
}
const micGraphBySid = new Map<string, MicGraph>();

// User-controlled transmit gain (mic volume). The gate opens to THIS value (not a hardcoded 1) so a
// quiet voice can be boosted above a loud live source. Persisted setting drives it via setMicVolume.
let desiredMicGain = 1;

let micCtx: AudioContext | null = null;
function ensureMicCtx(): AudioContext {
  if (!micCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    micCtx = new Ctor();
  }
  if (micCtx.state === 'suspended') void micCtx.resume().catch(() => {});
  return micCtx;
}

function teardownMicGraph(g: MicGraph): void {
  try { g.source.disconnect(); } catch { /* ignore */ }
  try { g.gain.disconnect(); } catch { /* ignore */ }
  try { g.out.stop(); } catch { /* ignore */ }
}

function parseIdentity(identity: string): { userId: string; deviceId: string } {
  const i = identity.indexOf(':');
  if (i < 0) return { userId: identity, deviceId: '' };
  return { userId: identity.slice(0, i), deviceId: identity.slice(i + 1) };
}

function metaOf(p: RemoteParticipant): { nickname?: string; deviceLabel?: string; facing?: ConsumerInfo['facing'] } {
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
  if (track.kind === Track.Kind.Audio) {
    console.info('[livekit] audio subscribed', { from: `${userId}:${deviceId}`, trackSid: pub.trackSid });
  }
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
    facing: meta.facing,
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
      // H.264 uses the phone's hardware encoder (VP8 is software-encoded on mobile and
      // turns blocky). Desktop keeps simulcast 1080p/540p/180p; mobile sends a single
      // sustainable 720p stream.
      videoCodec: 'h264',
      backupCodec: { codec: 'vp8' },
      simulcast: !isMobile,
      videoSimulcastLayers: isMobile ? [] : [VideoPresets.h180, VideoPresets.h540],
      videoEncoding: { maxBitrate: isMobile ? 1_700_000 : 3_500_000, maxFramerate: 30 },
      screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 15 },
      // Explicit high-quality Opus (~96kbps) — without this LiveKit falls back to a low default
      // bitrate, which is the main reason voice sounded thin/low-quality. Bandwidth is a non-issue
      // here (only 1–2 video streams), so favour fidelity.
      audioPreset: AudioPresets.musicHighQuality,
      // DTX off: our noise gate already stops sending during silence; DTX on top can clip
      // the first syllable / add comfort-noise artifacts. RED stays on for loss resilience.
      dtx: false,
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
  // A peer switched camera (front↔back) → its participant metadata changes. Propagate the new
  // facing onto that device's consumers so viewers re-mirror (front=selfie) to match the sender.
  r.on(RoomEvent.ParticipantMetadataChanged, (_prev, participant) => {
    const { userId, deviceId } = parseIdentity(participant.identity);
    let facing: ConsumerInfo['facing'];
    try {
      facing = participant.metadata ? JSON.parse(participant.metadata).facing : undefined;
    } catch {
      facing = undefined;
    }
    const store = useRoomStore.getState();
    for (const c of store.consumers) {
      if (c.userId === userId && c.deviceId === deviceId && c.facing !== facing) {
        store.updateConsumer(c.consumerId, { facing });
      }
    }
  });
  r.on(RoomEvent.Reconnecting, () => useRoomStore.getState().setReconnecting(true));
  r.on(RoomEvent.Reconnected, () => useRoomStore.getState().setReconnecting(false));

  await r.connect(LIVEKIT_URL, token);
  room = r;

  // Browsers block audio autoplay until a user gesture. LiveKit routes subscribed audio through
  // its own elements/Web Audio, so a plain <audio>.play() isn't enough — `room.startAudio()` must
  // run from a real gesture or remote/live audio stays silent on the web (Electron is lenient).
  // Try immediately, then on the first interactions until playback is unlocked.
  attachAudioUnlock(r);

  return r;
}

/** Unlock LiveKit audio playback on a user gesture (web autoplay policy). */
function attachAudioUnlock(r: Room): void {
  const tryStart = () => {
    void r.startAudio().catch(() => {});
    // A user gesture also unblocks the mic Web Audio graph if it started suspended (otherwise the
    // published mic would be silent — i.e. nobody can hear this publisher).
    if (micCtx?.state === 'suspended') void micCtx.resume().catch(() => {});
  };
  const onGesture = () => {
    if (micCtx?.state === 'suspended') void micCtx.resume().catch(() => {});
    void r.startAudio()
      .then(() => {
        document.removeEventListener('pointerdown', onGesture);
        document.removeEventListener('keydown', onGesture);
        document.removeEventListener('touchend', onGesture);
      })
      .catch(() => {});
  };
  tryStart(); // works on the gesture that opened the room (button click)
  if (!r.canPlaybackAudio) {
    document.addEventListener('pointerdown', onGesture);
    document.addEventListener('keydown', onGesture);
    document.addEventListener('touchend', onGesture);
  }
  // Some browsers report blocked only after a track arrives — re-arm on status change.
  r.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (!r.canPlaybackAudio) {
      document.addEventListener('pointerdown', onGesture);
      document.addEventListener('keydown', onGesture);
      document.addEventListener('touchend', onGesture);
    }
  });
}

/**
 * Publish this device's active camera facing into its LiveKit participant metadata (merged with
 * the existing nickname/deviceLabel) so peers can mirror a front/selfie feed. Needs the token's
 * canUpdateOwnMetadata grant; no-ops before connect or when unchanged.
 */
export async function setLocalFacing(facing: ConsumerInfo['facing']): Promise<void> {
  const lp = room?.localParticipant;
  if (!lp) return;
  let meta: Record<string, unknown> = {};
  try {
    meta = lp.metadata ? JSON.parse(lp.metadata) : {};
  } catch {
    meta = {};
  }
  if (meta.facing === facing) return;
  try {
    await lp.setMetadata(JSON.stringify({ ...meta, facing }));
  } catch {
    /* no grant / not connected yet — ignore */
  }
}

export async function disconnectRoom(): Promise<void> {
  for (const g of micGraphBySid.values()) teardownMicGraph(g);
  micGraphBySid.clear();
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
    // Route the mic through source → gain → destination so the noise gate fades the SENT audio
    // with the gain node (no publication mute glitch). Publish the destination's track.
    const ctx = ensureMicCtx();
    const srcNode = ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = ctx.createGain();
    gain.gain.value = desiredMicGain;
    const dest = ctx.createMediaStreamDestination();
    srcNode.connect(gain);
    gain.connect(dest);
    const out = dest.stream.getAudioTracks()[0];
    const pub = await room.localParticipant.publishTrack(out, {
      source: Track.Source.Microphone,
      name: 'microphone',
    });
    micGraphBySid.set(pub.trackSid, { ctx, source: srcNode, gain, dest, out });
    console.info('[livekit] mic published', { trackSid: pub.trackSid, ctxState: ctx.state });
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
  const g = micGraphBySid.get(trackSid);
  if (g) {
    teardownMicGraph(g);
    micGraphBySid.delete(trackSid);
  }
}

/** Noise-gate the mic by fading the published audio's gain (no publication mute → no onset glitch).
 *  A short time-constant ramp avoids clicks. Orthogonal to the manual mic mute, which disables the
 *  source MediaStreamTrack (deviceStore) and so silences the graph input regardless of gain. */
export function setMicGateOpen(trackSid: string | null, open: boolean): void {
  if (!trackSid) return;
  const g = micGraphBySid.get(trackSid);
  if (!g) return;
  if (g.ctx.state === 'suspended') void g.ctx.resume().catch(() => {});
  g.gain.gain.setTargetAtTime(open ? desiredMicGain : 0, g.ctx.currentTime, 0.015);
}

/** Set the transmit gain (mic volume). Applies immediately to any currently-open mic so a live
 *  volume tweak is audible at once; gated (silent) mics pick it up next time they open. */
export function setMicVolume(gain: number): void {
  desiredMicGain = gain;
  for (const g of micGraphBySid.values()) {
    if (g.gain.gain.value > 0.001) g.gain.gain.setTargetAtTime(gain, g.ctx.currentTime, 0.02);
  }
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
