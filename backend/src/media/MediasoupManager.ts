import * as mediasoup from 'mediasoup';
import { types as mediasoupTypes } from 'mediasoup';
import { EventEmitter } from 'events';
import { mediasoupConfig } from '../config/mediasoup';

interface RoomMedia {
  router: mediasoupTypes.Router;
  transports: Map<string, mediasoupTypes.WebRtcTransport>;
  producers: Map<string, mediasoupTypes.Producer>;
  consumers: Map<string, mediasoupTypes.Consumer>;
  // --- dynacast bookkeeping (video producers only) ---
  /** producerId -> (resumed consumerId -> its preferred spatial layer) */
  producerDemand: Map<string, Map<string, number>>;
  /** producerId -> whether the publisher wants it on (cam/mic toggle) */
  publisherActive: Map<string, boolean>;
  /** producerId -> last signalled max spatial layer the publisher should send */
  producerMaxLayer: Map<string, number>;
}

const MAX_SPATIAL_LAYER = 1; // matches simulcastEncodings (r0 thumbnail / r1 HD)

/**
 * Emits `producerSendChange` { roomId, producerId, maxSpatialLayer } telling the
 * publishing client to cap how many simulcast layers it sends (dynacast).
 * We cap layers via the publisher's RTCRtpSender (setMaxSpatialLayer) rather than
 * pausing the producer, so the publisher's own self-view track stays live while
 * uplink for layers nobody watches is dropped.
 */
class MediasoupManager extends EventEmitter {
  private workers: mediasoupTypes.Worker[] = [];
  private nextWorkerIdx = 0;
  private rooms: Map<string, RoomMedia> = new Map();

  async init() {
    for (let i = 0; i < mediasoupConfig.numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        rtcMinPort: mediasoupConfig.worker.rtcMinPort,
        rtcMaxPort: mediasoupConfig.worker.rtcMaxPort,
        logLevel: mediasoupConfig.worker.logLevel,
        logTags: mediasoupConfig.worker.logTags,
      });

      worker.on('died', () => {
        console.error(`mediasoup worker ${worker.pid} died, restarting...`);
        setTimeout(() => this.replaceWorker(i), 2000);
      });

