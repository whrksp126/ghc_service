export interface Participant {
  userId: string;
  nickname: string;
  deviceId: string;
  deviceLabel: string;
}

export interface ProducerInfo {
  producerId: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  kind: 'audio' | 'video';
  appData: Record<string, unknown>;
}

export interface ConsumerInfo {
  consumerId: string;
  producerId: string;
  userId: string;
  deviceId: string;
  kind: 'audio' | 'video';
  track: MediaStreamTrack;
  paused: boolean;
  // From the LiveKit participant metadata — lets feeds label remote tiles without a
  // separate Socket.IO roster lookup.
  nickname?: string;
  deviceLabel?: string;
  source?: 'camera' | 'screen' | 'microphone' | 'unknown';
  // The LiveKit RemoteTrack. Video feeds attach via this so adaptiveStream can pick the
  // right simulcast layer from the element's on-screen size/visibility.
  lkTrack?: import('livekit-client').RemoteTrack;
}

export interface RoomInfo {
  id: string;
  name: string;
  slug: string;
  hasPin: boolean;
  maxParticipants: number;
  allowViewers: boolean;
}

export type ConnectionQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'disconnected';

export type LayoutMode = 'grid' | 'spotlight';
