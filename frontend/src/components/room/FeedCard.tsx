import { useRef, useEffect, useState, useId, memo, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { MicOff, Monitor, Maximize2, Minimize2, PictureInPicture2, RotateCcw } from 'lucide-react';
import { hasDocumentPip, hasVideoPip, enterVideoPip } from '../../lib/pipSupport';
import { isNativeShell } from '../../lib/native';
import { compositePip } from '../../lib/compositePip';
import type { RemoteTrack } from 'livekit-client';
import { useVoiceStore } from '../../services/voiceActivity';
import { useAudioSettings } from '../../stores/audioSettings';
import { VoiceBars } from '../common/VoiceBars';
import { showToast } from '../common/Toast';
import { BottomSheet } from '../common/BottomSheet';
import { useActiveTile } from '../../stores/activeTileStore';

interface FeedCardProps {
  track: MediaStreamTrack | null;
  /** LiveKit remote track — attaching via this lets adaptiveStream size the layer. */
  lkTrack?: RemoteTrack;
  label: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  /** Stable feed id — drives shared-element layout morph across layout modes. */
  layoutId?: string;
  /** Participant key (`${userId}:${deviceId}`) for voice-activity glow + waveform. */
  voiceKey?: string;
  /** Controls overlay (mic/cam/switch…) shown on a single click — laid out in one button row. */
  controls?: ReactNode;
  /** Extra controls placed on their own row below the button row (e.g. the lens switcher). */
  belowControls?: ReactNode;
  /** Double click → focus this feed as the spotlight. */
  onDoubleClick?: () => void;
  /** Show the whole frame (object-contain) instead of cropping — spotlight main / screens. */
  fitContain?: boolean;
  className?: string;
  /** Desktop Document-PiP toggle (called within the click gesture). Mobile uses video PiP directly. */
  onPip?: () => void;
  /** This feed is currently shown in the desktop PiP window — render a placeholder, keep the slot. */
  isPoppedOut?: boolean;
  /** Stable feed id used to add/remove this feed from the mobile composite PiP. */
  pipId?: string;
  /** Mirror the video horizontally — set ONLY for front (selfie) cameras so the subject sees a
   *  natural mirror; back cameras stay un-mirrored so real-world text reads correctly. Applied
   *  identically in-grid, in PiP and (via the composite) for viewers, so everyone sees the same. */
  mirror?: boolean;
}

export const FeedCard = memo(function FeedCard({
  track,
  lkTrack,
  label,
  isMuted,
  isLocal,
  isScreen,
  layoutId,
  voiceKey,
  controls,
  onDoubleClick,
  className = '',
  belowControls,
  onPip,
  isPoppedOut,
  pipId,
  mirror,
}: FeedCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ambientRef = useRef<HTMLCanvasElement>(null);
  // Only one tile shows its controls at a time (shared store) — opening another, or clicking
  // outside, closes this one. `ctrlId` is this tile's stable identity in that store.
  const reactId = useId();
  const ctrlId = pipId ?? layoutId ?? reactId;
  const activeId = useActiveTile((s) => s.activeId);
  const setActive = useActiveTile((s) => s.setActive);
  const isActive = activeId === ctrlId;
  // Small tiles can't fit the centered control overlay, so they open a bottom sheet instead.
  const [isSmall, setIsSmall] = useState(false);
  const showControls = isActive && !isSmall;
  const sheetOpen = isActive && isSmall;
  // Two fullscreen mechanisms: real HTML5 fullscreen (web/mobile) vs an in-window CSS expand
  // (desktop Electron shell). On desktop, HTML5 fullscreen triggers setSimpleFullScreen which
  // raises the window above the classic macOS PiP overlay → PiP gets hidden. The CSS expand keeps
  // the window at its normal level so the PiP floats on top of the fullscreened tile.
  const [htmlFullscreen, setHtmlFullscreen] = useState(false);
  const [cssFullscreen, setCssFullscreen] = useState(false);
  const isFullscreen = htmlFullscreen || cssFullscreen;
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const level = useVoiceStore((s) => (voiceKey ? s.levels[voiceKey] ?? 0 : 0));
  const threshold = useAudioSettings((s) => s.threshold);
  const speaking = level > threshold;

  // Remote video → attach through LiveKit so adaptiveStream observes this element's size
  // and visibility and requests the matching simulcast layer. Local/screen → plain sink.
  // `isPoppedOut` is a dep so that returning from Document-PiP (true→false) re-runs the
  // effect and re-binds the track to the freshly remounted <video> — otherwise the restored
  // tile stays black until the track/source identity happens to change.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    if (lkTrack && !isLocal) {
      lkTrack.attach(el);
      return () => { lkTrack.detach(el); };
    }
    el.srcObject = new MediaStream([track]);
    return () => { el.srcObject = null; };
  }, [track, lkTrack, isLocal, isPoppedOut]);

  // Ambient glow (à la NikxDa/ambient): a low-res copy of the frame sits in a layer that EXACTLY
  // overlays the video's letterboxed box (same aspect + object-contain), and a heavy blur lets its
  // edge colours bleed a little past the video border — a soft halo hugging the edges, not a full
  // background fill. The canvas keeps its aspect matched to the live frame so the overlay stays
  // aligned for portrait/landscape/rotated feeds. Mounted persistently so it never flickers off.
  const ambientOn = !isPoppedOut;
  useEffect(() => {
    if (!ambientOn) return;
    const canvas = ambientRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;
      const w = 64;
      const h = Math.max(1, Math.round((w * video.videoHeight) / video.videoWidth));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      try {
        ctx.drawImage(video, 0, 0, w, h);
      } catch {
        /* not yet decodable */
      }
    }, 125);
    return () => clearInterval(id);
  }, [ambientOn]);

  // Track the rendered tile size: small tiles route controls to a bottom sheet (the centered
  // overlay would clip on a phone grid), big tiles keep the in-place overlay (Discord-style).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setIsSmall(r.height < 200 || r.width < 260);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Distinguish single (reveal controls) from double (focus) click. Small tiles open the
  // bottom sheet; bigger tiles toggle the in-place overlay (always carries fullscreen).
  const handleClick = () => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      setActive(null);
      onDoubleClick?.();
      return;
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      setActive(isActive ? null : ctrlId); // open this tile's controls (closes any other)
    }, 230);
  };

  // YouTube-style fullscreen: request fullscreen on the tile container element so that the
  // video + overlays remain visible on all platforms including the Electron desktop shell.
  // iOS Safari can't fullscreen a <div>, so we fall back to the <video> element's native
  // fullscreen player. The container ref (rootRef) is the motion.div wrapping the whole tile.
  const toggleFullscreen = () => {
    setActive(null);
    // Desktop Electron shell: expand WITHIN the window (CSS), not HTML5 fullscreen — see the
    // state comment above (keeps the window level normal so the macOS PiP overlay stays on top).
    if (isNativeShell()) {
      setCssFullscreen((v) => !v);
      return;
    }
    const root = rootRef.current as any;
    const video = videoRef.current as any;
    const doc = document as any;
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      (document.exitFullscreen || doc.webkitExitFullscreen)?.call(document);
      return;
    }
    if (root?.requestFullscreen) { root.requestFullscreen().catch(() => {}); return; }
    if (root?.webkitRequestFullscreen) { root.webkitRequestFullscreen(); return; }
    if (video?.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
    showToast('이 브라우저에서는 전체화면을 지원하지 않습니다', 'info');
  };

  useEffect(() => {
    const onChange = () => {
      const doc = document as any;
      const el = document.fullscreenElement || doc.webkitFullscreenElement;
      setHtmlFullscreen(el === rootRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // Desktop in-window fullscreen: ESC exits, mirroring native fullscreen's behaviour.
  useEffect(() => {
    if (!cssFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCssFullscreen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cssFullscreen]);

  // Auto-hide the controls overlay after a few idle seconds. Interacting with the overlay
  // (tap on a button or the backdrop) calls bumpControlsTimer to extend the window.
  const bumpControlsTimer = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setActive(null), 3000);
  };
  useEffect(() => {
    if (!showControls) {
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      return;
    }
    bumpControlsTimer();
    return () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };
  }, [showControls]);

  // Click/tap anywhere outside this tile (another tile, empty space, the bars) closes its controls.
  // Only the active tile mounts this, so there's a single listener. Deferred a tick so the opening
  // click doesn't immediately re-close it.
  useEffect(() => {
    if (!isActive) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && rootRef.current?.contains(t)) return; // inside the tile (video/buttons/backdrop)
      if (t && (t as HTMLElement).closest?.('[data-feed-sheet]')) return; // inside this tile's sheet
      setActive(null);
    };
    const tid = window.setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
    return () => { clearTimeout(tid); document.removeEventListener('pointerdown', onDown, true); };
  }, [isActive, setActive]);

  // PiP: native desktop shell uses the composite macOS video-PiP overlay (multiple feeds). The plain
  // web browser uses the CLASSIC single-video PiP of the real element — the path that worked before
  // the desktop build introduced Document PiP (which regressed web PiP). Reliable on Chrome/Android/Safari.
  const pipSupported = (hasDocumentPip || hasVideoPip()) && !!track;
  const handlePip = () => {
    setActive(null);
    const id = pipId ?? layoutId;
    // Native desktop shell: composite macOS PiP overlay (multiple feeds, cross-Space).
    if (isNativeShell()) {
      if (!id || !track) { enterVideoPip(videoRef.current); return; }
      if (compositePip.has(id)) {
        compositePip.remove(id);
        onPip?.(); // clears popped[id] → restores the in-grid tile
      } else {
        compositePip.add(id, track, label, !!mirror, lkTrack, voiceKey);
        void compositePip.enter().then((ok) => {
          if (ok) onPip?.();
          else { compositePip.remove(id); enterVideoPip(videoRef.current); }
        });
      }
      return;
    }
    // Web (desktop + mobile): classic single-video PiP of the real element. Surface errors + state
    // on screen so a failing case (esp. Android Chrome) reports exactly why.
    const v = videoRef.current as (HTMLVideoElement & {
      requestPictureInPicture?: () => Promise<unknown>;
      webkitSetPresentationMode?: (m: string) => void;
      disablePictureInPicture?: boolean;
    }) | null;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    const diag = `en=${(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled} rs=${v?.readyState} dis=${v?.disablePictureInPicture}`;
    const tryPiP = () => {
      if (v?.requestPictureInPicture) {
        v.requestPictureInPicture().catch((e: { name?: string; message?: string }) =>
          showToast(`PiP실패 ${e?.name || ''}:${e?.message || ''} [${diag}]`, 'info'));
      } else if (v?.webkitSetPresentationMode) {
        try { v.webkitSetPresentationMode('picture-in-picture'); } catch { showToast(`PiP실패(webkit) [${diag}]`, 'info'); }
      } else {
        showToast(`PiP 미지원 [${diag}]`, 'info');
      }
    };
    // Android Chrome rejects requestPictureInPicture with NotSupportedError ("Metadata ... not loaded
    // yet") if the video has no decoded frame. Ensure it's playing + has data, then try (still within
    // the gesture's transient-activation window).
    if (v && v.readyState < 2) {
      v.addEventListener('loadeddata', tryPiP, { once: true });
      void v.play?.().catch(() => {});
    } else {
      tryPiP();
    }
  };

  // Shared control buttons (parent mic/cam/switch + PiP + fullscreen), reused by the in-place
  // overlay and the small-tile bottom sheet.
  const controlButtons = (
    <>
      {controls}
      {!isPoppedOut && pipSupported && (
        <button
          onClick={handlePip}
          className="w-11 h-11 rounded-full flex items-center justify-center bg-white/15 text-white hover:bg-white/25 transition-colors"
          title="PiP (작은 창)"
        >
          <PictureInPicture2 size={18} />
        </button>
      )}
      <button
        onClick={toggleFullscreen}
        className="w-11 h-11 rounded-full flex items-center justify-center bg-white/15 text-white hover:bg-white/25 transition-colors"
        title="전체화면"
      >
        {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
      </button>
    </>
  );

  return (
    <>
    {/* No `layoutId`: a shared-element morph between the unmounting grid tile and the mounting
        spotlight tile was capturing/cross-fading the live <video>, leaving the focused camera black
        (and killing the ambient sample). A clean mount + simple fade is reliable. `layout` stays
        for smooth in-grid reflow when the responsive column count changes. */}
    <motion.div
      ref={rootRef}
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 350, damping: 32 }}
      className={`feed-card group cursor-pointer ${cssFullscreen ? 'fixed inset-0 z-[90] bg-black' : 'relative'} ${className}`}
      onClick={handleClick}
    >
      {ambientOn && (
        <canvas
          ref={ambientRef}
          aria-hidden
          className="absolute inset-0 w-full h-full object-contain pointer-events-none"
          style={{ zIndex: -1, filter: 'blur(45px) saturate(1.4)', opacity: 0.75 }}
        />
      )}
      {isPoppedOut ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-dark-800 text-white/40">
          <PictureInPicture2 size={28} strokeWidth={1.5} />
          <span className="text-xs">PiP 창에서 보는 중</span>
          {onPip && (
            <button
              onClick={(e) => { e.stopPropagation(); handlePip(); }}
              className="flex items-center gap-1.5 text-xs text-white/70 bg-white/10 hover:bg-white/20 rounded-full px-3 py-1.5 transition-colors"
            >
              <RotateCcw size={14} /> 되돌리기
            </button>
          )}
        </div>
      ) : track ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal || track.kind === 'video'}
          className={`w-full h-full object-contain ${mirror ? 'scale-x-[-1]' : ''}`}
          style={ambientOn ? { filter: 'drop-shadow(0 8px 30px rgba(0,0,0,0.5))' } : undefined}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-dark-800">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary/30 to-secondary/30 flex items-center justify-center text-2xl font-bold text-white/50">
            {label[0]?.toUpperCase()}
          </div>
        </div>
      )}

      {/* Speaking ring — drawn INSET on top of the video so it's never clipped by any
          scroll/grid container's overflow (the old outer box-shadow was getting cut off).
          Hidden in fullscreen: a glowing border around a full-screen video looks wrong — the
          bottom-right waveform alone conveys "speaking" there. */}
      {speaking && !isFullscreen && !isPoppedOut && (
        <div
          className="absolute inset-0 z-20 pointer-events-none"
          style={{ boxShadow: `inset 0 0 0 3px #25F4EE, inset 0 0 16px 2px rgba(37,244,238,${Math.min(0.7, 0.35 + level)})` }}
        />
      )}

      {/* Voice activity waveform (bottom-right). Not on the PiP placeholder — the voice bars are
          drawn INSIDE the PiP overlay itself (see compositePip), not on the empty in-grid tile. */}
      {voiceKey && speaking && !isPoppedOut && (
        <div className="absolute bottom-2 right-2 z-10 flex items-center bg-black/45 backdrop-blur-sm rounded-full px-2 py-1">
          <VoiceBars level={level} />
        </div>
      )}

      {/* Controls overlay (single click). Tapping the dim backdrop closes it. Always carries
          the fullscreen button; parent-provided controls (mic/cam/switch…) sit alongside. */}
      {showControls && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          onClick={(e) => { e.stopPropagation(); setActive(null); }}
        >
          <div
            className="flex flex-col items-center gap-3"
            onClick={(e) => { e.stopPropagation(); bumpControlsTimer(); }}
          >
            <div className="flex items-center justify-center flex-wrap gap-2.5 max-w-[280px]">
              {controlButtons}
            </div>
            {belowControls}
          </div>
        </div>
      )}

      {/* Label */}
      <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/60 to-transparent opacity-100 transition-opacity">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{label}</span>
          {isMuted && (
            <span className="ml-auto bg-danger/80 rounded-full w-5 h-5 flex items-center justify-center">
              <MicOff size={12} />
            </span>
          )}
          {isScreen && (
            <span className="bg-secondary/80 rounded-full px-2 py-0.5 text-[10px] font-medium flex items-center gap-1">
              <Monitor size={10} /> 화면공유
            </span>
          )}
        </div>
      </div>
    </motion.div>

    {/* Small-tile controls live OUTSIDE the tile so the bottom sheet's `position: fixed` is
        relative to the viewport (a transformed framer-motion ancestor would otherwise break it).
        Tapping a control keeps it open to toggle several; PiP/fullscreen and the backdrop dismiss. */}
    <BottomSheet isOpen={sheetOpen} onClose={() => setActive(null)} title={label}>
      <div data-feed-sheet className="px-4 pb-2 flex items-center justify-center flex-wrap gap-3">
        {controlButtons}
      </div>
      {belowControls && (
        <div className="px-4 pb-2 flex items-center justify-center">{belowControls}</div>
      )}
    </BottomSheet>

</>
  );
});
