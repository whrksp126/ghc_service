import { io, Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config/constants';
import { useAuthStore } from '../stores/authStore';

let socket: Socket | null = null;
/** Credentials the cached socket handshook with. The server authenticates the token ONCE, at
 *  handshake — so a socket built with an old token can never recover, no matter how often it
 *  reconnects. Re-login (or a device re-register) must therefore rebuild the socket, not reuse it.
 *  Without this, an expired session left every later room join failing with "Socket not connected"
 *  even after the user logged in again. */
let socketAuthKey = '';
/** Last handshake rejection, so a failed emit can report WHY instead of a bare "not connected". */
let lastConnectError: string | null = null;

/** Handshake rejections from the server's io.use() gate. Retrying these is pointless — the stored
 *  session is simply no longer valid, so we drop to the login screen instead of a zombie session. */
const AUTH_REJECTIONS = ['No token', 'Invalid token', 'Invalid device'];

function authKeyOf(token: string | null, deviceId: string | null): string {
  return `${token ?? ''}|${deviceId ?? ''}`;
}

export function getSocket(): Socket {
  const { token, deviceId, deviceLabel } = useAuthStore.getState();
  const key = authKeyOf(token, deviceId);
  // Stale credentials → throw the old socket away (see socketAuthKey).
  if (socket && socketAuthKey !== key) disconnectSocket();
  if (socket) return socket;

  // In the Electron desktop shell the page is served through the Vite dev proxy, whose
  // long-lived tunnel is unreliable in Electron — WS frames get dropped and the server's
  // tight ping (pingTimeout 5s) then fires "ping timeout", kicking the user out of the
  // room right after joining. Connect Socket.IO straight to the backend instead (sub-ms
  // latency, no proxy). `apiBase` is injected by the desktop preload. Browsers/PWA keep
  // the same-origin connection through the proxy.
  const native = (window as unknown as { ghcNative?: { platform?: string; apiBase?: string } }).ghcNative;
  const url = native?.platform === 'desktop' && native.apiBase ? native.apiBase : SOCKET_URL;

  socket = io(url, {
    auth: { token },
    query: { deviceId: deviceId || '', deviceLabel: deviceLabel || '' },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    // Never stop retrying. A finite budget (was 20 ≈ 3 minutes) meant one long network outage —
    // or a laptop that slept — permanently killed signaling for the rest of the app's life, with
    // nothing on screen to say so. Auth rejections are handled below, so this can't spin forever
    // against a session the server will always refuse.
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling'],
  });
  socketAuthKey = key;

  socket.on('connect', () => { lastConnectError = null; });
  socket.on('connect_error', (err: Error) => {
    lastConnectError = err.message;
    console.error('[socket] connect_error:', err.message);
    if (!AUTH_REJECTIONS.includes(err.message)) return;
    // Expired/mismatched session: stop the retry loop and clear the auth state, which routes the
    // app to /login (ProtectedRoute) instead of leaving a logged-in-looking UI that can't signal.
    socket?.disconnect();
    useAuthStore.getState().logout();
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  socketAuthKey = '';
  lastConnectError = null;
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
    // A socket that already gave up (manual disconnect, or reconnection turned off) needs an
    // explicit kick, otherwise the wait below can only ever time out.
    if (s.disconnected) s.connect();
    const done = () => { clearTimeout(timer); s.off('connect', onConnect); s.off('connect_error', onError); };
    const onConnect = () => { done(); send(); };
    // A rejected session can never become connected, so don't make the user wait out the timeout
    // for it. Any other error (server down, network) keeps waiting — reconnection is on.
    const onError = (err: Error) => {
      if (!AUTH_REJECTIONS.includes(err.message)) return;
      done();
      reject(new Error('세션이 만료되었습니다. 다시 로그인해주세요.'));
    };
    const timer = setTimeout(() => {
      done();
      // Say what actually went wrong. The bare "Socket not connected" sent users hunting for a
      // network problem when the real cause was a rejected (expired) session.
      const reason = lastConnectError;
      reject(new Error(reason ? `서버에 연결할 수 없습니다 (${reason})` : '서버에 연결할 수 없습니다'));
    }, 8000);
    s.once('connect', onConnect);
    s.on('connect_error', onError);
  });
}
