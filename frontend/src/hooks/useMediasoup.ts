import { useRef, useCallback } from 'react';
import { Device } from 'mediasoup-client';
import type { types } from 'mediasoup-client';
type Transport = types.Transport;
type Producer = types.Producer;
type Consumer = types.Consumer;
type RtpCapabilities = types.RtpCapabilities;
import { emitWithAck } from '../lib/socket';
import { useDeviceStore } from '../stores/deviceStore';
import { useRoomStore } from '../stores/roomStore';

export function useMediasoup() {
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producersRef = useRef<Map<string, Producer>>(new Map());
  const consumersRef = useRef<Map<string, Consumer>>(new Map());

  const { setAudioProducerId, setVideoProducerId, setScreenProducerId } = useDeviceStore();
  const { addConsumer, removeConsumer } = useRoomStore();

  // Recover media when the network path drops (e.g. WiFi <-> LTE) by restarting ICE.
  const attachIceRestart = useCallback((transport: Transport) => {
    let restarting = false;
    transport.on('connectionstatechange', async (state) => {
      if (state === 'failed' || state === 'disconnected') {
        if (restarting || transport.closed) return;
        restarting = true;
        try {
          const { iceParameters } = await emitWithAck<{ iceParameters: any }>('media:restartIce', {
            transportId: transport.id,
          });
          if (iceParameters && !transport.closed) {
            await transport.restartIce({ iceParameters });
          }
        } catch {
          // will retry on the next connectionstatechange
        } finally {
          restarting = false;
        }
      }
    });
  }, []);

  const loadDevice = useCallback(async () => {
    const { rtpCapabilities } = await emitWithAck<{ rtpCapabilities: RtpCapabilities }>(
      'media:getRouterRtpCapabilities'
    );

    const device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    deviceRef.current = device;

    return device;
  }, []);

  const createSendTransport = useCallback(async () => {
    const transportOptions = await emitWithAck<any>('media:createSendTransport');

    const transport = deviceRef.current!.createSendTransport(transportOptions);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      emitWithAck('media:connectTransport', {
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      emitWithAck<{ producerId: string }>('media:produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
        appData,
      })
        .then(({ producerId }) => callback({ id: producerId }))
        .catch(errback);
    });

    attachIceRestart(transport);
    sendTransportRef.current = transport;
    return transport;
  }, [attachIceRestart]);

  const createRecvTransport = useCallback(async () => {
    const transportOptions = await emitWithAck<any>('media:createRecvTransport');

    const transport = deviceRef.current!.createRecvTransport(transportOptions);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      emitWithAck('media:connectTransport', {
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    attachIceRestart(transport);
    recvTransportRef.current = transport;
    return transport;
  }, [attachIceRestart]);

  const produce = useCallback(async (track: MediaStreamTrack, appData: Record<string, unknown> = {}) => {
    if (!sendTransportRef.current) return null;

    // scalabilityMode 'L1T3' gives each simulcast layer 3 temporal sub-layers. Without
    // it the decoder has nothing to fall back to under loss/congestion and the top
    // layer freezes on a still frame; with it the SFU can drop temporal layers and the
    // picture keeps moving (lower fps) instead of stalling.
    // Two simulcast layers, not three. A phone uplink is split across every layer it
    // sends simultaneously; a third (mid) layer starves the top one, so a focused 1080p
    // feed looks soft. Two layers — a tiny thumbnail + a full-res HD — let the HD layer
    // claim almost all the uplink. Pinned spatial 2 on the viewer clamps to the top.
    const encodings = track.kind === 'video'
      ? [
          { maxBitrate: 250000, scaleResolutionDownBy: 4, rid: 'r0', scalabilityMode: 'L1T3' },
          { maxBitrate: 5000000, scaleResolutionDownBy: 1, rid: 'r1', scalabilityMode: 'L1T3' },
        ]
      : undefined;

    // Bias the encoder toward keeping resolution (sharpness) over framerate when CPU/
    // bandwidth is tight — with 'detail' (maintain-resolution) a starved 1080p layer
    // drops fps instead of downscaling, so it stays crisp instead of going soft.
    if (track.kind === 'video') track.contentHint = 'detail';

    const producer = await sendTransportRef.current.produce({
      track,
      encodings,
      codecOptions: track.kind === 'video'
        ? { videoGoogleStartBitrate: 2500 }
        : { opusStereo: true, opusDtx: true },
      appData,
    });

    producersRef.current.set(producer.id, producer);

    if (appData.mediaType === 'screen') {
      setScreenProducerId(producer.id);
    } else if (track.kind === 'audio') {
      setAudioProducerId(producer.id);
    } else {
      setVideoProducerId(producer.id);
    }

    return producer;
  }, [setAudioProducerId, setVideoProducerId, setScreenProducerId]);

  const consume = useCallback(async (producerId: string) => {
    if (!recvTransportRef.current || !deviceRef.current) return null;

    const result = await emitWithAck<any>('media:consume', {
      producerId,
      rtpCapabilities: deviceRef.current.rtpCapabilities,
    });

    const consumer = await recvTransportRef.current.consume({
      id: result.consumerId,
      producerId: result.producerId,
      kind: result.kind,
      rtpParameters: result.rtpParameters,
    });

    consumersRef.current.set(consumer.id, consumer);

    addConsumer({
      consumerId: consumer.id,
      producerId: result.producerId,
      userId: result.appData?.userId,
      deviceId: result.appData?.deviceId,
      kind: consumer.kind as 'audio' | 'video',
      track: consumer.track,
      paused: false,
    });

    await emitWithAck('media:resumeConsumer', { consumerId: consumer.id });

    return consumer;
  }, [addConsumer]);

  const closeProducer = useCallback(async (producerId: string) => {
    const producer = producersRef.current.get(producerId);
    if (producer) {
      producer.close();
      producersRef.current.delete(producerId);
      await emitWithAck('media:closeProducer', { producerId }).catch(() => {});
    }
  }, []);

  const pauseConsumer = useCallback(async (consumerId: string) => {
    await emitWithAck('media:pauseConsumer', { consumerId }).catch(() => {});
  }, []);

  const resumeConsumer = useCallback(async (consumerId: string) => {
    await emitWithAck('media:resumeConsumer', { consumerId }).catch(() => {});
  }, []);

  const cleanup = useCallback(() => {
    for (const producer of producersRef.current.values()) {
      producer.close();
    }
    producersRef.current.clear();

    for (const consumer of consumersRef.current.values()) {
      consumer.close();
      removeConsumer(consumer.id);
    }
    consumersRef.current.clear();

    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current = null;
  }, [removeConsumer]);

  return {
    device: deviceRef,
    loadDevice,
    createSendTransport,
    createRecvTransport,
    produce,
    consume,
    closeProducer,
    pauseConsumer,
    resumeConsumer,
    cleanup,
    producersRef,
    consumersRef,
  };
}
