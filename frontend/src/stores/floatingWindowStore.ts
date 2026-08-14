import { create } from 'zustand';
import { preferDocumentPip, copyStylesTo, openNativePipWindow, hasWindowPip } from '../lib/pipSupport';

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
  /** Resolves false when no PiP window could be opened, so the caller can fall back. */
  toggle: (id: string) => Promise<boolean>;
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
      return true;
    }
    if (hasWindowPip()) {
      let win = get().pipWindow;
      if (!win || win.closed) {
        if (preferDocumentPip()) {
          // Plain web Chromium: Document PiP.
          try {
            const dpip = (window as unknown as { documentPictureInPicture?: DocPipApi }).documentPictureInPicture;
            if (!dpip) return false;
            win = await dpip.requestWindow({ width: 640, height: 400 });
          } catch {
            return false;
          }
          copyStylesTo(win);
          win.document.body.style.margin = '0';
          win.document.body.style.background = '#121212';
        } else {
          // Desktop shell: our own frameless always-on-top window (freely resizable, unlike the
          // OS PiP overlay it replaces). Styles/body are prepared inside the helper.
          win = openNativePipWindow();
          if (!win) return false;
        }
        win.addEventListener('pagehide', () => get().closeAll());
        set({ pipWindow: win });
      }
    }
    set((s) => ({ popped: { ...s.popped, [id]: true } }));
    return true;
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
