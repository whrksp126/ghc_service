import { useEffect, useRef, useState, RefObject } from 'react';
import { getSocket } from '../lib/socket';

/**
 * adaptiveStream port (LiveKit-style):
 * Observes how large / visible a remote feed is rendered and tells the SFU which
 * simulcast spatial layer to forward. Backend already exposes media:setPreferredLayers
 * and media:pause/resumeConsumer — this hook just drives them from the DOM.
 *
 * Quality mapping by rendered width:
 *   not visible -> paused (no downlink at all)
 *   < 200px     -> spatial 0 (thumbnail)
 *   < 480px     -> spatial 1 (medium)
 *   >= 480px    -> spatial 2 (HD / focused)
 */

export type FeedQuality = 'paused' | 'low' | 'mid' | 'high';

// Two simulcast layers now (0 = thumbnail, 1 = HD): a tiny tile pulls the thumbnail,
// anything larger pulls the full-res HD layer.
const SPATIAL: Record<Exclude<FeedQuality, 'paused'>, number> = { low: 0, mid: 1, high: 1 };
const APPLY_DEBOUNCE = 300;
// When a feed unmounts (e.g. carousel paging, layout switch) we pause it shortly
// after — but a remount within this window cancels the pause to avoid black flicker.
const UNMOUNT_PAUSE_DELAY = 600;

const pendingUnmountPause = new Map<string, ReturnType<typeof setTimeout>>();

function emitLayer(consumerId: string, quality: FeedQuality, prev: FeedQuality | null) {
  const socket = getSocket();
  if (!socket.connected) return;
  if (quality === 'paused') {
    socket.emit('media:pauseConsumer', { consumerId });
    return;
  }
  if (prev === 'paused' || prev === null) {
    socket.emit('media:resumeConsumer', { consumerId });
  }
  socket.emit('media:setPreferredLayers', { consumerId, spatialLayer: SPATIAL[quality] });
}

export function useAdaptiveQuality(
  consumerId: string | undefined,
  elementRef: RefObject<HTMLElement>,
  enabled: boolean,
  /** Focused/spotlight feed — always pull the top spatial layer while visible. */
  priority = false
): FeedQuality {
  const [quality, setQuality] = useState<FeedQuality>('high');
  const lastRef = useRef<FeedQuality | null>(null);

  useEffect(() => {
    const el = elementRef.current;
    if (!consumerId || !enabled || !el) return;

    // Cancel any pending pause from a previous unmount of this same consumer.
    const pending = pendingUnmountPause.get(consumerId);
    if (pending) {
      clearTimeout(pending);
      pendingUnmountPause.delete(consumerId);
    }

    let visible = true;
    let width = el.getBoundingClientRect().width;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const apply = () => {
      const next: FeedQuality = !visible
        ? 'paused'
        : priority
          ? 'high'
          : width < 200
            ? 'low'
            : width < 480
              ? 'mid'
              : 'high';
      if (next === lastRef.current) return;
      emitLayer(consumerId, next, lastRef.current);
      lastRef.current = next;
      setQuality(next);
    };

    const schedule = () => {
      clearTimeout(debounce);
      debounce = setTimeout(apply, APPLY_DEBOUNCE);
    };

    const ro = new ResizeObserver((entries) => {
      width = entries[0].contentRect.width;
      schedule();
    });
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        visible = e.isIntersecting && e.intersectionRatio > 0.1;
        schedule();
      },
      { threshold: [0, 0.1, 0.5] }
    );

    ro.observe(el);
    io.observe(el);
    schedule();

    return () => {
      clearTimeout(debounce);
      ro.disconnect();
      io.disconnect();
      const wasActive = lastRef.current && lastRef.current !== 'paused';
      lastRef.current = null;
      // If this feed disappeared while active, pause it after a grace period so a
      // remount (layout change) can cancel and avoid a flicker.
      if (wasActive) {
        const t = setTimeout(() => {
          getSocket().emit('media:pauseConsumer', { consumerId });
          pendingUnmountPause.delete(consumerId);
        }, UNMOUNT_PAUSE_DELAY);
        pendingUnmountPause.set(consumerId, t);
      }
    };
  }, [consumerId, enabled, elementRef, priority]);

  return quality;
}
