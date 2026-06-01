import { Server, Socket } from 'socket.io';
import { verifyToken, JwtPayload } from '../middleware/auth';
import { mediasoupManager } from '../media/MediasoupManager';
import { generateTurnCredentials } from '../config/turn';
import { Device, Room } from '../models';

interface Participant {
  userId: string;
  nickname: string;
  deviceId: string;
  deviceLabel: string;
  socketId: string;
  sendTransportId?: string;
  recvTransportId?: string;
  producerIds: string[];
}

const roomParticipants = new Map<string, Map<string, Participant>>();

function getRoomParticipants(roomId: string): Map<string, Participant> {
  if (!roomParticipants.has(roomId)) {
    roomParticipants.set(roomId, new Map());
  }
  return roomParticipants.get(roomId)!;
}

// Set once setupSocketHandlers runs; lets REST routes (room deletion) reach the live room.
let ioRef: Server | null = null;

// --- Reconnection grace ---
// A dropped socket isn't removed from the room immediately: we wait GRACE_MS so a quick
// reconnect (WiFi blip, LTE handover) doesn't spam everyone with leave/join churn. If the
// same user+device rejoins within the window we cancel the pending removal.
const GRACE_MS = 10000;
interface PendingLeave {
  timer: ReturnType<typeof setTimeout>;
  socketId: string;
}
const pendingLeaves = new Map<string, PendingLeave>();
const leaveKey = (roomId: string, userId: string, deviceId: string) => `${roomId}|${userId}|${deviceId}`;

/** Remove a participant from a room and notify everyone. Socket-independent (uses ioRef). */
function performParticipantLeave(roomId: string, userId: string, deviceId: string) {
  const participants = roomParticipants.get(roomId);
  const key = `${userId}:${deviceId}`;
  const participant = participants?.get(key);

  if (participant) {
    const transportIds: string[] = [];
    if (participant.sendTransportId) transportIds.push(participant.sendTransportId);
    if (participant.recvTransportId) transportIds.push(participant.recvTransportId);
    mediasoupManager.cleanupTransports(roomId, transportIds);

    for (const producerId of participant.producerIds) {
      ioRef?.to(roomId).emit('media:producerClosed', { producerId, userId, deviceId });
    }
    participants!.delete(key);
  }

  ioRef?.to(roomId).emit('room:participantLeft', { userId, deviceId });
  ioRef?.to(`user:${userId}`).emit('camera:statusUpdate', { deviceId, isInRoom: false, roomSlug: null });

  if (participants && participants.size === 0) {
    mediasoupManager.closeRoom(roomId);
    roomParticipants.delete(roomId);
  }
}

/**
 * Force-terminate a room: notify everyone, tear down media, drop in-memory state.
 * Called both by the in-room owner (room:close socket event) and the REST delete route.
 */
export async function forceCloseRoom(roomSlug: string) {
  if (ioRef) ioRef.to(roomSlug).emit('room:closed', { roomSlug });
  mediasoupManager.closeRoom(roomSlug);
  roomParticipants.delete(roomSlug);
  if (ioRef) ioRef.in(roomSlug).socketsLeave(roomSlug);
}

