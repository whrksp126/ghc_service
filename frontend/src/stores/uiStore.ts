import { create } from 'zustand';
import type { LayoutMode } from '../types/room';

interface UIState {
  layoutMode: LayoutMode;
  spotlightProducerId: string | null;
  isSidebarOpen: boolean;
  isSettingsOpen: boolean;
  isHomecamMode: boolean;
  /** Feed id shown as an in-app, full-viewport "theater" overlay (floating windows stay on top). */
  maximizedFeedId: string | null;

  setLayoutMode: (mode: LayoutMode) => void;
  setSpotlightProducer: (producerId: string | null) => void;
  toggleSidebar: () => void;
  toggleSettings: () => void;
  setHomecamMode: (v: boolean) => void;
  setMaximizedFeed: (id: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  layoutMode: 'grid',
  spotlightProducerId: null,
  isSidebarOpen: false,
  isSettingsOpen: false,
  isHomecamMode: false,
  maximizedFeedId: null,

  setLayoutMode: (mode) => set({ layoutMode: mode }),
  setSpotlightProducer: (producerId) => set({ spotlightProducerId: producerId }),
  toggleSidebar: () => set((s) => ({ isSidebarOpen: !s.isSidebarOpen })),
  toggleSettings: () => set((s) => ({ isSettingsOpen: !s.isSettingsOpen })),
  setHomecamMode: (v) => set({ isHomecamMode: v }),
  setMaximizedFeed: (id) => set({ maximizedFeedId: id }),
}));
