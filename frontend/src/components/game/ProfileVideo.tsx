import { memo, useEffect, useRef } from 'react';
import type { RemoteTrack } from 'livekit-client';
import { useUIStore } from '../../stores/uiStore';
import { registerAudioEl, playTracked } from '../../lib/audioUnlock';

/** 게임 패널이 쓰는 최소 피드 정보 (RoomPage의 allFeeds에서 그대로 넘어온다). */
export interface GameFeed {
  id: string;
  /** 이 피드의 주인 — 프로필 카드 매칭용 */
  userId?: string;
  track: MediaStreamTrack | null;
  lkTrack?: RemoteTrack;
  audioTrack?: MediaStreamTrack;
  audioKey?: string;
  label: string;
  isLocal?: boolean;
  isScreen?: boolean;
  mirror?: boolean;
}

function initials(label: string): string {
  return label.trim().slice(0, 2) || '?';
}

interface ProfileVideoProps {
  feed?: GameFeed;
  /** 카메라가 없을 때 쓸 색 (플레이어 색) */
  color: string;
  label: string;
  className?: string;
  rounded?: string;
}

/**
 * 프로필 카드·관전자 칩 안의 작은 카메라.
 * 게임 패널이 열려 있는 동안 RoomPage는 비디오 컬럼을 **렌더하지 않으므로**, 이 엘리먼트가
 * 그 트랙의 유일한 attach 지점이다(중복 attach 없음). FeedCard와 같은 방식으로 마이크 트랙을
 * 같은 MediaStream에 얹어 립싱크를 유지한다.
 */
export const ProfileVideo = memo(function ProfileVideo({
  feed, color, label, className = '', rounded = 'rounded-lg',
}: ProfileVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const audioKey = feed?.audioKey;
  const muted = useUIStore((s) => (audioKey ? !!s.mutedAudio[audioKey] : false));
  const volume = useUIStore((s) => (audioKey ? s.volumeAudio[audioKey] ?? 1 : 1));

  const track = feed?.track ?? null;
  const lkTrack = feed?.lkTrack;
  const audioTrack = feed?.audioTrack;
  const isLocal = !!feed?.isLocal;

  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    if (lkTrack && !isLocal) lkTrack.attach(el);
    else el.srcObject = new MediaStream([track]);

    // 같은 사람의 마이크를 같은 엘리먼트에 실어 준다(FeedCard와 동일 — 립싱크 + 음성 유지).
    const stream = el.srcObject as MediaStream | null;
    if (audioTrack && stream && !stream.getAudioTracks().some((t) => t.id === audioTrack.id)) {
      stream.addTrack(audioTrack);
    }
    void playTracked(el).catch(() => {});
    const unregister = audioTrack ? registerAudioEl(() => el.play()) : () => {};
    return () => {
      unregister();
      if (audioTrack && stream?.getTracks().includes(audioTrack)) stream.removeTrack(audioTrack);
      if (lkTrack && !isLocal) lkTrack.detach(el);
      else el.srcObject = null;
    };
  }, [track, lkTrack, audioTrack, isLocal]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = isLocal || !audioTrack || muted;
    el.volume = volume;
  }, [isLocal, audioTrack, muted, volume]);

  if (!track) {
    return (
      <div
        className={`flex items-center justify-center ${rounded} ${className}`}
        style={{ background: `${color}33`, boxShadow: `inset 0 0 0 1px ${color}66` }}
      >
        <span className="font-display text-sm font-bold" style={{ color }}>{initials(label)}</span>
      </div>
    );
  }

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      className={`${rounded} object-cover ${className}`}
      style={feed?.mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
});
