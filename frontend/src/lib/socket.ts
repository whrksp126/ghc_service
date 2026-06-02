import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config/constants';
import { useAuthStore } from '../stores/authStore';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;

  const { token, deviceId, deviceLabel } = useAuthStore.getState();

  socket = io(SOCKET_URL, {
    auth: { token },
    query: { deviceId: deviceId || '', deviceLabel: deviceLabel || '' },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    reconnectionAttempts: 20,
    transports: ['websocket', 'polling'],
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

export function emitWithAck<T>(event: string, data: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = getSocket();

    const send = () => {
      s.emit(event, data, (response: T & { error?: string }) => {
        if (response && typeof response === 'object' && 'error' in response) {
          reject(new Error(response.error as string));
        } else {
          resolve(response);
        }
      });
    };

    // Fast path: already connected.
    if (s.connected) { send(); return; }

    // Otherwise the socket is still connecting (e.g. right after creating a room and
    // entering, before the global socket finished its handshake). Wait for 'connect'
    // instead of failing — with a safety timeout so a truly dead socket still rejects.
    const onConnect = () => { clearTimeout(timer); send(); };
    const timer = setTimeout(() => {
      s.off('connect', onConnect);
      reject(new Error('Socket not connected'));
    }, 8000);
    s.once('connect', onConnect);
  });
}
