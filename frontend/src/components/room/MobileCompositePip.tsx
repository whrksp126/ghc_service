import { useEffect } from 'react';
import { preferDocumentPip } from '../../lib/pipSupport';
import { compositePip } from '../../lib/compositePip';
import { useFloatingWindowStore } from '../../stores/floatingWindowStore';
import type { PipFeed } from './DocumentPipPortal';

/**
 * Mobile / Safari counterpart of DocumentPipPortal. The actual add/enter happens in FeedCard's
 * click handler (requestPictureInPicture needs a user gesture); this component only RECONCILES the
 * running composite with live room state — refreshing a feed's track after a camera switch and
 * dropping feeds whose source left — and restores the in-grid tiles when the user closes the OS PiP.
 * No-op on desktop (Document PiP handles multi-tile there).
 */
export function MobileCompositePip({ feeds }: { feeds: PipFeed[] }) {
  const popped = useFloatingWindowStore((s) => s.popped);
  const close = useFloatingWindowStore((s) => s.close);
  const closeAll = useFloatingWindowStore((s) => s.closeAll);

  useEffect(() => {
    compositePip.setOnExit(() => closeAll());
    return () => compositePip.stop(); // leaving the room → don't leave a frozen PiP behind
  }, [closeAll]);

  useEffect(() => {
    if (preferDocumentPip()) return; // browser uses Document PiP; native shell uses the composite
    const byId = new Map(feeds.map((f) => [f.id, f]));
    for (const id of Object.keys(popped)) {
      const f = byId.get(id);
      if (!f || !f.track) {
        if (compositePip.has(id)) compositePip.remove(id);
        close(id); // source gone → drop the placeholder too
      } else if (compositePip.has(id)) {
        compositePip.add(id, f.track, f.label, !!f.mirror, f.lkTrack, f.voiceKey, f.audioTrack); // refresh A/V tracks / label / voice key
      }
    }
  }, [feeds, popped, close]);

  return null;
}
