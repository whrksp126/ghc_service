import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { RemoteTrack } from 'livekit-client';
import { FeedCard } from './FeedCard';
import { useFloatingWindowStore } from '../../stores/floatingWindowStore';

export interface PipFeed {
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

interface DocumentPipPortalProps {
  feeds: PipFeed[];
}

/**
 * Desktop Chromium path for the PiP / multi-window button: popped cameras render into a single
 * always-on-top Document Picture-in-Picture OS window (grid). The window floats over other apps
 * and native fullscreen — the KakaoTalk/Discord-style behavior. The window itself is created in
 * the store's toggle() (within the click gesture); this component just portals content into it.
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

  if (!pipWindow) return null;

  const openFeeds = Object.keys(popped)
    .map((id) => feeds.find((f) => f.id === id))
    .filter((f): f is PipFeed => !!f);
  if (openFeeds.length === 0) return null;

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
            noMirror
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
    pipWindow.document.body
  );
}
