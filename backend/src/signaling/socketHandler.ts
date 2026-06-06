import { Server, Socket } from 'socket.io';
import { verifyToken, JwtPayload } from '../middleware/auth';
import { generateTurnCredentials } from '../config/turn';
import { createJoinToken, deleteLivekitRoom } from '../services/livekitService';
import { Device, Room } from '../models';

// Media (tracks/transports) now lives entirely in LiveKit. This handler keeps the
// app-level concerns: device presence, cross-device remote control, P2P preview
// signaling, the room roster, and the owner room-close lifecycle. The only media
// touch-point is minting a LiveKit join token on room:join.
interface Participant {
  userId: string;
  nickname: string;
  deviceId: string;
  deviceLabel: string;
  socketId: string;
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

  if (participants?.has(key)) {
    participants.delete(key);
  }

  ioRef?.to(roomId).emit('room:participantLeft', { userId, deviceId });
  ioRef?.to(`user:${userId}`).emit('camera:statusUpdate', { deviceId, isInRoom: false, roomSlug: null });

  if (participants && participants.size === 0) {
    roomParticipants.delete(roomId);
  }
}

/**
 * Force-terminate a room: notify everyone, tear down the LiveKit room, drop state.
 * Called both by the in-room owner (room:close socket event) and the REST delete route.
 */
export async function forceCloseRoom(roomSlug: string) {
  if (ioRef) ioRef.to(roomSlug).emit('room:closed', { roomSlug });
  await deleteLivekitRoom(roomSlug);
  roomParticipants.delete(roomSlug);
  if (ioRef) ioRef.in(roomSlug).socketsLeave(roomSlug);
}

export function setupSocketHandlers(io: Server) {
  ioRef = io;

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

    socket.on('camera:cameraListUpdate', ({ cameraCount, activeIndex, lenses }) => {
      socket.to(`user:${user.userId}`).emit('camera:cameraListUpdate', {
        deviceId,
        cameraCount,
        activeIndex,
        // Per-lens facing/zoom metadata so peers render the same front/back + lens UI.
        // Optional — older clients omit it and peers fall back to a plain lens count.
        lenses,
      });
    });

    // --- P2P preview signaling (independent of room media — still uses coturn) ---
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

    // --- Tier 2: Room events ---
    // Joining returns a LiveKit token; the client connects to the SFU directly with it.
    socket.on('room:join', async ({ roomSlug }: { roomSlug: string }, callback) => {
      try {
        console.log(`[room:join] ${user.nickname}:${deviceId} joining ${roomSlug}`);

        const roomRow = await Room.findOne({
          where: { slug: roomSlug },
          attributes: ['owner_id', 'is_active'],
        });
        if (!roomRow || !roomRow.is_active) {
          return callback({ error: '방을 찾을 수 없습니다' });
        }

        currentRoomId = roomSlug;
        socket.join(roomSlug);

        const participants = getRoomParticipants(roomSlug);
        const participantKey = `${user.userId}:${deviceId}`;

        // Reconnect path: cancel any pending grace-leave before re-registering.
        const lk = leaveKey(roomSlug, user.userId, deviceId);
        const pending = pendingLeaves.get(lk);
        if (pending) {
          clearTimeout(pending.timer);
          pendingLeaves.delete(lk);
        }

        const participant: Participant = {
          userId: user.userId,
          nickname: user.nickname,
          deviceId,
          deviceLabel,
          socketId: socket.id,
        };
        participants.set(participantKey, participant);

        socket.to(roomSlug).emit('room:participantJoined', {
          userId: user.userId,
          nickname: user.nickname,
          deviceId,
          deviceLabel,
        });

        // Tell the user's other (out-of-room) devices that this one is now live.
        socket.to(`user:${user.userId}`).emit('camera:statusUpdate', {
          deviceId,
          isInRoom: true,
          roomSlug,
        });

        const participantList = [...participants.values()].map((p) => ({
          userId: p.userId,
          nickname: p.nickname,
          deviceId: p.deviceId,
          deviceLabel: p.deviceLabel,
        }));

        const isOwner = roomRow.owner_id === user.userId;

        const token = await createJoinToken({
          roomName: roomSlug,
          userId: user.userId,
          deviceId,
          nickname: user.nickname,
          deviceLabel,
        });

        console.log(`[room:join] ${user.nickname}:${deviceId} joined OK (${participantList.length} participants)`);
        callback({
          participants: participantList,
          isOwner,
          token,
        });
      } catch (err: any) {
        console.error(`[room:join] ERROR for ${user.nickname}:${deviceId}:`, err.message);
        callback({ error: err.message });
      }
    });

    // Leaving (incl. the owner) only drops this participant — it never tears down the
    // room or the LiveKit RTMP ingress. This is deliberate: a native/OBS live keeps
    // streaming after the owner leaves the call (the ingress is still a publisher, so
    // the room stays non-empty). Only room:close (below) ends the live. Do NOT add
    // teardown here.
    socket.on('room:leave', () => {
      handleRoomLeave();
    });

    // Owner ends the room for everyone: soft-delete + notify + tear down (also stops
    // any live ingress, since the LiveKit room is deleted). This is the only explicit
    // end-everything path besides the REST delete route.
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
