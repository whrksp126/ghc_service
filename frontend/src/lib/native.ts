export type LiveSource =
  | { type: 'window'; id: string; title: string; appName: string; thumbnail?: string }
  | { type: 'screen'; id: string; title: string; thumbnail?: string }
  | { type: 'camera' }
  // Browser source: longdcam renders the URL itself (offscreen, never throttled) so it
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

export interface LongdcamNativeLive {
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
}

export interface LongdcamNative {
  platform: 'desktop' | 'mobile' | 'web';
  version: string;
  /** Direct backend origin (e.g. http://localhost:3001) to bypass the dev proxy for Socket.IO. */
  apiBase?: string;
  live: LongdcamNativeLive;
}

declare global {
  interface Window {
    longdcamNative?: LongdcamNative;
  }
}

export const nativeBridge = (): LongdcamNative | undefined => window.longdcamNative;
export const isNativeShell = (): boolean => !!window.longdcamNative?.live;
export const nativePlatform = (): 'desktop' | 'mobile' | 'web' => window.longdcamNative?.platform ?? 'web';
