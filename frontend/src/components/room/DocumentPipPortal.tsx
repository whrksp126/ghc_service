import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { RemoteTrack } from 'livekit-client';
import { FeedCard } from './FeedCard';
import { useFloatingWindowStore } from '../../stores/floatingWindowStore';
import { isNativeShell } from '../../lib/native';

/**
 * Columns for the PiP grid — whatever makes the tiles biggest for the window's CURRENT shape, the
 * same rule the in-room grid uses. Drag the window wide and the feeds line up side by side; drag it
 * tall and they stack. There is deliberately no manual override: the automatic choice is always the
 * one that wastes the least space, so a mode button was just clutter in a window this small.
 */
function layoutColumns(n: number, w: number, h: number, aspect = 16 / 9): number {
  if (n <= 1) return 1;
  let best = 1;
  let bestArea = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = Math.min(w / cols, (h / rows) * aspect);
    const area = tileW * (tileW / aspect);
    if (area > bestArea) {
      bestArea = area;
      best = cols;
    }
  }
  return best;
}

export interface PipFeed {
  id: string;
  track: MediaStreamTrack | null;
  lkTrack?: RemoteTrack;
  hlsUrl?: string;
  label: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  voiceKey?: string;
  controls?: ReactNode;
  mirror?: boolean;
}

interface DocumentPipPortalProps {
  feeds: PipFeed[];
}

/**
 * Popped cameras render into a single always-on-top window: Document PiP in a plain browser, and
 * on the desktop shell our own frameless window (which, unlike the OS PiP overlay, resizes freely
 * from every edge — see openNativePipWindow). Either way this component just portals the tiles in;
 * the window itself is created by the store's toggle() inside the click gesture.
 *
 * Chrome is hover-only: nothing is drawn over the video until the pointer is in the window, so at
 * rest the PiP is just the feeds.
 */
export function DocumentPipPortal({ feeds }: DocumentPipPortalProps) {
  const popped = useFloatingWindowStore((s) => s.popped);
  const pipWindow = useFloatingWindowStore((s) => s.pipWindow);
  const close = useFloatingWindowStore((s) => s.close);

  // Drop popped feeds whose source has disappeared (camera left / stopped).
  useEffect(() => {
    const ids = new Set(feeds.map((f) => f.id));
    for (const id of Object.keys(popped)) {
      if (!ids.has(id)) close(id);
    }
  }, [feeds, popped, close]);

  // The window's live inner size — what makes the tiles re-flow while it's being dragged.
  const [size, setSize] = useState({ w: 480, h: 300 });
  useEffect(() => {
    if (!pipWindow) return;
    const read = () => setSize({ w: pipWindow.innerWidth, h: pipWindow.innerHeight });
    read();
    pipWindow.addEventListener('resize', read);
    return () => pipWindow.removeEventListener('resize', read);
  }, [pipWindow]);

  if (!pipWindow) return null;

  const openFeeds = Object.keys(popped)
    .map((id) => feeds.find((f) => f.id === id))
    .filter((f): f is PipFeed => !!f);
  if (openFeeds.length === 0) return null;

  const nativeShell = isNativeShell();
  const cols = layoutColumns(openFeeds.length, size.w, size.h);
  const rows = Math.max(1, Math.ceil(openFeeds.length / cols));

  return createPortal(
    <div
      className="group/pip w-screen h-screen bg-dark-900 grid gap-1 p-1"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {nativeShell && (
        /* Frameless window → it needs somewhere to be grabbed. This strip is invisible and sits
           over the top edge of the grid; a faint grip fades in with the rest of the chrome so the
           handle is discoverable without ever drawing a header over the video. The top 4px stays
           outside the drag region, otherwise it swallows the window's own resize edge. */
        <div
          className="fixed left-0 right-0 z-30 flex items-start justify-center pt-1
                     opacity-0 group-hover/pip:opacity-100 transition-opacity duration-150"
          style={{ top: 4, height: 18, WebkitAppRegion: 'drag' } as CSSProperties}
        >
          <div className="w-8 h-1 rounded-full bg-white/35" />
        </div>
      )}

      {openFeeds.map((feed) => (
        <div key={feed.id} className="group/tile relative min-h-0 min-w-0">
          <FeedCard
            track={feed.track}
            lkTrack={feed.lkTrack}
            hlsUrl={feed.hlsUrl}
            label={feed.label}
            isMuted={feed.isMuted}
            isLocal={feed.isLocal}
            isScreen={feed.isScreen}
            voiceKey={feed.voiceKey}
            controls={feed.controls}
            mirror={feed.mirror}
            fitContain
            className="w-full h-full"
          />
          <button
            onClick={() => close(feed.id)}
            className="absolute top-1.5 right-1.5 z-30 w-7 h-7 rounded-full flex items-center justify-center
                       bg-black/50 text-white hover:bg-black/70
                       opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100
                       transition-opacity duration-150"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            title="닫기"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    pipWindow.document.body
  );
}
