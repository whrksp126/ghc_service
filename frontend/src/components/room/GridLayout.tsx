import { useMemo, type ReactNode } from 'react';
import { AnimatePresence } from 'framer-motion';
import type { RemoteTrack } from 'livekit-client';
import { FeedCard } from './FeedCard';

interface FeedItem {
  id: string;
  track: MediaStreamTrack | null;
  lkTrack?: RemoteTrack;
  label: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  voiceKey?: string;
  controls?: ReactNode;
}

interface GridLayoutProps {
  feeds: FeedItem[];
  onFeedClick?: (feedId: string) => void;
}

export function GridLayout({ feeds, onFeedClick }: GridLayoutProps) {
  const gridClass = useMemo(() => {
    const count = feeds.length;
    if (count === 0) return '';
    if (count === 1) return 'grid-cols-1 grid-rows-1';
    if (count === 2) return 'grid-cols-1 grid-rows-2 sm:grid-cols-2 sm:grid-rows-1';
    if (count <= 4) return 'grid-cols-2 grid-rows-2';
    if (count <= 6) return 'grid-cols-3 grid-rows-2';
    if (count <= 9) return 'grid-cols-3 grid-rows-3';
    return 'grid-cols-4 grid-rows-4';
  }, [feeds.length]);

  return (
    <div className={`grid gap-2 w-full h-full p-2 ${gridClass}`}>
      <AnimatePresence mode="popLayout">
        {feeds.map((feed) => (
          <FeedCard
            key={feed.id}
            track={feed.track}
            lkTrack={feed.lkTrack}
            label={feed.label}
            isMuted={feed.isMuted}
            isLocal={feed.isLocal}
            isScreen={feed.isScreen}
            layoutId={feed.id}
            voiceKey={feed.voiceKey}
            controls={feed.controls}
            onDoubleClick={() => onFeedClick?.(feed.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
