import { create } from 'zustand';

// Which feed tile currently has its controls overlay/sheet open. Only ONE at a time — opening a
// tile's controls (or the global outside-click handler) updates this, so a previously-open tile's
// controls disappear instead of stacking up. `id` is the feed's stable id (pipId/layoutId).
interface ActiveTileState {
  activeId: string | null;
  setActive: (id: string | null) => void;
}

export const useActiveTile = create<ActiveTileState>((set) => ({
  activeId: null,
  setActive: (id) => set({ activeId: id }),
}));
