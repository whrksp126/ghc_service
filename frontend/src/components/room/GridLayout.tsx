import { useMemo } from 'react';
import { AnimatePresence } from 'framer-motion';
import { FeedCard } from './FeedCard';

interface FeedItem {
  id: string;
  track: MediaStreamTrack | null;
  label: string;
  deviceLabel: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  voiceKey?: string;
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
    if (count === 2) return 'grid-cols-2 grid-rows-1';
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
            label={feed.label}
            deviceLabel={feed.deviceLabel}
            isMuted={feed.isMuted}
            isLocal={feed.isLocal}
            isScreen={feed.isScreen}
            consumerId={feed.isLocal ? undefined : feed.id}
            layoutId={feed.id}
            voiceKey={feed.voiceKey}
            onClick={() => onFeedClick?.(feed.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
