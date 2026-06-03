import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { FeedCard } from './FeedCard';
import type { FloatingFeed } from './FloatingWindow';
import { useFloatingWindowStore } from '../../stores/floatingWindowStore';
import { hasDocumentPip, copyStylesTo } from '../../lib/pipSupport';

interface DocumentPipPortalProps {
  feeds: FloatingFeed[];
}

interface DocPipWindow extends Window {
  close: () => void;
}

/**
 * Desktop Chromium path: when the user promotes the floating windows to an OS window, open one
 * always-on-top Document Picture-in-Picture window and render all popped-out cameras inside it
 * as a grid (Document PiP allows only one such window at a time). The window floats over other
 * apps and over native fullscreen — the KakaoTalk/Discord-style behavior. Closing it (or the
 * OS window's own close button) returns the cameras to the in-app layer.
 */
export function DocumentPipPortal({ feeds }: DocumentPipPortalProps) {
  const osWindow = useFloatingWindowStore((s) => s.osWindow);
  const windows = useFloatingWindowStore((s) => s.windows);
  const setOsWindow = useFloatingWindowStore((s) => s.setOsWindow);
  const close = useFloatingWindowStore((s) => s.close);
  const [pipWin, setPipWin] = useState<DocPipWindow | null>(null);

  // Open the OS window when promotion turns on.
  useEffect(() => {
    if (!osWindow || pipWin) return;
    if (!hasDocumentPip) { setOsWindow(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const dpip = (window as unknown as { documentPictureInPicture: { requestWindow: (o: { width: number; height: number }) => Promise<DocPipWindow> } }).documentPictureInPicture;
        const w = await dpip.requestWindow({ width: 420, height: 320 });
        if (cancelled) { w.close(); return; }
        copyStylesTo(w);
        w.document.body.style.margin = '0';
        w.document.body.style.background = '#121212';
        w.addEventListener('pagehide', () => setOsWindow(false));
        setPipWin(w);
      } catch {
        setOsWindow(false);
      }
    })();
    return () => { cancelled = true; };
  }, [osWindow, pipWin, setOsWindow]);

  // Close the OS window when promotion turns off (or component unmounts).
  useEffect(() => {
    if ((!osWindow || Object.keys(windows).length === 0) && pipWin) {
      try { pipWin.close(); } catch { /* already gone */ }
      setPipWin(null);
      if (osWindow && Object.keys(windows).length === 0) setOsWindow(false);
    }
  }, [osWindow, windows, pipWin, setOsWindow]);

  useEffect(() => () => { try { pipWin?.close(); } catch { /* ignore */ } }, [pipWin]);

  if (!pipWin || !osWindow) return null;

  const openFeeds = Object.keys(windows)
    .map((id) => feeds.find((f) => f.id === id))
    .filter((f): f is FloatingFeed => !!f);

  const cols = openFeeds.length <= 1 ? 1 : 2;

  return createPortal(
    <div
      className="w-screen h-screen bg-dark-900 grid gap-1 p-1"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {openFeeds.map((feed) => (
        <div key={feed.id} className="relative min-h-0 min-w-0">
          <FeedCard
            track={feed.track}
            lkTrack={feed.lkTrack}
            label={feed.label}
            isMuted={feed.isMuted}
            isLocal={feed.isLocal}
            isScreen={feed.isScreen}
            voiceKey={feed.voiceKey}
            controls={feed.controls}
            fitContain
            className="w-full h-full"
          />
          <button
            onClick={() => close(feed.id)}
            className="absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-full flex items-center justify-center bg-black/50 text-white hover:bg-black/70 transition-colors"
            title="닫기"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    pipWin.document.body
  );
}
