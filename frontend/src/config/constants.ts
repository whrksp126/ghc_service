const defaultUrl = import.meta.env.PROD
  ? window.location.origin
  : '';

export const API_URL = import.meta.env.VITE_API_URL || defaultUrl;
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || defaultUrl || window.location.origin;
// LiveKit signaling endpoint. Prod sets VITE_LIVEKIT_URL (wss://…). Local dev leaves it
// empty → same-origin `/livekit`, which the vite dev server proxies to livekit-server.
// Using the page's own origin means a phone on the LAN (https://<lan-ip>:3100) works
// without a hardcoded IP or a separate TLS cert.
export const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL
  || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/livekit`;
export const IS_PROD = import.meta.env.VITE_ENV === 'production';
