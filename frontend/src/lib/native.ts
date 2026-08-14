export type LiveSource =
  | { type: 'window'; id: string; title: string; appName: string; thumbnail?: string }
  | { type: 'screen'; id: string; title: string; thumbnail?: string }
  | { type: 'camera' }
  // Browser source: GHC renders the URL itself (offscreen, never throttled) so it
  // keeps broadcasting across desktop switches / fullscreen — the OBS browser-source model.
  | { type: 'browser'; url: string; name?: string };

export interface LiveStartOptions {
  source: LiveSource;
  rtmpUrl: string;
  streamKey: string;
  captureAudio: boolean;
}

export type LiveStatus =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'live'; sinceMs: number }
  | { state: 'reconnecting' }
  | { state: 'error'; message: string };

export interface LiveMuteState {
  available: boolean; // toggle is usable (false → not supported for this source/OS)
  muted: boolean;     // true → source audio silenced locally (still sent to live)
}

export interface GhcNativeLive {
  listSources(): Promise<LiveSource[]>;
  startLive(opts: LiveStartOptions): Promise<{ ok: boolean; error?: string }>;
  stopLive(): Promise<void>;
  getStatus(): Promise<LiveStatus>;
  onStatus(cb: (s: LiveStatus) => void): () => void;
  getMute(): Promise<LiveMuteState>;
  setMute(muted: boolean): Promise<LiveMuteState>;
  /**
   * Browser live: open the interactive WKWebView helper (it reopens to the last-used page).
   * Opening is decoupled from going live — the user logs in / navigates, then toggles LIVE from
   * the helper window's OWN toolbar. The renderer just hands off ingress credentials.
   */
  openBrowser(opts: { rtmpUrl: string; streamKey: string }): Promise<{ ok: boolean; error?: string }>;
  closeBrowser(): Promise<void>;
  /** Subscribe to the browser helper's current page <title> (for labelling the live tile). */
  onBrowserTitle?(cb: (title: string) => void): () => void;
  /**
   * The helper toolbar's "싱크" button. Viewers buffer the live by a few seconds, and one whose
   * connection stumbled can end up watching behind the others; this asks everyone in the room to
   * jump to the same instant and re-buffer together. Only the broadcaster's shell emits it.
   */
  onBrowserSync?(cb: () => void): () => void;
}

export interface GhcNative {
  platform: 'desktop' | 'mobile' | 'web';
  version: string;
  /** Direct backend origin (e.g. http://localhost:3001) to bypass the dev proxy for Socket.IO. */
  apiBase?: string;
  live: GhcNativeLive;
}

declare global {
  interface Window {
    ghcNative?: GhcNative;
  }
}

export const nativeBridge = (): GhcNative | undefined => window.ghcNative;
export const isNativeShell = (): boolean => !!window.ghcNative?.live;
export const nativePlatform = (): 'desktop' | 'mobile' | 'web' => window.ghcNative?.platform ?? 'web';
