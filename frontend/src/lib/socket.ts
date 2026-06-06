import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config/constants';
import { useAuthStore } from '../stores/authStore';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;

  const { token, deviceId, deviceLabel } = useAuthStore.getState();

  // In the Electron desktop shell the page is served through the Vite dev proxy, whose
  // long-lived tunnel is unreliable in Electron — WS frames get dropped and the server's
  // tight ping (pingTimeout 5s) then fires "ping timeout", kicking the user out of the
  // room right after joining. Connect Socket.IO straight to the backend instead (sub-ms
  // latency, no proxy). `apiBase` is injected by the desktop preload. Browsers/PWA keep
  // the same-origin connection through the proxy.
  const native = (window as unknown as { longdcamNative?: { platform?: string; apiBase?: string } }).longdcamNative;
  const url = native?.platform === 'desktop' && native.apiBase ? native.apiBase : SOCKET_URL;

  socket = io(url, {
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
      // Bound the ack wait — without a timeout, a lost emit (socket dies mid-flight)
      // hangs the join forever ("방에 참여하는 중..." never resolves).
      let acked = false;
      const ackTimer = setTimeout(() => {
        if (acked) return;
        reject(new Error('서버 응답 시간 초과'));
      }, 10000);
      s.emit(event, data, (response: T & { error?: string }) => {
        acked = true;
        clearTimeout(ackTimer);
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
