import { useRef, useCallback } from 'react';
import { Device } from 'mediasoup-client';
import type { types } from 'mediasoup-client';
import { emitWithAck } from '../lib/socket';
import { useCameraStore } from '../stores/cameraStore';
import { useAuthStore } from '../stores/authStore';
import { useAlwaysOnCamera } from './alwaysOnCamera';

type Transport = types.Transport;
type RtpCapabilities = types.RtpCapabilities;

interface BackgroundSession {
  roomSlug: string;
  device: Device;
  sendTransport: Transport | null;
  producerIds: string[];
}

export function useBackgroundCamera() {
  const sessionRef = useRef<BackgroundSession | null>(null);
  const { updateCamera } = useCameraStore();
  const { deviceId } = useAuthStore();

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

      await emitWithAck<{
        participants: any[];
        existingProducers: any[];
        iceServers: any[];
      }>('room:join', { roomSlug });

      const { rtpCapabilities } = await emitWithAck<{ rtpCapabilities: RtpCapabilities }>(
        'media:getRouterRtpCapabilities'
      );

      const device = new Device();
      await device.load({ routerRtpCapabilities: rtpCapabilities });

      const sendTransportOptions = await emitWithAck<any>('media:createSendTransport');
      const sendTransport = device.createSendTransport(sendTransportOptions);

      sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        emitWithAck('media:connectTransport', {
          transportId: sendTransport.id,
          dtlsParameters,
        })
          .then(() => callback())
          .catch(errback);
      });

      sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        emitWithAck<{ producerId: string }>('media:produce', {
          transportId: sendTransport.id,
          kind,
          rtpParameters,
          appData,
        })
          .then(({ producerId }) => callback({ id: producerId }))
          .catch(errback);
      });

      const session: BackgroundSession = {
        roomSlug,
        device,
        sendTransport,
        producerIds: [],
      };

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        // Prefer resolution over framerate so the top simulcast layer stays sharp.
        videoTrack.contentHint = 'detail';
        // Same simulcast ladder as the foreground path (useMediasoup) — otherwise a
        // remotely-started device publishes a single low-bitrate layer and viewers get
        // a blurry feed with no way to request HD.
        const producer = await sendTransport.produce({
          track: videoTrack,
          encodings: [
            { maxBitrate: 150000, scaleResolutionDownBy: 4, rid: 'r0', scalabilityMode: 'L1T3' },
            { maxBitrate: 500000, scaleResolutionDownBy: 2, rid: 'r1', scalabilityMode: 'L1T3' },
            { maxBitrate: 5000000, scaleResolutionDownBy: 1, rid: 'r2', scalabilityMode: 'L1T3' },
          ],
          codecOptions: { videoGoogleStartBitrate: 1000 },
          appData: { mediaType: 'video' },
        });
        session.producerIds.push(producer.id);
      }

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        const producer = await sendTransport.produce({
          track: audioTrack,
          appData: { mediaType: 'audio' },
        });
        session.producerIds.push(producer.id);
      }

      sessionRef.current = session;

      if (deviceId) {
        updateCamera(deviceId, { isInRoom: true, roomSlug });
      }

      emitWithAck('camera:statusUpdate', { isInRoom: true, roomSlug }).catch(() => {});
    } catch (err) {
      console.error('Background camera start failed:', err);
    }
  }, [deviceId, updateCamera]);

  const stopStreaming = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;

    for (const producerId of session.producerIds) {
      await emitWithAck('media:closeProducer', { producerId }).catch(() => {});
    }

    session.sendTransport?.close();

    await emitWithAck('room:leave', {}).catch(() => {});

    sessionRef.current = null;

    if (deviceId) {
      updateCamera(deviceId, { isInRoom: false, roomSlug: null });
    }

    emitWithAck('camera:statusUpdate', { isInRoom: false, roomSlug: null }).catch(() => {});
  }, [deviceId, updateCamera]);

  const isStreaming = useCallback(() => !!sessionRef.current, []);

  return { startStreaming, stopStreaming, isStreaming };
}
