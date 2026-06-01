import { useRef, useEffect, memo } from 'react';
import { motion } from 'framer-motion';
import { MicOff, Monitor, Signal, SignalLow } from 'lucide-react';
import { useAdaptiveQuality } from '../../hooks/useAdaptiveQuality';
import { useVoiceStore } from '../../services/voiceActivity';
import { useAudioSettings, sensitivityToThreshold } from '../../stores/audioSettings';
import { VoiceBars } from '../common/VoiceBars';
import { getSocket } from '../../lib/socket';

interface FeedCardProps {
  track: MediaStreamTrack | null;
  label: string;
  deviceLabel: string;
  isMuted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  /** Remote consumer id — enables adaptive quality + HD indicator. Omit for local feeds. */
  consumerId?: string;
  /** Stable feed id — drives shared-element layout morph across layout modes. */
  layoutId?: string;
  /** Focused/spotlight feed — always request the top spatial layer (sharper). */
  priority?: boolean;
  /** Participant key (`${userId}:${deviceId}`) for voice-activity glow + waveform. */
  voiceKey?: string;
  className?: string;
  onClick?: () => void;
}

export const FeedCard = memo(function FeedCard({
  track,
  label,
  deviceLabel,
  isMuted,
  isLocal,
  isScreen,
  consumerId,
  layoutId,
  priority,
  voiceKey,
  className = '',
  onClick,
}: FeedCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const quality = useAdaptiveQuality(consumerId, rootRef, !isLocal && !!consumerId && !!track, priority);
  const level = useVoiceStore((s) => (voiceKey ? s.levels[voiceKey] ?? 0 : 0));
  const sensitivity = useAudioSettings((s) => s.sensitivity);
  const speaking = level > sensitivityToThreshold(sensitivity);

  useEffect(() => {
    if (!videoRef.current || !track) return;
    const stream = new MediaStream([track]);
    videoRef.current.srcObject = stream;
  }, [track]);

  // Stall recovery: a remote simulcast feed can freeze on a stale frame after a layer
  // switch (the new layer hasn't sent a keyframe yet). If the video element stops
  // advancing while it should be playing, ask the SFU to pull a fresh keyframe.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isLocal || !consumerId || !track) return;
    let lastTime = -1;
    let stalls = 0;
    const iv = setInterval(() => {
      if (video.paused || video.readyState < 2) return;
      const t = video.currentTime;
      if (t === lastTime) {
        if (++stalls >= 2) {
          getSocket().emit('media:requestKeyFrame', { consumerId });
          stalls = 0;
        }
      } else {
        stalls = 0;
        lastTime = t;
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [consumerId, track, isLocal]);

  const showQuality = !isLocal && !!consumerId && !!track;

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

      {/* Quality indicator (adaptive layer) */}
      {showQuality && quality !== 'paused' && (
        <motion.div
          key={quality}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className={`absolute top-2 right-2 z-10 rounded-full px-1.5 py-0.5 flex items-center gap-1 text-[10px] font-semibold backdrop-blur-sm ${
            quality === 'high' ? 'bg-secondary/80 text-dark-900' : 'bg-black/50 text-white/70'
          }`}
        >
          {quality === 'high' ? <Signal size={11} /> : <SignalLow size={11} />}
          {quality === 'high' ? 'HD' : 'SD'}
        </motion.div>
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
