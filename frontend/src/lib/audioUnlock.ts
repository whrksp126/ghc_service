import { create } from 'zustand';
import { getLivekitRoom } from './livekitRoom';
import { isNativeShell } from './native';

/**
 * Mobile browsers (esp. Android Chrome) block audio playback until a user gesture. Each remote
 * participant plays through its own <audio> element (RoomPage RemoteAudio); if play() is rejected
 * the participant is silent with no hint to the user. This tiny store collects every audio
 * element's play() retry and surfaces a single "tap to enable sound" banner — one tap then plays
 * them all (plus room.startAudio()). This is the fix for "Android can't hear anyone".
 */
interface AudioUnlockState {
  blocked: boolean;
}
export const useAudioUnlock = create<AudioUnlockState>(() => ({ blocked: false }));

const players = new Set<() => Promise<void> | void>();

/** Register an audio element's play() retry. Returns an unregister fn for cleanup. */
export function registerAudioEl(play: () => Promise<void> | void): () => void {
  players.add(play);
  return () => { players.delete(play); };
}

/**
 * An element's play() was rejected. Only a genuine autoplay block (`NotAllowedError`) is worth the
 * banner: play() also rejects with AbortError every time a track/srcObject changes under it
 * (participants joining, feeds re-attaching), and treating that as "blocked" made the banner pop
 * up on every room change and stick until tapped. The desktop shell never blocks autoplay at all.
 */
export function reportAudioBlocked(err?: unknown): void {
  if (isNativeShell()) return;
  const name = (err as { name?: string } | undefined)?.name;
  if (name !== 'NotAllowedError') return;
  if (!useAudioUnlock.getState().blocked) {
    console.warn('[audio] playback blocked — showing unlock banner');
    useAudioUnlock.setState({ blocked: true });
  }
}

/** A play() succeeded → the block is over; drop the banner without needing a tap on it. */
export function reportAudioPlaying(): void {
  if (useAudioUnlock.getState().blocked) useAudioUnlock.setState({ blocked: false });
}

/** play() wrapper that keeps the banner state in sync either way. */
export function playTracked(el: HTMLMediaElement): Promise<void> {
  return Promise.resolve(el.play()).then(reportAudioPlaying, (e) => { reportAudioBlocked(e); throw e; });
}

/** Play every registered audio element + unlock LiveKit. Called from a real user gesture. */
export async function unlockAllAudio(): Promise<void> {
  try { await getLivekitRoom()?.startAudio(); } catch { /* ignore */ }
  let anyFailed = false;
  for (const p of players) {
    try { await p(); } catch { anyFailed = true; }
  }
  useAudioUnlock.setState({ blocked: anyFailed });
  console.info('[audio] unlockAllAudio', { remaining: anyFailed });
}
