import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Discord-style mic settings. The browser's own DSP (echo cancel / noise suppression /
 * auto gain) is exposed as toggles, plus an input-sensitivity slider that drives both the
 * voice-activity glow threshold and an optional noise gate (only transmit above threshold).
 */
interface AudioSettingsState {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** When on, the mic only transmits while you're above the sensitivity threshold. */
  noiseGate: boolean;
  /** 0 (둔감) .. 1 (민감). Higher = triggers at a lower volume. */
  sensitivity: number;
  set: (patch: Partial<AudioSettingsState>) => void;
}

export const useAudioSettings = create<AudioSettingsState>()(
  persist(
    (set) => ({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // On by default: only transmit while actually speaking, so room noise / silence
      // isn't sent. Paired with browser noise suppression + a 600ms hangover (RoomPage).
      noiseGate: true,
      sensitivity: 0.5,
      set: (patch) => set(patch),
    }),
    { name: 'longdcam-audio' }
  )
);

/** Audio constraints for getUserMedia / applyConstraints, derived from current settings. */
export function micConstraints(): MediaTrackConstraints {
  const { echoCancellation, noiseSuppression, autoGainControl } = useAudioSettings.getState();
  return { echoCancellation, noiseSuppression, autoGainControl };
}

/**
 * Map the 0..1 sensitivity slider to an RMS gate threshold. Tuned so the default (0.5)
 * reliably passes normal speech (~0.05) while blocking quiet room noise; "둔감"(0) needs
 * loud speech, "민감"(1) opens on almost anything.
 */
export function sensitivityToThreshold(sensitivity: number): number {
  return 0.075 * (1 - sensitivity) + 0.012;
}
