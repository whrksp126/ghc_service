// Capability detection for promoting in-app floating windows to real OS windows.
// - Document PiP: Chromium desktop only — an always-on-top OS window that can host arbitrary
//   DOM (multiple camera tiles + controls). Floats over other apps / fullscreen.
// - Classic video PiP: broad support incl. Android Chrome and iOS/desktop Safari — a single
//   <video> in an OS overlay that floats over other apps.

export const hasDocumentPip =
  typeof window !== 'undefined' && 'documentPictureInPicture' in window;

// Use Document PiP (a Chromium child WINDOW) only in a plain web browser. In the Electron shell
// `documentPictureInPicture.requestWindow()` does not actually open a window, so the desktop app
// uses the classic macOS video-PiP overlay (AVKit) composited from a canvas instead — that DOES
// work, follows all Spaces, and shows multiple feeds. (Its one limit: it can't sit over a native
// fullscreen Space, so tile fullscreen uses simple-fullscreen on the same Space — see main.ts.)
export function preferDocumentPip(): boolean {
  // Electron's Document PiP returns a window object but doesn't actually render it, so the desktop
  // shell opens its own popup window instead (see openNativePipWindow). Only the plain web browser
  // uses Document PiP (where it works).
  return hasDocumentPip && !isNativeShellWindow();
}

function isNativeShellWindow(): boolean {
  return typeof window !== 'undefined' && !!window.ghcNative?.live;
}

/**
 * Desktop shell: open OUR OWN always-on-top window for PiP.
 *
 * Why not the OS Picture-in-Picture overlay (what this used to do): that window belongs to
 * Chromium/AVKit and is pinned to the video's aspect ratio — it refuses any resize that would
 * change the shape (measured: asking a 9:16 overlay for 700×400 gave back 284×505, untouched).
 * So the tiles could never be re-arranged by dragging, and a canvas overlay can't hold a clickable
 * button either. A window we open ourselves resizes freely from every edge and hosts real DOM.
 *
 * `window.open` (not documentPictureInPicture) because the popup is same-origin WITH an opener, so
 * it shares the renderer's JS heap: the room's live MediaStreamTracks can be attached directly to
 * <video> elements inside it. The desktop main process turns this request into a frameless,
 * always-on-top, all-Spaces window (see attachPipWindowHandler in main.ts).
 *
 * Returns null in a plain browser, or if the popup was blocked.
 */
export function openNativePipWindow(): Window | null {
  if (!isNativeShellWindow()) return null;
  const win = window.open('', 'ghc-pip', 'width=480,height=300');
  if (!win) return null;
  win.document.title = 'GHC PiP';
  win.document.body.style.margin = '0';
  win.document.body.style.background = '#121212';
  win.document.body.style.overflow = 'hidden';
  copyStylesTo(win);
  return win;
}

/** True when this platform gets a PiP that is a real, freely-resizable window (desktop or web Chromium). */
export function hasWindowPip(): boolean {
  return hasDocumentPip || isNativeShellWindow();
}

export function hasVideoPip(): boolean {
  if (typeof document === 'undefined') return false;
  // `pictureInPictureEnabled` covers desktop. On Android Chrome it can report FALSE even though PiP
  // of a canvas.captureStream() video actually works (the composite path) — so also accept the
  // requestPictureInPicture method's presence. iOS Safari uses the presentation-mode API instead.
  // A false positive just no-ops (the enter call is wrapped in try/catch with an on-screen reason).
  const enabled = !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled;
  const hasMethod = typeof window !== 'undefined'
    && typeof (window.HTMLVideoElement?.prototype as { requestPictureInPicture?: unknown } | undefined)?.requestPictureInPicture === 'function';
  let iosPresentation = false;
  try {
    const probe = document.createElement('video') as HTMLVideoElement & { webkitSupportsPresentationMode?: (m: string) => boolean };
    iosPresentation = typeof probe.webkitSupportsPresentationMode === 'function'
      && probe.webkitSupportsPresentationMode('picture-in-picture');
  } catch { /* ignore */ }
  return enabled || hasMethod || iosPresentation;
}

/** Any OS-window promotion available at all. */
export function canOsWindow(): boolean {
  return hasDocumentPip || hasVideoPip();
}

/** Put one <video> into the classic OS Picture-in-Picture overlay. */
export async function enterVideoPip(video: HTMLVideoElement | null): Promise<void> {
  if (!video || !hasVideoPip()) return;
  try {
    const v = video as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }
    await v.requestPictureInPicture?.();
  } catch {
    /* user gesture / not ready — ignore */
  }
}

/** Clone the page's stylesheets into a Document-PiP window so Tailwind classes apply. */
export function copyStylesTo(target: Window): void {
  for (const ss of Array.from(document.styleSheets)) {
    try {
      const cssText = Array.from(ss.cssRules).map((r) => r.cssText).join('');
      const style = target.document.createElement('style');
      style.textContent = cssText;
      target.document.head.appendChild(style);
    } catch {
      // Cross-origin sheet — re-link it by href instead.
      const href = (ss as CSSStyleSheet).href;
      if (href) {
        const link = target.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        target.document.head.appendChild(link);
      }
    }
  }
}
