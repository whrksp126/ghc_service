import { useRef, useEffect, memo } from 'react';
import { motion } from 'framer-motion';
import { MicOff, Monitor } from 'lucide-react';
import type { RemoteTrack } from 'livekit-client';
import { useVoiceStore } from '../../services/voiceActivity';
import { useAudioSettings, sensitivityToThreshold } from '../../stores/audioSettings';
import { VoiceBars } from '../common/VoiceBars';

interface FeedCardProps {
  track: MediaStreamTrack | null;
  /** LiveKit remote track — attaching via this lets adaptiveStream size the layer. */
  lkTrack?: RemoteTrack;
  label: string;
  deviceLabel: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  /** Stable feed id — drives shared-element layout morph across layout modes. */
  layoutId?: string;
  /** Participant key (`${userId}:${deviceId}`) for voice-activity glow + waveform. */
  voiceKey?: string;
  className?: string;
  onClick?: () => void;
}

export const FeedCard = memo(function FeedCard({
  track,
  lkTrack,
  label,
  deviceLabel,
  isMuted,
  isLocal,
  isScreen,
  layoutId,
  voiceKey,
  className = '',
  onClick,
}: FeedCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const level = useVoiceStore((s) => (voiceKey ? s.levels[voiceKey] ?? 0 : 0));
  const sensitivity = useAudioSettings((s) => s.sensitivity);
  const speaking = level > sensitivityToThreshold(sensitivity);

  // Remote video → attach through LiveKit so adaptiveStream observes this element's size
  // and visibility and requests the matching simulcast layer. Local/screen → plain sink.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    if (lkTrack && !isLocal) {
      lkTrack.attach(el);
      return () => { lkTrack.detach(el); };
    }
    el.srcObject = new MediaStream([track]);
    return () => { el.srcObject = null; };
  }, [track, lkTrack, isLocal]);

  return (
    <motion.div
      ref={rootRef}
      layout
      layoutId={layoutId}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 350, damping: 32 }}
      className={`feed-card relative group cursor-pointer transition-shadow duration-100 ${className}`}
      style={speaking
        ? { boxShadow: `0 0 0 3px #25F4EE, 0 0 18px 2px rgba(37,244,238,${Math.min(0.7, 0.35 + level)})` }
        : undefined}
      onClick={onClick}
    >
      {track ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal || track.kind === 'video'}
          className={`w-full h-full object-cover ${isLocal && !isScreen ? 'scale-x-[-1]' : ''}`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-dark-800">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary/30 to-secondary/30 flex items-center justify-center text-2xl font-bold text-white/50">
            {label[0]?.toUpperCase()}
          </div>
        </div>
      )}

      {/* Voice activity waveform (bottom-right) */}
      {voiceKey && speaking && (
        <div className="absolute bottom-2 right-2 z-10 flex items-center bg-black/45 backdrop-blur-sm rounded-full px-2 py-1">
          <VoiceBars level={level} />
        </div>
      )}

      {/* Overlay */}
      <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/60 to-transparent opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{label}</span>
          <span className="text-xs text-white/40 truncate">{deviceLabel}</span>
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
  );
});
