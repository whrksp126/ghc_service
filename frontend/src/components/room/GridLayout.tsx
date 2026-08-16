import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import type { RemoteTrack } from 'livekit-client';
import { FeedCard } from './FeedCard';
import { useFloatingWindowStore } from '../../stores/floatingWindowStore';

interface FeedItem {
  id: string;
  track: MediaStreamTrack | null;
  lkTrack?: RemoteTrack;
  audioTrack?: MediaStreamTrack;
  audioKey?: string;
  hlsUrl?: string;
  label: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  voiceKey?: string;
  controls?: ReactNode;
  belowControls?: ReactNode;
  mirror?: boolean;
}

interface GridLayoutProps {
  feeds: FeedItem[];
  onFeedClick?: (feedId: string) => void;
  onPip?: (feedId: string) => void | Promise<boolean | void>;
}

/**
 * Pick the column count that makes the tiles as large as possible for the CURRENT container shape.
 * On a tall/narrow viewport 2 landscape tiles stack top-to-bottom (1 col); on a wide one they sit
 * side-by-side (2 cols) — and likewise for any feed count. Ties favour more columns (fills width).
 */
function bestColumns(n: number, W: number, H: number, aspect = 16 / 9): number {
  if (n <= 1) return 1;
  let best = 1;
  let bestArea = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = W / cols;
    const cellH = H / rows;
    const w = Math.min(cellW, cellH * aspect); // largest 16:9 box that fits the cell
    const area = w * (w / aspect);
    if (area >= bestArea) {
      bestArea = area;
      best = cols;
    }
  }
  return best;
}

export function GridLayout({ feeds, onFeedClick, onPip }: GridLayoutProps) {
  const popped = useFloatingWindowStore((s) => s.popped);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Re-pick the layout whenever the container resizes (rotation, window resize, sidebar toggle).
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = useMemo(
    () => bestColumns(feeds.length, size.w || 1, size.h || 1),
    [feeds.length, size.w, size.h],
  );
  const rows = Math.max(1, Math.ceil(feeds.length / cols));

  return (
    <div
      ref={containerRef}
      className="grid gap-2 w-full h-full p-2"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      <AnimatePresence mode="popLayout">
        {feeds.map((feed) => (
          <FeedCard
            key={feed.id}
            track={feed.track}
            lkTrack={feed.lkTrack}
            audioTrack={feed.audioTrack}
            audioKey={feed.audioKey}
            hlsUrl={feed.hlsUrl}
            label={feed.label}
            isMuted={feed.isMuted}
            isLocal={feed.isLocal}
            isScreen={feed.isScreen}
            layoutId={feed.id}
            voiceKey={feed.voiceKey}
            controls={feed.controls}
            belowControls={feed.belowControls}
            mirror={feed.mirror}
            onDoubleClick={onFeedClick}
            onPip={onPip}
            isPoppedOut={!!popped[feed.id]}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
