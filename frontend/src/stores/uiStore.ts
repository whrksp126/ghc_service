import { create } from 'zustand';
import type { LayoutMode } from '../types/room';

interface UIState {
  layoutMode: LayoutMode;
  spotlightProducerId: string | null;
  isSidebarOpen: boolean;
  isSettingsOpen: boolean;
  isHomecamMode: boolean;
  /** Participant keys (`${userId}:${deviceId}`) whose audio I've locally muted. */
  mutedAudio: Record<string, boolean>;
  /** Per-participant local playback volume 0..1 (default 1 when absent). */
  volumeAudio: Record<string, number>;

  setLayoutMode: (mode: LayoutMode) => void;
  setSpotlightProducer: (producerId: string | null) => void;
  toggleSidebar: () => void;
  toggleSettings: () => void;
  setHomecamMode: (v: boolean) => void;
  toggleAudioMute: (key: string) => void;
  setAudioVolume: (key: string, volume: number) => void;
}

export const useUIStore = create<UIState>((set) => ({
  layoutMode: 'grid',
  spotlightProducerId: null,
  isSidebarOpen: false,
  isSettingsOpen: false,
  isHomecamMode: false,
  mutedAudio: {},
  volumeAudio: {},

  setLayoutMode: (mode) => set({ layoutMode: mode }),
  setSpotlightProducer: (producerId) => set({ spotlightProducerId: producerId }),
  toggleSidebar: () => set((s) => ({ isSidebarOpen: !s.isSidebarOpen })),
  toggleSettings: () => set((s) => ({ isSettingsOpen: !s.isSettingsOpen })),
  setHomecamMode: (v) => set({ isHomecamMode: v }),
  toggleAudioMute: (key) =>
    set((s) => ({ mutedAudio: { ...s.mutedAudio, [key]: !s.mutedAudio[key] } })),
  setAudioVolume: (key, volume) =>
    set((s) => ({
      volumeAudio: { ...s.volumeAudio, [key]: Math.max(0, Math.min(1, volume)) },
      // Adjusting volume above 0 implies un-mute; dragging to 0 mutes.
      mutedAudio: { ...s.mutedAudio, [key]: volume <= 0 },
    })),
}));
