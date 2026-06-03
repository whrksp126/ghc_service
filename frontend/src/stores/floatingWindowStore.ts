import { create } from 'zustand';
import { hasDocumentPip, copyStylesTo } from '../lib/pipSupport';

// Tracks which feeds are popped into the desktop Document-PiP OS window. (Mobile / Safari use
// classic single-video PiP, which the OS manages directly — no state needed here.) Clicking a
// tile's PiP button promotes it straight into the always-on-top OS window; toggling again or
// closing the OS window returns it to the in-grid tile.
interface PipState {
  /** Feed ids currently shown in the Document-PiP window. */
  popped: Record<string, true>;
  /** The open Document-PiP OS window (desktop Chromium), or null. */
  pipWindow: Window | null;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  close: (id: string) => void;
  closeAll: () => void;
}

interface DocPipApi {
  requestWindow: (o: { width: number; height: number }) => Promise<Window>;
}

export const useFloatingWindowStore = create<PipState>((set, get) => ({
  popped: {},
  pipWindow: null,

  isOpen: (id) => !!get().popped[id],

  // Async, but called from a click handler — requestWindow runs before the first await so the
  // user-activation requirement is satisfied.
  toggle: async (id) => {
    if (get().popped[id]) {
      get().close(id);
      return;
    }
    if (hasDocumentPip) {
      let win = get().pipWindow;
      if (!win || win.closed) {
        try {
          const dpip = (window as unknown as { documentPictureInPicture: DocPipApi }).documentPictureInPicture;
          win = await dpip.requestWindow({ width: 360, height: 270 });
        } catch {
          return;
        }
        copyStylesTo(win);
        win.document.body.style.margin = '0';
        win.document.body.style.background = '#121212';
        win.addEventListener('pagehide', () => get().closeAll());
        set({ pipWindow: win });
      }
    }
    set((s) => ({ popped: { ...s.popped, [id]: true } }));
  },

  close: (id) =>
    set((s) => {
      if (!s.popped[id]) return s;
      const popped = { ...s.popped };
      delete popped[id];
      if (Object.keys(popped).length === 0 && s.pipWindow) {
        try { s.pipWindow.close(); } catch { /* already gone */ }
        return { popped, pipWindow: null };
      }
      return { popped };
    }),

  closeAll: () =>
    set((s) => {
      if (s.pipWindow) { try { s.pipWindow.close(); } catch { /* ignore */ } }
      return { popped: {}, pipWindow: null };
    }),
}));
