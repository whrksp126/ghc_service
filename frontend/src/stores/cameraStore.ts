import { create } from 'zustand';
import { api } from '../lib/api';
import type { Facing } from '../lib/cameraLenses';

/** Per-lens metadata a remote device reports so peers can show the same front/back + zoom UI. */
export interface RemoteLensMeta {
  facing: Facing;
  zoomRank: number;
  /** Optical zoom ratio for synthetic Android ultra-wide lenses (informational on the peer side). */
  zoom?: number;
}

export interface CameraDevice {
  id: string;
  cameraName: string;
  label: string;
  deviceType: string;
  isOnline: boolean;
  isInRoom: boolean;
  roomSlug: string | null;
  isCameraActive: boolean;
  isCurrentDevice: boolean;
  lastSeenAt: string | null;
  remoteCameraCount: number;
  remoteCameraActiveIndex: number;
  /** Classified lenses from the remote device (undefined for older clients → count fallback). */
  remoteLenses?: RemoteLensMeta[];
}

interface CameraState {
  cameras: CameraDevice[];
  loading: boolean;
  setCameras: (cameras: CameraDevice[]) => void;
  updateCamera: (deviceId: string, updates: Partial<CameraDevice>) => void;
  fetchCameras: (currentDeviceId: string | null) => Promise<void>;
}

export const useCameraStore = create<CameraState>()((set, get) => ({
  cameras: [],
  loading: false,

  setCameras: (cameras) => set({ cameras }),

  updateCamera: (deviceId, updates) =>
    set((state) => ({
      cameras: state.cameras.map((c) => (c.id === deviceId ? { ...c, ...updates } : c)),
    })),

  fetchCameras: async (currentDeviceId) => {
    set({ loading: true });
    try {
      const res = await api.getDevices();
      // The list only contains currently-online devices (backend filters by is_online),
      // so a refetch on connect/disconnect adds/removes devices live. Preserve the
      // runtime status (room/active/lens) we already track via socket events so a refetch
      // doesn't momentarily reset a device that's mid-stream.
      const prev = get().cameras;
      const cameras: CameraDevice[] = res.devices.map((d) => {
        const existing = prev.find((c) => c.id === d.id);
        return {
          id: d.id,
          cameraName: d.camera_name || d.label,
          label: d.label,
          deviceType: d.device_type,
          isOnline: d.is_online,
          isInRoom: existing?.isInRoom ?? false,
          roomSlug: existing?.roomSlug ?? null,
          isCameraActive: existing?.isCameraActive ?? false,
          isCurrentDevice: d.id === currentDeviceId,
          lastSeenAt: d.last_seen_at,
          remoteCameraCount: existing?.remoteCameraCount ?? 0,
          remoteCameraActiveIndex: existing?.remoteCameraActiveIndex ?? 0,
          remoteLenses: existing?.remoteLenses,
        };
      });
      // Always include THIS device. The REST list only has currently-online devices, and
      // on a cold load into /room the socket may not have marked us online yet — without
      // this, the lobby shows no preview and our own camera never gets published.
      if (currentDeviceId && !cameras.some((c) => c.id === currentDeviceId)) {
        const existing = prev.find((c) => c.id === currentDeviceId);
        const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        cameras.unshift({
          id: currentDeviceId,
          cameraName: existing?.cameraName || '이 기기',
          label: existing?.label || '',
          deviceType: existing?.deviceType || (isMobile ? 'phone' : 'desktop'),
          isOnline: true,
          isInRoom: existing?.isInRoom ?? false,
          roomSlug: existing?.roomSlug ?? null,
          isCameraActive: existing?.isCameraActive ?? false,
          isCurrentDevice: true,
          lastSeenAt: existing?.lastSeenAt ?? null,
          remoteCameraCount: existing?.remoteCameraCount ?? 0,
          remoteCameraActiveIndex: existing?.remoteCameraActiveIndex ?? 0,
          remoteLenses: existing?.remoteLenses,
        });
      }
      set({ cameras, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
