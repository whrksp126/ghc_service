import { useEffect, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { getSocket } from '../lib/socket';
import { useRoomStore } from '../stores/roomStore';
import { playSound } from '../lib/sounds';

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const { addParticipant, removeParticipant, setReconnecting } = useRoomStore();

  const connect = useCallback(() => {
    const socket = getSocket();
    socketRef.current = socket;

    // Idempotent: replace our handlers so re-entry / StrictMode double-invoke doesn't
    // stack duplicates. (off() only targets the room/presence events useSocket owns.)
    socket.off('connect').on('connect', () => setReconnecting(false));
    socket.off('disconnect').on('disconnect', () => setReconnecting(true));
    socket.off('reconnect').on('reconnect', () => setReconnecting(false));
    socket.off('room:participantJoined').on('room:participantJoined', (data) => {
      addParticipant(data);
      playSound('join');
    });
    socket.off('room:participantLeft').on('room:participantLeft', (data) => {
      removeParticipant(data.userId, data.deviceId);
      playSound('leave');
    });

    return socket;
  }, [addParticipant, removeParticipant, setReconnecting]);

  // IMPORTANT: only drop OUR listeners — never tear down the shared global socket
  // (it's owned by useGlobalSocket, created on login / destroyed on logout).
  // Destroying it here caused a connect → emit room:join → disconnect → recreate loop
  // that prevented joining a room (the room:join ack was lost every time).
  const disconnect = useCallback(() => {
    const socket = socketRef.current;
    if (socket) {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('reconnect');
      socket.off('room:participantJoined');
      socket.off('room:participantLeft');
    }
    socketRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { socket: socketRef, connect, disconnect };
}
