import { AnimatePresence } from 'framer-motion';
import type { ReactNode } from 'react';
import type { RemoteTrack } from 'livekit-client';
import { FeedCard } from './FeedCard';
import { useFloatingWindowStore } from '../../stores/floatingWindowStore';

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
  belowControls?: ReactNode;
  mirror?: boolean;
}

interface SpotlightLayoutProps {
  feeds: FeedItem[];
  spotlightId: string | null;
  onFeedClick?: (feedId: string) => void;
  /** Double-clicking the big spotlight tile goes back to grid. */
  onExit?: () => void;
  onPip?: (feedId: string) => void;
}

export function SpotlightLayout({ feeds, spotlightId, onFeedClick, onExit, onPip }: SpotlightLayoutProps) {
  const popped = useFloatingWindowStore((s) => s.popped);
  const spotlight = feeds.find((f) => f.id === spotlightId) || feeds[0];
  const sidebar = feeds.filter((f) => f.id !== spotlight?.id);

  if (!spotlight) return null;

  return (
    <div className="flex flex-col sm:flex-row w-full h-full gap-2 p-2">
      {/* Main spotlight */}
      <div className="flex-1 min-h-0">
        <FeedCard
          track={spotlight.track}
          lkTrack={spotlight.lkTrack}
          label={spotlight.label}
          isMuted={spotlight.isMuted}
          isLocal={spotlight.isLocal}
          isScreen={spotlight.isScreen}
          layoutId={spotlight.id}
          voiceKey={spotlight.voiceKey}
          controls={spotlight.controls}
          belowControls={spotlight.belowControls}
          mirror={spotlight.mirror}
          onDoubleClick={onExit}
          onPip={onPip ? () => onPip(spotlight.id) : undefined}
          isPoppedOut={!!popped[spotlight.id]}
          fitContain
          className="w-full h-full"
        />
      </div>

      {/* Sidebar (padding so the inset glow + tiles aren't crowded) */}
      {sidebar.length > 0 && (
        <div className="flex sm:flex-col gap-2 sm:w-48 overflow-auto shrink-0 p-0.5">
          <AnimatePresence mode="popLayout">
            {sidebar.map((feed) => (
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
                belowControls={feed.belowControls}
                mirror={feed.mirror}
                onDoubleClick={() => onFeedClick?.(feed.id)}
                onPip={onPip ? () => onPip(feed.id) : undefined}
                isPoppedOut={!!popped[feed.id]}
                className="w-32 h-24 sm:w-full sm:h-32 shrink-0"
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
