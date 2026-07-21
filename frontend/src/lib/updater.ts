// Desktop-only auto-update bridge. Deliberately SEPARATE from `window.ghcNative`
// (src/lib/native.ts): only the Electron shell (Mac/Windows) has an in-app updater,
// so this must never leak into the cross-platform native contract. Mobile WebView,
// PWA and dev browser simply don't inject it, and `getUpdater()` returns null there —
// the UI then renders no update affordance at all.

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'none' } // up to date
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export interface GhcUpdater {
  /** Installed app version (e.g. "0.1.0"). */
  current(): Promise<string>;
  /** Ask the update feed whether a newer version exists (fires onStatus events). */
  check(): Promise<void>;
  /** Download the available update (fires 'downloading' → 'downloaded'). */
  download(): Promise<void>;
  /** Quit and install the downloaded update, then relaunch. */
  install(): Promise<void>;
  /** Subscribe to update lifecycle events. */
  onStatus(cb: (s: UpdateStatus) => void): void;
}

declare global {
  interface Window {
    ghcUpdater?: GhcUpdater;
  }
}

/** The desktop updater bridge if the Electron shell injected it, else null. */
export function getUpdater(): GhcUpdater | null {
  if (typeof window !== 'undefined' && window.ghcUpdater) return window.ghcUpdater;
  return null;
}
