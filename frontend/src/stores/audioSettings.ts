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
      noiseGate: false,
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

/** Map the 0..1 sensitivity slider to an RMS threshold (higher sensitivity → lower threshold). */
export function sensitivityToThreshold(sensitivity: number): number {
  return 0.13 * (1 - sensitivity) + 0.015;
}
