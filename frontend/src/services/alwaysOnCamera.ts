import { create } from 'zustand';
import { micConstraints } from '../stores/audioSettings';

export interface LocalCamera {
  deviceId: string;
  label: string;
  facing: 'user' | 'environment' | 'unknown';
}

interface AlwaysOnCameraState {
  stream: MediaStream | null;
  isActive: boolean;
  error: string | null;
  errorType: 'permission' | 'other' | null;
  availableCameras: LocalCamera[];
  activeCameraId: string | null;
  start: (cameraDeviceId?: string) => Promise<void>;
  stop: () => void;
  switchCamera: (cameraDeviceId: string) => Promise<void>;
  enumerateCameras: () => Promise<void>;
  getVideoTrack: () => MediaStreamTrack | null;
  getAudioTrack: () => MediaStreamTrack | null;
}

function guessFacing(label: string): 'user' | 'environment' | 'unknown' {
  const l = label.toLowerCase();
  if (l.includes('front') || l.includes('전면') || l.includes('facetime') || l.includes('user')) return 'user';
  if (l.includes('back') || l.includes('rear') || l.includes('후면') || l.includes('environment')) return 'environment';
  return 'unknown';
}

export const useAlwaysOnCamera = create<AlwaysOnCameraState>()((set, get) => ({
  stream: null,
  isActive: false,
  error: null,
  errorType: null,
  availableCameras: [],
  activeCameraId: null,

  enumerateCameras: async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const seen = new Set<string>();
      const cameras: LocalCamera[] = [];
      let idx = 0;
      for (const d of devices) {
        if (d.kind !== 'videoinput') continue;
        if (d.deviceId && seen.has(d.deviceId)) continue;
        if (d.deviceId) seen.add(d.deviceId);
        cameras.push({
          deviceId: d.deviceId,
          label: d.label || `카메라 ${idx + 1}`,
          facing: guessFacing(d.label),
        });
        idx++;
      }
      set({ availableCameras: cameras });
    } catch {
      set({ availableCameras: [] });
    }
  },

  start: async (cameraDeviceId?: string) => {
    const existing = get().stream;
    // Reuse only if the existing stream still has a LIVE video track. A stream whose
    // camera track ended (tab backgrounded, device switched, page transition) keeps
    // `active === true` as long as any track lives, which previously left the lobby
    // preview bound to a dead track → black screen. Re-acquire in that case.
    const videoLive = !!existing && existing.getVideoTracks().some((t) => t.readyState === 'live');
    if (existing && existing.active && videoLive && !cameraDeviceId) {
      set({ isActive: true, error: null });
      return;
    }

    // Stop existing stream if switching
    if (existing) {
      existing.getTracks().forEach((t) => t.stop());
    }

    try {
      // Phones capture 720p (sustainable uplink + clean HW H.264 single-stream); desktops
      // capture 1080p for the sharp simulcast top layer.
      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      const w = isMobile ? 1280 : 1920;
      const h = isMobile ? 720 : 1080;
      const videoConstraints: MediaTrackConstraints = cameraDeviceId
        ? { deviceId: { exact: cameraDeviceId }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30, max: 30 } }
        : { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30, max: 30 }, facingMode: 'environment' };

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: micConstraints(),
      });

      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack?.getSettings();
      const activeCamId = settings?.deviceId || cameraDeviceId || null;

      videoTrack.onended = () => {
        set({ isActive: false, stream: null, activeCameraId: null });
      };

      set({ stream, isActive: true, error: null, errorType: null, activeCameraId: activeCamId });

      // Enumerate after getting permission (labels available after getUserMedia)
      await get().enumerateCameras();
    } catch (err: any) {
      const isPermission = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
      set({
        error: err.message || '카메라 접근이 거부되었습니다',
        errorType: isPermission ? 'permission' : 'other',
        isActive: false,
      });
    }
  },

  stop: () => {
    const { stream } = get();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    set({ stream: null, isActive: false, error: null, activeCameraId: null });
  },

  switchCamera: async (cameraDeviceId: string) => {
    await get().start(cameraDeviceId);
  },

  getVideoTrack: () => {
    const { stream } = get();
    return stream?.getVideoTracks()[0] ?? null;
  },

  getAudioTrack: () => {
    const { stream } = get();
    return stream?.getAudioTracks()[0] ?? null;
  },
}));
