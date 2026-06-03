import { useRef, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { motion } from 'framer-motion';
import type { RemoteTrack } from 'livekit-client';
import { X, GripVertical, MonitorUp } from 'lucide-react';
import { FeedCard } from './FeedCard';
import { useFloatingWindowStore, FLOATING_MIN, type FloatingWindow as Win } from '../../stores/floatingWindowStore';
import { hasDocumentPip, hasVideoPip, enterVideoPip } from '../../lib/pipSupport';

export interface FloatingFeed {
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

interface FloatingWindowProps {
  win: Win;
  feed: FloatingFeed;
}

/**
 * An in-app floating, draggable + resizable camera window. Works on PC and mobile via Pointer
 * Events (mouse + touch). Header bar drags; bottom-right handle resizes (clamped to min/max).
 * The FeedCard inside keeps its own single-click controls (settings / fullscreen) — the window
 * chrome adds the close (X) that returns the feed to its grid tile.
 */
export function FloatingWindow({ win, feed }: FloatingWindowProps) {
  const move = useFloatingWindowStore((s) => s.move);
  const resize = useFloatingWindowStore((s) => s.resize);
  const focus = useFloatingWindowStore((s) => s.focus);
  const close = useFloatingWindowStore((s) => s.close);
  const setOsWindow = useFloatingWindowStore((s) => s.setOsWindow);

  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const rez = useRef<{ px: number; py: number; ow: number; oh: number } | null>(null);

  const osSupported = hasDocumentPip || hasVideoPip();
  const promoteToOs = () => {
    if (hasDocumentPip) {
      // Desktop Chromium: gather all floating windows into one always-on-top OS window.
      setOsWindow(true);
    } else {
      // Mobile / Safari: this single camera's <video> into the classic OS PiP overlay.
      enterVideoPip(rootRef.current?.querySelector('video') ?? null);
    }
  };

  const onHeaderDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    focus(win.id);
    drag.current = { px: e.clientX, py: e.clientY, ox: win.x, oy: win.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeaderMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const d = drag.current;
    const maxX = window.innerWidth - win.w;
    const maxY = window.innerHeight - win.h;
    const x = Math.max(0, Math.min(maxX, d.ox + (e.clientX - d.px)));
    const y = Math.max(0, Math.min(maxY, d.oy + (e.clientY - d.py)));
    move(win.id, x, y);
  };
  const endHeader = (e: ReactPointerEvent) => {
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onResizeDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    focus(win.id);
    rez.current = { px: e.clientX, py: e.clientY, ow: win.w, oh: win.h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: ReactPointerEvent) => {
    if (!rez.current) return;
    const r = rez.current;
    resize(win.id, r.ow + (e.clientX - r.px), r.oh + (e.clientY - r.py));
  };
  const endResize = (e: ReactPointerEvent) => {
    e.stopPropagation();
    rez.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  return (
    <motion.div
      ref={rootRef}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 360, damping: 30 }}
      className="absolute pointer-events-auto rounded-xl overflow-hidden shadow-2xl border border-white/10 bg-dark-900 flex flex-col"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z, minWidth: FLOATING_MIN.w, minHeight: FLOATING_MIN.h }}
      onPointerDown={() => focus(win.id)}
    >
      {/* Header / drag handle */}
      <div
        className="flex items-center gap-1.5 px-2 h-8 shrink-0 bg-dark-800/90 cursor-move select-none touch-none"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={endHeader}
        onPointerCancel={endHeader}
      >
        <GripVertical size={14} className="text-white/30 shrink-0" />
        <span className="text-xs font-medium text-white/80 truncate flex-1">{feed.label}</span>
        {osSupported && (
          <button
            onClick={promoteToOs}
            className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/15 transition-colors"
            title="OS 창으로 (다른 앱 위에 표시)"
          >
            <MonitorUp size={13} />
          </button>
        )}
        <button
          onClick={() => close(win.id)}
          className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/15 transition-colors"
          title="닫기"
        >
          <X size={14} />
        </button>
      </div>

      {/* Camera */}
      <div className="relative flex-1 min-h-0">
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
      </div>

      {/* Resize handle (bottom-right) */}
      <div
        className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize touch-none z-40"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        style={{ background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.35) 50%)' }}
      />
    </motion.div>
  );
}