export function setupSocketHandlers(io: Server) {
  ioRef = io;

  // dynacast: cap the publisher's sent simulcast layers to what viewers actually watch.
  mediasoupManager.on('producerSendChange', ({ roomId, producerId, maxSpatialLayer }) => {
    const participants = roomParticipants.get(roomId);
    if (!participants) return;
    for (const p of participants.values()) {
      if (p.producerIds.includes(producerId)) {
        io.to(p.socketId).emit('media:producerSendChange', { producerId, maxSpatialLayer });
        break;
      }
    }
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) return next(new Error('No token'));
      const payload = verifyToken(token);
      (socket as any).user = payload;
      (socket as any).deviceId = socket.handshake.query.deviceId as string;
      (socket as any).deviceLabel = socket.handshake.query.deviceLabel as string || 'Unknown';
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const user: JwtPayload = (socket as any).user;
    const deviceId: string = (socket as any).deviceId;
    const deviceLabel: string = (socket as any).deviceLabel;
    let currentRoomId: string | null = null;

    console.log(`Socket connected: ${socket.id} (${user.nickname}, device: ${deviceId})`);

    // --- Tier 1: Global connection tracking ---
    socket.join(`user:${user.userId}`);

    if (deviceId) {
      await Device.update(
        { is_online: true, socket_id: socket.id, last_seen_at: new Date() },
        { where: { id: deviceId, user_id: user.userId } }
      );

      socket.to(`user:${user.userId}`).emit('device:online', {
        deviceId,
        deviceLabel,
      });
    }

    // --- Camera remote control events ---
    socket.on('camera:requestStart', async ({ targetDeviceId, roomSlug }, callback) => {
      try {
        const targetDevice = await Device.findOne({
          where: { id: targetDeviceId, user_id: user.userId, is_active: true },
        });
        if (!targetDevice || !targetDevice.is_online || !targetDevice.socket_id) {
          return callback?.({ error: '대상 카메라가 오프라인입니다' });
        }

        io.to(targetDevice.socket_id).emit('camera:startRequested', {
          roomSlug,
          requestedBy: deviceId,
        });

        callback?.({ success: true });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('camera:requestStop', async ({ targetDeviceId }, callback) => {
      try {
        const targetDevice = await Device.findOne({
          where: { id: targetDeviceId, user_id: user.userId, is_active: true },
        });
        if (!targetDevice || !targetDevice.socket_id) {
          return callback?.({ error: '대상 카메라를 찾을 수 없습니다' });
        }

        io.to(targetDevice.socket_id).emit('camera:stopRequested', {
          requestedBy: deviceId,
        });

        callback?.({ success: true });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('camera:statusUpdate', ({ isInRoom, roomSlug }) => {
      socket.to(`user:${user.userId}`).emit('camera:statusUpdate', {
        deviceId,
        isInRoom,
        roomSlug: roomSlug || null,
      });
    });

    socket.on('camera:requestPowerOn', async ({ targetDeviceId }, callback) => {
      try {
        const targetDevice = await Device.findOne({
          where: { id: targetDeviceId, user_id: user.userId, is_active: true },
        });
        if (!targetDevice || !targetDevice.is_online || !targetDevice.socket_id) {
          return callback?.({ error: '대상 기기가 오프라인입니다' });
        }
        io.to(targetDevice.socket_id).emit('camera:powerOn');
        callback?.({ success: true });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('camera:requestPowerOff', async ({ targetDeviceId }, callback) => {
      try {
        const targetDevice = await Device.findOne({
          where: { id: targetDeviceId, user_id: user.userId, is_active: true },
        });
        if (!targetDevice || !targetDevice.is_online || !targetDevice.socket_id) {
          return callback?.({ error: '대상 기기가 오프라인입니다' });
        }
        io.to(targetDevice.socket_id).emit('camera:powerOff');
        callback?.({ success: true });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('camera:requestSwitchCamera', async ({ targetDeviceId, cameraIndex }, callback) => {
      try {
        const targetDevice = await Device.findOne({
          where: { id: targetDeviceId, user_id: user.userId, is_active: true },
        });
        if (!targetDevice || !targetDevice.is_online || !targetDevice.socket_id) {
          return callback?.({ error: '대상 기기가 오프라인입니다' });
        }
        io.to(targetDevice.socket_id).emit('camera:switchRequested', { cameraIndex });
        callback?.({ success: true });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('camera:cameraListUpdate', ({ cameraCount, activeIndex }) => {
      socket.to(`user:${user.userId}`).emit('camera:cameraListUpdate', {
        deviceId,
        cameraCount,
        activeIndex,
      });
    });

    // --- P2P preview signaling ---
    socket.on('preview:request', async ({ targetDeviceId }, callback) => {
      try {
        console.log(`[preview] request from ${deviceId} (socket:${socket.id}) for target ${targetDeviceId}`);
        if (targetDeviceId === deviceId) {
          console.log(`[preview] REJECTED: cannot preview self`);
          return callback?.({ error: 'cannot preview self' });
        }
        const target = await Device.findOne({
          where: { id: targetDeviceId, user_id: user.userId, is_active: true },
        });
        if (!target || !target.is_online || !target.socket_id) {
          console.log(`[preview] REJECTED: offline (found=${!!target}, online=${target?.is_online}, socketId=${target?.socket_id})`);
          return callback?.({ error: 'offline' });
        }
        if (target.socket_id === socket.id) {
          console.log(`[preview] REJECTED: target socket_id (${target.socket_id}) === requester socket.id (${socket.id})`);
          return callback?.({ error: 'target socket is self' });
        }
        console.log(`[preview] OK: sending preview:requested to target socket ${target.socket_id}`);
        const turnCredentials = generateTurnCredentials(user.userId);
        io.to(target.socket_id).emit('preview:requested', {
          viewerSocketId: socket.id,
          viewerDeviceId: deviceId,
          iceServers: turnCredentials.iceServers,
        });
        callback?.({ success: true, iceServers: turnCredentials.iceServers });
      } catch (err: any) {
        console.error(`[preview] ERROR:`, err);
        callback?.({ error: err.message });
      }
    });

    socket.on('preview:stop', async ({ targetDeviceId }) => {
      try {
        const target = await Device.findOne({
          where: { id: targetDeviceId, user_id: user.userId, is_active: true },
        });
        if (target?.socket_id) {
          io.to(target.socket_id).emit('preview:stopped', { viewerSocketId: socket.id });
        }
      } catch {}
    });

    socket.on('preview:offer', ({ targetSocketId, sdp }) => {
      const turnCredentials = generateTurnCredentials(user.userId);
      io.to(targetSocketId).emit('preview:offer', {
        streamerSocketId: socket.id,
        streamerDeviceId: deviceId,
        sdp,
        iceServers: turnCredentials.iceServers,
      });
    });

    socket.on('preview:noTrack', ({ targetSocketId, reason }) => {
      io.to(targetSocketId).emit('preview:noTrack', {
        streamerDeviceId: deviceId,
        reason,
      });
    });

    socket.on('preview:answer', ({ targetSocketId, sdp }) => {
      io.to(targetSocketId).emit('preview:answer', { viewerSocketId: socket.id, sdp });
    });

    socket.on('preview:ice', ({ targetSocketId, candidate }) => {
      io.to(targetSocketId).emit('preview:ice', { fromSocketId: socket.id, candidate });
    });

    socket.on('camera:activeStatusUpdate', ({ isActive }) => {
      socket.to(`user:${user.userId}`).emit('camera:activeStatusUpdate', {
        deviceId,
        isActive,
      });
    });

    socket.on('device:listOnline', async (_, callback) => {
      try {
        const devices = await Device.findAll({
          where: { user_id: user.userId, is_active: true },
          attributes: ['id', 'camera_name', 'device_type', 'is_online', 'label'],
        });
        callback?.({ devices: devices.map((d) => d.toJSON()) });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    // --- Tier 2: Room events (unchanged) ---
    socket.on('room:join', async ({ roomSlug }: { roomSlug: string }, callback) => {
      try {
        console.log(`[room:join] ${user.nickname}:${deviceId} joining ${roomSlug}`);
        const roomMedia = await mediasoupManager.getOrCreateRoom(roomSlug);
        currentRoomId = roomSlug;

        socket.join(roomSlug);

        const participants = getRoomParticipants(roomSlug);
        const participantKey = `${user.userId}:${deviceId}`;

        // Reconnect path: cancel any pending grace-leave and tear down the stale entry
        // (transports/producers from the dropped socket) before re-registering.
        const lk = leaveKey(roomSlug, user.userId, deviceId);
        const pending = pendingLeaves.get(lk);
        if (pending) {
          clearTimeout(pending.timer);
          pendingLeaves.delete(lk);
        }
        const stale = participants.get(participantKey);
        if (stale) {
          const ids: string[] = [];
          if (stale.sendTransportId) ids.push(stale.sendTransportId);
          if (stale.recvTransportId) ids.push(stale.recvTransportId);
          mediasoupManager.cleanupTransports(roomSlug, ids);
          for (const pid of stale.producerIds) {
            socket.to(roomSlug).emit('media:producerClosed', { producerId: pid, userId: user.userId, deviceId });
          }
        }

        const participant: Participant = {
          userId: user.userId,
          nickname: user.nickname,
          deviceId,
          deviceLabel,
          socketId: socket.id,
          producerIds: [],
        };
        participants.set(participantKey, participant);

        const existingProducers: any[] = [];
        const room = mediasoupManager.getRoom(roomSlug);
        if (room) {
          for (const [producerId, producer] of room.producers) {
            const ownerEntry = [...participants.entries()].find(([_, p]) =>
              p.producerIds.includes(producerId)
            );
            if (ownerEntry) {
              existingProducers.push({
                producerId,
                userId: ownerEntry[1].userId,
                deviceId: ownerEntry[1].deviceId,
                deviceLabel: ownerEntry[1].deviceLabel,
                kind: producer.kind,
                appData: producer.appData,
              });
            }
          }
        }

        socket.to(roomSlug).emit('room:participantJoined', {
          userId: user.userId,
          nickname: user.nickname,
          deviceId,
          deviceLabel,
        });

        // Broadcast camera status to user's other devices
        socket.to(`user:${user.userId}`).emit('camera:statusUpdate', {
          deviceId,
          isInRoom: true,
          roomSlug,
        });

        const turnCredentials = generateTurnCredentials(user.userId);

        const participantList = [...participants.values()].map((p) => ({
          userId: p.userId,
          nickname: p.nickname,
          deviceId: p.deviceId,
          deviceLabel: p.deviceLabel,
        }));

        const roomRow = await Room.findOne({ where: { slug: roomSlug }, attributes: ['owner_id'] });
        const isOwner = !!roomRow && roomRow.owner_id === user.userId;

        console.log(`[room:join] ${user.nickname}:${deviceId} joined OK (${participantList.length} participants, ${existingProducers.length} producers)`);
        callback({
          participants: participantList,
          existingProducers,
          iceServers: turnCredentials.iceServers,
          isOwner,
        });
      } catch (err: any) {
        console.error(`[room:join] ERROR for ${user.nickname}:${deviceId}:`, err.message);
        callback({ error: err.message });
      }
    });

    socket.on('media:getRouterRtpCapabilities', async (_, callback) => {
      console.log(`[media:getRtpCaps] ${user.nickname}:${deviceId} room=${currentRoomId}`);
      if (!currentRoomId) return callback({ error: 'Not in a room' });
      const caps = mediasoupManager.getRouterRtpCapabilities(currentRoomId);
      callback({ rtpCapabilities: caps });
    });

    socket.on('media:createSendTransport', async (_, callback) => {
      try {
        console.log(`[media:createSendTransport] ${user.nickname}:${deviceId} room=${currentRoomId}`);
        if (!currentRoomId) return callback({ error: 'Not in a room' });
        const transportOptions = await mediasoupManager.createWebRtcTransport(currentRoomId);

        const participants = getRoomParticipants(currentRoomId);
        const key = `${user.userId}:${deviceId}`;
        const participant = participants.get(key);
        if (participant) participant.sendTransportId = transportOptions.id;

        callback(transportOptions);
      } catch (err: any) {
        callback({ error: err.message });
      }
    });

    socket.on('media:createRecvTransport', async (_, callback) => {
      try {
        console.log(`[media:createRecvTransport] ${user.nickname}:${deviceId} room=${currentRoomId}`);
        if (!currentRoomId) return callback({ error: 'Not in a room' });
        const transportOptions = await mediasoupManager.createWebRtcTransport(currentRoomId);

        const participants = getRoomParticipants(currentRoomId);
        const key = `${user.userId}:${deviceId}`;
        const participant = participants.get(key);
        if (participant) participant.recvTransportId = transportOptions.id;

        callback(transportOptions);
      } catch (err: any) {
        callback({ error: err.message });
      }
    });

    socket.on('media:restartIce', async ({ transportId }, callback) => {
      try {
        if (!currentRoomId) return callback({ error: 'Not in a room' });
        const iceParameters = await mediasoupManager.restartIce(currentRoomId, transportId);
        callback({ iceParameters });
      } catch (err: any) {
        callback({ error: err.message });
      }
    });

    socket.on('media:connectTransport', async ({ transportId, dtlsParameters }, callback) => {
      try {
        console.log(`[media:connectTransport] ${user.nickname}:${deviceId} transport=${transportId.slice(0,8)} room=${currentRoomId}`);
        if (!currentRoomId) return callback({ error: 'Not in a room' });
        await mediasoupManager.connectTransport(currentRoomId, transportId, dtlsParameters);
        callback({});
      } catch (err: any) {
        callback({ error: err.message });
      }
    });

    socket.on('media:produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
      try {
        console.log(`[media:produce] ${user.nickname}:${deviceId} kind=${kind} room=${currentRoomId}`);
        if (!currentRoomId) return callback({ error: 'Not in a room' });

        const producer = await mediasoupManager.produce(
          currentRoomId,
          transportId,
          kind,
          rtpParameters,
          { ...appData, userId: user.userId, deviceId, deviceLabel }
        );

        const participants = getRoomParticipants(currentRoomId);
        const key = `${user.userId}:${deviceId}`;
        const participant = participants.get(key);
        if (participant) participant.producerIds.push(producer.id);

        socket.to(currentRoomId).emit('media:newProducer', {
          producerId: producer.id,
          userId: user.userId,
          deviceId,
          deviceLabel,
          kind: producer.kind,
          appData: producer.appData,
        });

        callback({ producerId: producer.id });
      } catch (err: any) {
        callback({ error: err.message });
      }
    });

    socket.on('media:consume', async ({ producerId, rtpCapabilities }, callback) => {
      try {
        console.log(`[media:consume] ${user.nickname}:${deviceId} consuming ${producerId} room=${currentRoomId}`);
        if (!currentRoomId) return callback({ error: 'Not in a room' });

        const participants = getRoomParticipants(currentRoomId);
        const key = `${user.userId}:${deviceId}`;
        const participant = participants.get(key);
        if (!participant?.recvTransportId) return callback({ error: 'No recv transport' });

        const consumer = await mediasoupManager.consume(
          currentRoomId,
          participant.recvTransportId,
          producerId,
          rtpCapabilities
        );

        callback({
          consumerId: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          appData: consumer.appData,
        });
      } catch (err: any) {
        callback({ error: err.message });
      }
    });

    socket.on('media:resumeConsumer', async ({ consumerId }, callback) => {
      try {
        if (!currentRoomId) return callback?.({ error: 'Not in a room' });
        await mediasoupManager.resumeConsumer(currentRoomId, consumerId);
        callback?.({});
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('media:pauseConsumer', async ({ consumerId }, callback) => {
      try {
        if (!currentRoomId) return callback?.({ error: 'Not in a room' });
        await mediasoupManager.pauseConsumer(currentRoomId, consumerId);
        callback?.({});
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('media:pauseProducer', async ({ producerId }, callback) => {
      try {
        if (!currentRoomId) return callback?.({ error: 'Not in a room' });
        await mediasoupManager.pauseProducer(currentRoomId, producerId);
        socket.to(currentRoomId).emit('media:producerPaused', { producerId });
        callback?.({});
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('media:resumeProducer', async ({ producerId }, callback) => {
      try {
        if (!currentRoomId) return callback?.({ error: 'Not in a room' });
        await mediasoupManager.resumeProducer(currentRoomId, producerId);
        socket.to(currentRoomId).emit('media:producerResumed', { producerId });
        callback?.({});
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('media:closeProducer', async ({ producerId }) => {
      if (!currentRoomId) return;
      await mediasoupManager.closeProducer(currentRoomId, producerId);

      const participants = getRoomParticipants(currentRoomId);
      const key = `${user.userId}:${deviceId}`;
      const participant = participants.get(key);
      if (participant) {
        participant.producerIds = participant.producerIds.filter((id) => id !== producerId);
      }

      socket.to(currentRoomId).emit('media:producerClosed', {
        producerId,
        userId: user.userId,
        deviceId,
      });
    });

    socket.on('media:setPreferredLayers', async ({ consumerId, spatialLayer, temporalLayer }) => {
      if (!currentRoomId) return;
      await mediasoupManager.setPreferredLayers(currentRoomId, consumerId, spatialLayer, temporalLayer);
    });

    // Client-driven stall recovery: a viewer's video element is frozen → pull a keyframe.
    socket.on('media:requestKeyFrame', async ({ consumerId }) => {
      if (!currentRoomId) return;
      await mediasoupManager.requestConsumerKeyFrame(currentRoomId, consumerId);
    });

    socket.on('room:leave', () => {
      handleRoomLeave();
    });

    // Owner ends the room for everyone: soft-delete + notify + tear down.
    socket.on('room:close', async (_, callback) => {
      try {
        if (!currentRoomId) return callback?.({ error: 'Not in a room' });
        const room = await Room.findOne({
          where: { slug: currentRoomId, owner_id: user.userId },
        });
        if (!room) return callback?.({ error: '방장만 방을 종료할 수 있습니다' });
        await room.update({ is_active: false });
        const slug = currentRoomId;
        currentRoomId = null;
        await forceCloseRoom(slug);
        callback?.({ success: true });
      } catch (err: any) {
        callback?.({ error: err.message });
      }
    });

    socket.on('disconnect', (reason) => {
      handleDisconnect(reason);
    });

    // Explicit leave (user pressed 나가기): remove immediately, no grace.
    function handleRoomLeave() {
      if (!currentRoomId) return;
      const roomId = currentRoomId;
      const lk = leaveKey(roomId, user.userId, deviceId);
      const pending = pendingLeaves.get(lk);
      if (pending) {
        clearTimeout(pending.timer);
        pendingLeaves.delete(lk);
      }
      performParticipantLeave(roomId, user.userId, deviceId);
      socket.leave(roomId);
      currentRoomId = null;
    }

    async function handleDisconnect(reason?: string) {
      // Defer the room removal: a reconnect within GRACE_MS cancels it (see room:join).
      if (currentRoomId) {
        const roomId = currentRoomId;
        const lk = leaveKey(roomId, user.userId, deviceId);
        const existing = pendingLeaves.get(lk);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(() => {
          pendingLeaves.delete(lk);
          // Skip if the participant already rejoined on a different socket.
          const p = roomParticipants.get(roomId)?.get(`${user.userId}:${deviceId}`);
          if (p && p.socketId !== socket.id) return;
          performParticipantLeave(roomId, user.userId, deviceId);
        }, GRACE_MS);
        pendingLeaves.set(lk, { timer, socketId: socket.id });
        currentRoomId = null;
      }

      if (deviceId) {
        await Device.update(
          { is_online: false, socket_id: null },
          { where: { id: deviceId, user_id: user.userId } }
        );

        socket.to(`user:${user.userId}`).emit('device:offline', {
          deviceId,
        });
      }

      console.log(`Socket disconnected: ${socket.id} (${user.nickname}) reason=${reason}`);
    }
  });
}
