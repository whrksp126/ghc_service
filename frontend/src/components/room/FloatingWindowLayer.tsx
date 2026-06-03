import { useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useFloatingWindowStore } from '../../stores/floatingWindowStore';
import { FloatingWindow, type FloatingFeed } from './FloatingWindow';

interface FloatingWindowLayerProps {
  feeds: FloatingFeed[];
}

/**
 * Renders the in-app floating camera windows above everything (incl. the theater overlay).
 * When the windows are hosted in an OS Document-PiP window instead, this layer stays empty.
 */
export function FloatingWindowLayer({ feeds }: FloatingWindowLayerProps) {
  const windows = useFloatingWindowStore((s) => s.windows);
  const osWindow = useFloatingWindowStore((s) => s.osWindow);
  const close = useFloatingWindowStore((s) => s.close);

  // Drop windows whose feed has disappeared (camera left / stopped).
  useEffect(() => {
    const ids = new Set(feeds.map((f) => f.id));
    for (const id of Object.keys(windows)) {
      if (!ids.has(id)) close(id);
    }
  }, [feeds, windows, close]);

  if (osWindow) return null;

  return (
    <div className="fixed inset-0 z-[80] pointer-events-none">
      <AnimatePresence>
        {Object.values(windows).map((win) => {
          const feed = feeds.find((f) => f.id === win.id);
          if (!feed) return null;
          return <FloatingWindow key={win.id} win={win} feed={feed} />;
        })}
      </AnimatePresence>
    </div>
  );
}
