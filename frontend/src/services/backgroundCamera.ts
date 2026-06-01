import { useRef, useCallback } from 'react';
import { emitWithAck } from '../lib/socket';
import { useCameraStore } from '../stores/cameraStore';
import { useAuthStore } from '../stores/authStore';
import { useAlwaysOnCamera } from './alwaysOnCamera';
import { connectToRoom, publishTrack, disconnectRoom } from '../lib/livekitRoom';

interface BackgroundSession {
  roomSlug: string;
  trackSids: string[];
}

/**
 * Headless streaming for a device that was remotely told to join a room (the user tapped
 * "start" on this camera from another device). No room UI — just join, connect to LiveKit
 * and publish camera + mic. Foreground RoomPage uses the same livekitRoom singleton.
 */
export function useBackgroundCamera() {
  const sessionRef = useRef<BackgroundSession | null>(null);
  const { updateCamera } = useCameraStore();
  const { deviceId } = useAuthStore();

  const stopStreaming = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;

    await disconnectRoom();
    await emitWithAck('room:leave', {}).catch(() => {});

    if (deviceId) {
      updateCamera(deviceId, { isInRoom: false, roomSlug: null });
    }
    emitWithAck('camera:statusUpdate', { isInRoom: false, roomSlug: null }).catch(() => {});
  }, [deviceId, updateCamera]);

  const startStreaming = useCallback(async (roomSlug: string) => {
    if (sessionRef.current) {
      await stopStreaming();
    }

    try {
      const alwaysOn = useAlwaysOnCamera.getState();
      if (!alwaysOn.stream || !alwaysOn.isActive) {
        await alwaysOn.start();
      }
      const stream = useAlwaysOnCamera.getState().stream;
      if (!stream) {
        console.error('No camera stream available');
        return;
      }

      // room:join registers presence + returns a LiveKit token; connect & publish.
      const { token } = await emitWithAck<{ token: string }>('room:join', { roomSlug });
      await connectToRoom(token);

      const session: BackgroundSession = { roomSlug, trackSids: [] };

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.contentHint = 'motion';
        const sid = await publishTrack(videoTrack, 'camera');
        if (sid) session.trackSids.push(sid);
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const sid = await publishTrack(audioTrack, 'microphone');
        if (sid) session.trackSids.push(sid);
      }

      sessionRef.current = session;

      if (deviceId) {
        updateCamera(deviceId, { isInRoom: true, roomSlug });
      }
      emitWithAck('camera:statusUpdate', { isInRoom: true, roomSlug }).catch(() => {});
    } catch (err) {
      console.error('Background camera start failed:', err);
    }
  }, [deviceId, updateCamera, stopStreaming]);

  const isStreaming = useCallback(() => !!sessionRef.current, []);

  return { startStreaming, stopStreaming, isStreaming };
}
