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

interface SpotlightLayoutProps {
  feeds: FeedItem[];
  spotlightId: string | null;
  onFeedClick?: (feedId: string) => void;
}

export function SpotlightLayout({ feeds, spotlightId, onFeedClick }: SpotlightLayoutProps) {
  const spotlight = feeds.find((f) => f.id === spotlightId) || feeds[0];
  const sidebar = feeds.filter((f) => f.id !== spotlight?.id);

  if (!spotlight) return null;

  return (
    <div className="flex flex-col sm:flex-row w-full h-full gap-2 p-2">
      {/* Main spotlight */}
      <div className="flex-1 min-h-0">
        <FeedCard
          track={spotlight.track}
          label={spotlight.label}
          deviceLabel={spotlight.deviceLabel}
          isMuted={spotlight.isMuted}
          isLocal={spotlight.isLocal}
          isScreen={spotlight.isScreen}
          consumerId={spotlight.isLocal ? undefined : spotlight.id}
          layoutId={spotlight.id}
          priority
          voiceKey={spotlight.voiceKey}
          className="w-full h-full"
        />
      </div>

      {/* Sidebar */}
      {sidebar.length > 0 && (
        <div className="flex sm:flex-col gap-2 sm:w-48 overflow-auto shrink-0">
          <AnimatePresence mode="popLayout">
            {sidebar.map((feed) => (
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
                className="w-32 h-24 sm:w-full sm:h-32 shrink-0"
                onClick={() => onFeedClick?.(feed.id)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
