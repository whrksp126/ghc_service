import { create } from 'zustand';
import { micConstraints } from '../stores/audioSettings';
import { classifyCameras, type CameraLens, type Facing } from '../lib/cameraLenses';

// De-dupes concurrent camera acquisitions. On a cold load into /room, the global socket
// init and the room lobby both call start() — two parallel getUserMedia calls make the
// second fail with NotReadableError ("camera already in use"), breaking the preview.
let inFlight: Promise<void> | null = null;

// LocalCamera is the cleaned lens shape from the shared classifier (facing + zoom inferred,
// virtual combo cameras dropped). `availableCameras` order is the canonical lens index.
export type LocalCamera = CameraLens;

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
      // The active track's real facingMode is the one signal we can trust on iOS, where labels
      // are opaque/localized — use it to fix the live camera's facing.
      const activeTrack = get().stream?.getVideoTracks()[0];
      const s = activeTrack?.getSettings();
      const activeFacing = (s?.facingMode as Facing | undefined) || undefined;
      const fresh = classifyCameras(devices, {
        activeDeviceId: get().activeCameraId,
        activeFacing,
      });

      // Android exposes only a SUBSET of lenses per enumerate call (it depends on which camera
      // is currently open), so replacing the list drops lenses that were visible a moment ago.
      // Accumulate instead: once a lens has been seen it stays (its facing/zoom refreshed from
      // the latest read). Switching cameras re-enumerates and fills in the rest. Only merge once
      // we have real deviceIds — pre-permission entries have empty ids and shouldn't accumulate.
      const prev = get().availableCameras;
      const haveIds = fresh.length > 0 && fresh.every((c) => c.deviceId);
      if (!haveIds || prev.length === 0) {
        set({ availableCameras: fresh });
        return;
      }
      const freshById = new Map(fresh.map((c) => [c.deviceId, c]));
      const merged: CameraLens[] = prev.map((p) => freshById.get(p.deviceId) ?? p);
      for (const c of fresh) if (!prev.some((p) => p.deviceId === c.deviceId)) merged.push(c);
      set({ availableCameras: merged });
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

    // A start is already acquiring (and we're not switching to a specific lens) — wait for
    // it instead of firing a second getUserMedia that would fail with NotReadableError.
    if (inFlight && !cameraDeviceId) {
      return inFlight;
    }

    inFlight = (async () => {
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
    })();

    try {
      await inFlight;
    } finally {
      inFlight = null;
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