      this.workers.push(worker);
      console.log(`mediasoup worker ${worker.pid} started`);
    }
  }

  private async replaceWorker(index: number) {
    const worker = await mediasoup.createWorker({
      rtcMinPort: mediasoupConfig.worker.rtcMinPort,
      rtcMaxPort: mediasoupConfig.worker.rtcMaxPort,
      logLevel: mediasoupConfig.worker.logLevel,
      logTags: mediasoupConfig.worker.logTags,
    });
    worker.on('died', () => {
      console.error(`mediasoup worker ${worker.pid} died, restarting...`);
      setTimeout(() => this.replaceWorker(index), 2000);
    });
    this.workers[index] = worker;
    console.log(`mediasoup worker replaced: pid ${worker.pid}`);
  }

  private getNextWorker(): mediasoupTypes.Worker {
    const worker = this.workers[this.nextWorkerIdx];
    this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length;
    return worker;
  }

  async getOrCreateRoom(roomId: string): Promise<RoomMedia> {
    let room = this.rooms.get(roomId);
    if (room) return room;

    const worker = this.getNextWorker();
    const router = await worker.createRouter({
      mediaCodecs: mediasoupConfig.router.mediaCodecs,
    });

    room = {
      router,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      producerDemand: new Map(),
      publisherActive: new Map(),
      producerMaxLayer: new Map(),
    };

    this.rooms.set(roomId, room);
    console.log(`Room ${roomId} created on worker ${worker.pid}`);
    return room;
  }

  getRoom(roomId: string): RoomMedia | undefined {
    return this.rooms.get(roomId);
  }

  async createWebRtcTransport(roomId: string) {
    const room = await this.getOrCreateRoom(roomId);

    const transport = await room.router.createWebRtcTransport({
      listenIps: mediasoupConfig.webRtcTransport.listenIps,
      enableUdp: mediasoupConfig.webRtcTransport.enableUdp,
      enableTcp: mediasoupConfig.webRtcTransport.enableTcp,
      preferUdp: mediasoupConfig.webRtcTransport.preferUdp,
      initialAvailableOutgoingBitrate: mediasoupConfig.webRtcTransport.initialAvailableOutgoingBitrate,
    });

    if (mediasoupConfig.webRtcTransport.maxIncomingBitrate) {
      await transport.setMaxIncomingBitrate(mediasoupConfig.webRtcTransport.maxIncomingBitrate);
    }

    room.transports.set(transport.id, transport);

    transport.on('routerclose', () => {
      room!.transports.delete(transport.id);
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  async restartIce(roomId: string, transportId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('Room not found');
    const transport = room.transports.get(transportId);
    if (!transport) throw new Error('Transport not found');
    return transport.restartIce();
  }

  async connectTransport(roomId: string, transportId: string, dtlsParameters: mediasoupTypes.DtlsParameters) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('Room not found');

    const transport = room.transports.get(transportId);
    if (!transport) throw new Error('Transport not found');

    await transport.connect({ dtlsParameters });
  }

  async produce(
    roomId: string,
    transportId: string,
    kind: mediasoupTypes.MediaKind,
    rtpParameters: mediasoupTypes.RtpParameters,
    appData: Record<string, unknown>
  ) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('Room not found');

    const transport = room.transports.get(transportId);
    if (!transport) throw new Error('Transport not found');

    const producer = await transport.produce({ kind, rtpParameters, appData });

    room.producers.set(producer.id, producer);
    room.publisherActive.set(producer.id, true);
    room.producerDemand.set(producer.id, new Map());
    room.producerMaxLayer.set(producer.id, MAX_SPATIAL_LAYER);

    producer.on('transportclose', () => {
      room.producers.delete(producer.id);
      this.cleanupProducerBookkeeping(room, producer.id);
    });

    return producer;
  }

  /** Recompute the highest spatial layer anyone is watching, and signal on change. */
  private reconcileProducer(roomId: string, room: RoomMedia, producerId: string) {
    const producer = room.producers.get(producerId);
    if (!producer || producer.kind !== 'video') return;

    const publisherActive = room.publisherActive.get(producerId) !== false;
    const demand = room.producerDemand.get(producerId);

    let maxLayer = 0;
    if (publisherActive && demand && demand.size > 0) {
      for (const layer of demand.values()) {
        if (layer > maxLayer) maxLayer = layer;
      }
    }

    const prevLayer = room.producerMaxLayer.get(producerId);
    if (prevLayer === maxLayer) return;
    room.producerMaxLayer.set(producerId, maxLayer);
    this.emit('producerSendChange', { roomId, producerId, maxSpatialLayer: maxLayer });

    // When the publisher is being asked to send a HIGHER spatial layer again (e.g. a
    // viewer enlarged the tile), that layer was previously not encoded, so consumers
    // would sit on a frozen frame until the next periodic keyframe. Force a keyframe
    // now so the newly-available layer decodes right away.
    if (prevLayer !== undefined && maxLayer > prevLayer) {
      this.requestKeyFrameForProducer(room, producerId);
    }
  }

  /** Ask all live consumers of a producer to pull a fresh keyframe (sends PLI upstream). */
  private requestKeyFrameForProducer(room: RoomMedia, producerId: string) {
    for (const consumer of room.consumers.values()) {
      if (consumer.producerId === producerId && consumer.kind === 'video' && !consumer.closed) {
        consumer.requestKeyFrame().catch(() => {});
      }
    }
  }

  /** Client-driven stall recovery: a frozen video element asks for a keyframe. */
  async requestConsumerKeyFrame(roomId: string, consumerId: string) {
    const room = this.rooms.get(roomId);
    const consumer = room?.consumers.get(consumerId);
    if (!consumer || consumer.closed || consumer.kind !== 'video') return;
    await consumer.requestKeyFrame().catch(() => {});
  }

  private cleanupProducerBookkeeping(room: RoomMedia, producerId: string) {
    room.producerDemand.delete(producerId);
    room.publisherActive.delete(producerId);
    room.producerMaxLayer.delete(producerId);
  }

  async consume(
    roomId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: mediasoupTypes.RtpCapabilities
  ) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('Room not found');

    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error('Cannot consume');
    }

    const transport = room.transports.get(transportId);
    if (!transport) throw new Error('Transport not found');

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });

    room.consumers.set(consumer.id, consumer);

    const dropDemand = () => {
      room.consumers.delete(consumer.id);
      const map = room.producerDemand.get(producerId);
      if (map?.delete(consumer.id)) {
        this.reconcileProducer(roomId, room, producerId);
      }
    };

    consumer.on('transportclose', dropDemand);
    consumer.on('producerclose', dropDemand);

    return consumer;
  }

  async closeProducer(roomId: string, producerId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const producer = room.producers.get(producerId);
    if (producer) {
      producer.close();
      room.producers.delete(producerId);
      this.cleanupProducerBookkeeping(room, producerId);
    }
  }

  // Publisher intent (camera/mic toggle): pauses server forwarding AND feeds dynacast.
  async pauseProducer(roomId: string, producerId: string) {
    const room = this.rooms.get(roomId);
    const producer = room?.producers.get(producerId);
    if (!room || !producer) return;
    room.publisherActive.set(producerId, false);
    await producer.pause();
    this.reconcileProducer(roomId, room, producerId);
  }

  async resumeProducer(roomId: string, producerId: string) {
    const room = this.rooms.get(roomId);
    const producer = room?.producers.get(producerId);
    if (!room || !producer) return;
    room.publisherActive.set(producerId, true);
    await producer.resume();
    this.reconcileProducer(roomId, room, producerId);
  }

  async pauseConsumer(roomId: string, consumerId: string) {
    const room = this.rooms.get(roomId);
    const consumer = room?.consumers.get(consumerId);
    if (!room || !consumer) return;
    await consumer.pause();
    const map = room.producerDemand.get(consumer.producerId);
    if (map?.delete(consumerId)) {
      this.reconcileProducer(roomId, room, consumer.producerId);
    }
  }

  async resumeConsumer(roomId: string, consumerId: string) {
    const room = this.rooms.get(roomId);
    const consumer = room?.consumers.get(consumerId);
    if (!room || !consumer) return;
    await consumer.resume();
    let map = room.producerDemand.get(consumer.producerId);
    if (!map) {
      map = new Map();
      room.producerDemand.set(consumer.producerId, map);
    }
    if (!map.has(consumerId)) {
      map.set(consumerId, MAX_SPATIAL_LAYER);
      this.reconcileProducer(roomId, room, consumer.producerId);
    }
  }

  async setPreferredLayers(roomId: string, consumerId: string, spatialLayer: number, temporalLayer?: number) {
    const room = this.rooms.get(roomId);
    const consumer = room?.consumers.get(consumerId);
    if (!room || !consumer || consumer.type !== 'simulcast') return;
    await consumer.setPreferredLayers({ spatialLayer, temporalLayer });
    consumer.requestKeyFrame().catch(() => {});
    // Feed dynacast: a watcher only wanting layer 0 lets the publisher drop higher layers.
    const map = room.producerDemand.get(consumer.producerId);
    if (map?.has(consumerId)) {
      map.set(consumerId, spatialLayer);
      this.reconcileProducer(roomId, room, consumer.producerId);
    }
  }

  cleanupTransports(roomId: string, transportIds: string[]) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const id of transportIds) {
      const transport = room.transports.get(id);
      if (transport) {
        transport.close();
        room.transports.delete(id);
      }
    }
  }

  closeRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.router.close();
    this.rooms.delete(roomId);
    console.log(`Room ${roomId} closed`);
  }

  getRouterRtpCapabilities(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.router.rtpCapabilities;
  }
}

export const mediasoupManager = new MediasoupManager();
