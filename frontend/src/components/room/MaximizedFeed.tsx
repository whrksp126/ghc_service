import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Minimize2 } from 'lucide-react';
import { FeedCard } from './FeedCard';
import type { FloatingFeed } from './FloatingWindow';

interface MaximizedFeedProps {
  feed: FloatingFeed | undefined;
  onClose: () => void;
}

/**
 * Full-viewport "theater" view of one feed, drawn as a normal DOM overlay (z-70) instead of
 * native fullscreen — so floating camera windows (z-80) stay visible on top of it. This is what
 * makes "watch the live big + see faces floating" work the same on PC and mobile.
 */
export function MaximizedFeed({ feed, onClose }: MaximizedFeedProps) {
  // If the maximized feed disappears (camera left), drop back automatically.
  useEffect(() => {
    if (!feed) onClose();
  }, [feed, onClose]);

  if (!feed) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] bg-black"
    >
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
        className="w-full h-full !rounded-none"
      />
      <button
        onClick={onClose}
        className="absolute top-3 right-3 z-10 w-11 h-11 rounded-full flex items-center justify-center bg-black/50 backdrop-blur-sm text-white hover:bg-black/70 transition-colors"
        title="크게 보기 종료"
      >
        <Minimize2 size={20} />
      </button>
    </motion.div>
  );
}
