// Capability detection for promoting in-app floating windows to real OS windows.
// - Document PiP: Chromium desktop only — an always-on-top OS window that can host arbitrary
//   DOM (multiple camera tiles + controls). Floats over other apps / fullscreen.
// - Classic video PiP: broad support incl. Android Chrome and iOS/desktop Safari — a single
//   <video> in an OS overlay that floats over other apps.

export const hasDocumentPip =
  typeof window !== 'undefined' && 'documentPictureInPicture' in window;

export function hasVideoPip(): boolean {
  return typeof document !== 'undefined' && !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled;
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
