import { create } from 'zustand';
import { getLivekitRoom } from './livekitRoom';

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

/** An element's autoplay was rejected → show the unlock banner. */
export function reportAudioBlocked(): void {
  if (!useAudioUnlock.getState().blocked) {
    console.warn('[audio] playback blocked — showing unlock banner');
    useAudioUnlock.setState({ blocked: true });
  }
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
