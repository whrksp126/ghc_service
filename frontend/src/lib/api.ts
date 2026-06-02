import { API_URL } from '../config/constants';
import { useAuthStore } from '../stores/authStore';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  register: (body: {
    email: string;
    password: string;
    nickname: string;
    deviceFingerprint: string;
    deviceType: string;
    deviceLabel: string;
  }) =>
    request<{
      token: string;
      user: { id: string; nickname: string; email: string };
      device: { id: string; label: string };
    }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) }),

  login: (body: {
    email: string;
    password: string;
    deviceFingerprint: string;
    deviceType: string;
    deviceLabel: string;
  }) =>
    request<{
      token: string;
      user: { id: string; nickname: string; email: string };
      device: { id: string; label: string };
    }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }),

  getMe: () =>
    request<{ user: { id: string; nickname: string; avatar_url: string | null; email: string | null } }>(
      '/api/auth/me'
    ),

  createRoom: (body: { name: string; pin?: string }) =>
    request<{ room: { id: string; name: string; slug: string; hasPin: boolean } }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getRoom: (slug: string) =>
    request<{
      room: { id: string; name: string; slug: string; hasPin: boolean; maxParticipants: number };
    }>(`/api/rooms/${slug}`),

  joinRoom: (slug: string, pin?: string, inviteToken?: string) =>
    request<{ room: { id: string; name: string; slug: string }; role: string }>(
      `/api/rooms/${slug}/join`,
      { method: 'POST', body: JSON.stringify({ pin, inviteToken }) }
    ),

  getMyRooms: () =>
    request<{ rooms: { id: string; name: string; slug: string; role: string; hasPin: boolean }[] }>(
      '/api/rooms'
    ),

  deleteRoom: (slug: string) =>
    request<{ success: boolean }>(`/api/rooms/${slug}`, { method: 'DELETE' }),

  renameRoom: (slug: string, name: string) =>
    request<{ room: { id: string; name: string; slug: string } }>(`/api/rooms/${slug}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  leaveRoom: (slug: string) =>
    request<{ success: boolean }>(`/api/rooms/${slug}/leave`, { method: 'POST' }),

  getDevices: () =>
    request<{
      devices: {
        id: string;
        label: string;
        camera_name: string;
        device_type: string;
        is_online: boolean;
        last_seen_at: string;
      }[];
    }>('/api/devices'),

  registerDevice: (body: { label: string; deviceFingerprint: string; deviceType: string }) =>
    request<{ device: { id: string; label: string } }>('/api/devices', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateDevice: (id: string, body: { label?: string; camera_name?: string }) =>
    request<{ device: { id: string; label: string; camera_name: string } }>(
      `/api/devices/${id}`,
      { method: 'PATCH', body: JSON.stringify(body) }
    ),

  createInvite: (slug: string) =>
    request<{ inviteToken: string; expiresAt: string }>(`/api/rooms/${slug}/invite`, {
      method: 'POST',
    }),

  // OBS live broadcast (RTMP ingress) — owner only.
  createIngress: (slug: string) =>
    request<{ ingress: { ingressId: string; url: string; streamKey: string } }>(
      `/api/rooms/${slug}/ingress`,
      { method: 'POST' }
    ),

  listIngress: (slug: string) =>
    request<{ ingresses: { ingressId: string; url: string; streamKey: string }[] }>(
      `/api/rooms/${slug}/ingress`
    ),

  deleteIngress: (slug: string, id: string) =>
    request<{ success: boolean }>(`/api/rooms/${slug}/ingress/${id}`, { method: 'DELETE' }),

  getMediaLibrary: () =>
    request<{ items: { key: string; name: string; size: number }[] }>('/api/media/library'),

  getMediaUrl: (key: string) =>
    request<{ url: string }>(`/api/media/library/url?key=${encodeURIComponent(key)}`),
};
