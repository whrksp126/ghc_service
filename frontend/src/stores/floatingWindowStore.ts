import { create } from 'zustand';

export interface FloatingWindow {
  /** Matches the feed id in RoomPage's allFeeds. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export const FLOATING_MIN = { w: 120, h: 90 };

function maxSize() {
  if (typeof window === 'undefined') return { w: 960, h: 720 };
  return { w: Math.round(window.innerWidth * 0.85), h: Math.round(window.innerHeight * 0.85) };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

interface FloatingWindowState {
  windows: Record<string, FloatingWindow>;
  topZ: number;
  /** True while popped-out windows are hosted in a single OS Document-PiP window. */
  osWindow: boolean;
  open: (id: string) => void;
  close: (id: string) => void;
  toggle: (id: string) => void;
  isOpen: (id: string) => boolean;
  move: (id: string, x: number, y: number) => void;
  resize: (id: string, w: number, h: number) => void;
  focus: (id: string) => void;
  setOsWindow: (v: boolean) => void;
  closeAll: () => void;
}

export const useFloatingWindowStore = create<FloatingWindowState>((set, get) => ({
  windows: {},
  topZ: 1,
  osWindow: false,

  open: (id) =>
    set((s) => {
      if (s.windows[id]) return s;
      const z = s.topZ + 1;
      // Cascade new windows so they don't stack exactly on top of each other.
      const n = Object.keys(s.windows).length;
      const dft = { w: 240, h: 180 };
      const x = clamp(40 + n * 28, 0, (typeof window !== 'undefined' ? window.innerWidth : 1280) - dft.w);
      const y = clamp(80 + n * 28, 0, (typeof window !== 'undefined' ? window.innerHeight : 720) - dft.h);
      return { windows: { ...s.windows, [id]: { id, x, y, ...dft, z } }, topZ: z };
    }),

  close: (id) =>
    set((s) => {
      if (!s.windows[id]) return s;
      const next = { ...s.windows };
      delete next[id];
      return { windows: next };
    }),

  toggle: (id) => (get().windows[id] ? get().close(id) : get().open(id)),

  isOpen: (id) => !!get().windows[id],

  move: (id, x, y) =>
    set((s) => {
      const w = s.windows[id];
      if (!w) return s;
      return { windows: { ...s.windows, [id]: { ...w, x, y } } };
    }),

  resize: (id, w, h) =>
    set((s) => {
      const win = s.windows[id];
      if (!win) return s;
      const mx = maxSize();
      return {
        windows: {
          ...s.windows,
          [id]: { ...win, w: clamp(w, FLOATING_MIN.w, mx.w), h: clamp(h, FLOATING_MIN.h, mx.h) },
        },
      };
    }),

  focus: (id) =>
    set((s) => {
      const w = s.windows[id];
      if (!w) return s;
      const z = s.topZ + 1;
      return { windows: { ...s.windows, [id]: { ...w, z } }, topZ: z };
    }),

  setOsWindow: (v) => set({ osWindow: v }),

  closeAll: () => set({ windows: {}, osWindow: false }),
}));
