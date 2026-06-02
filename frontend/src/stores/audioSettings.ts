import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Mic settings. The browser DSP (echo cancellation / noise suppression / auto gain) is
 * always forced ON — echo must never happen, so we don't expose toggles that could turn
 * AEC off (a disabled AEC was the source of the heavy echo). What remains user-tunable is
 * the noise gate + its sensitivity threshold (voice-activity glow / transmit gate).
 */
interface AudioSettingsState {
  /** When on, the mic only transmits while you're above the threshold. */
  noiseGate: boolean;
  /**
   * RMS gate threshold the mic must exceed to count as speech. Set directly by the user by
   * dragging the marker on the live meter (replaces the old abstract 둔감/민감 slider whose
   * mapped range was too narrow). Roughly: normal speech ≈ 0.05, quiet room noise < 0.02.
   */
  threshold: number;
  set: (patch: Partial<AudioSettingsState>) => void;
}

/** Editable range for the threshold; also the meter's max (full width === THRESHOLD_MAX). */
export const THRESHOLD_MIN = 0.005;
export const THRESHOLD_MAX = 0.3;

export const useAudioSettings = create<AudioSettingsState>()(
  persist(
    (set) => ({
      // On by default: only transmit while actually speaking, so room noise / silence
      // isn't sent. Paired with browser noise suppression + a 600ms hangover (RoomPage).
      noiseGate: true,
      threshold: 0.05,
      set: (patch) => set(patch),
    }),
    {
      name: 'longdcam-audio',
      version: 1,
      // v0 stored a 0..1 `sensitivity`; map it onto the new direct threshold.
      migrate: (state: any, version) => {
        if (version === 0 && state && typeof state.sensitivity === 'number') {
          state.threshold = 0.075 * (1 - state.sensitivity) + 0.012;
          delete state.sensitivity;
        }
        return state;
      },
    }
  )
);

/**
 * Audio constraints for getUserMedia / applyConstraints. AEC + noise suppression + auto
 * gain are always forced ON (no echo, ever) — not user-toggleable.
 */
export function micConstraints(): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
}
