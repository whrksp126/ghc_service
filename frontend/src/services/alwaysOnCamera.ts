import { create } from 'zustand';
import { micConstraints } from '../stores/audioSettings';
import {
  classifyCameras, expandWithZoom, activeLensKey, lensKey,
  type CameraLens, type Facing,
} from '../lib/cameraLenses';

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
  /** Real facing of the live track (from its settings) — drives the front/back flip on mobile,
   *  where the OTHER facing often isn't enumerated as a selectable deviceId. */
  activeFacing: Facing;
  /** Optical zoom range of the live BACK track when it exposes a sub-1.0 (ultra-wide) range;
   *  null otherwise. Drives the synthetic 0.5×/1× lenses (see expandWithZoom). */
  zoomCaps: { min: number; max: number } | null;
  /** Currently applied zoom ratio (1 = main lens). */
  activeZoom: number;
  /** Acquire the camera. `cameraDeviceId` pins an exact lens; otherwise `opts.facing` selects
   *  front/back by facingMode (reliable on mobile), falling back to the rear camera. A live audio
   *  track is preserved across re-acquire so a camera switch never kills the published mic. */
  start: (cameraDeviceId?: string, opts?: { facing?: 'user' | 'environment' }) => Promise<void>;
  stop: () => void;
  switchCamera: (cameraDeviceId: string) => Promise<void>;
  /** Flip to the given facing by facingMode (not deviceId) — works on Android Chrome even when the
   *  target camera isn't listed by enumerateDevices() until it's opened. */
  switchFacing: (facing: 'user' | 'environment') => Promise<void>;
  /** Apply an optical zoom ratio to the live track in place (no re-acquire, no SFU renegotiation). */
  applyZoom: (zoom: number) => Promise<void>;
  /** Select a lens by its UI key — `z:<zoom>` applies optical zoom, anything else switches deviceId. */
  selectLocalLens: (key: string) => Promise<void>;
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
  activeFacing: 'environment',
  zoomCaps: null,
  activeZoom: 1,

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

  start: async (cameraDeviceId?: string, opts?: { facing?: 'user' | 'environment' }) => {
    const wantFacing = opts?.facing;
    const existing = get().stream;
    // Reuse only if the existing stream still has a LIVE video track. A stream whose
    // camera track ended (tab backgrounded, device switched, page transition) keeps
    // `active === true` as long as any track lives, which previously left the lobby
    // preview bound to a dead track → black screen. Re-acquire in that case.
    const videoLive = !!existing && existing.getVideoTracks().some((t) => t.readyState === 'live');
    if (existing && existing.active && videoLive && !cameraDeviceId && !wantFacing) {
      set({ isActive: true, error: null });
      return;
    }

    // A start is already acquiring (and we're not switching to a specific lens/facing) — wait for
    // it instead of firing a second getUserMedia that would fail with NotReadableError.
    if (inFlight && !cameraDeviceId && !wantFacing) {
      return inFlight;
    }

    inFlight = (async () => {
      // Preserve a LIVE audio track across the video re-acquire. The published mic is the audio
      // track of this stream; stopping it (the old code stopped ALL tracks) silently killed the
      // mic on every camera/lens/facing switch. Keep it alive and reuse it; only re-request audio
      // when none is live.
      const liveAudio = existing?.getAudioTracks().find((t) => t.readyState === 'live') ?? null;
      // Stop only the existing VIDEO tracks (free the camera); leave audio untouched.
      if (existing) {
        existing.getVideoTracks().forEach((t) => t.stop());
      }

      try {
        // Phones capture 720p (sustainable uplink + clean HW H.264 single-stream); desktops
        // capture 1080p for the sharp simulcast top layer.
        const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const w = isMobile ? 1280 : 1920;
        const h = isMobile ? 720 : 1080;
        const base = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30, max: 30 } };
        // deviceId pins an exact lens; facing picks front/back via facingMode (ideal, so a device
        // with only one camera doesn't OverconstrainedError); default = rear.
        const videoConstraints: MediaTrackConstraints = cameraDeviceId
          ? { deviceId: { exact: cameraDeviceId }, ...base }
          : wantFacing
            ? { facingMode: { ideal: wantFacing }, ...base }
            : { facingMode: 'environment', ...base };

        const gum = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: liveAudio ? false : micConstraints(),
        });

        const videoTrack = gum.getVideoTracks()[0];
        // Reuse the preserved mic, else take the freshly-acquired one. Combine into one stream.
        const audioTrack = liveAudio ?? gum.getAudioTracks()[0] ?? null;
        const stream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);

        const settings = videoTrack?.getSettings();
        const activeCamId = settings?.deviceId || cameraDeviceId || null;

        // Detect an optical ultra-wide on the BACK lens (Android 11+ CONTROL_ZOOM_RATIO): a zoom
        // range whose min < 1.0 can only be reached with a real wide-angle lens, so it's the one
        // genuinely-optical extra lens the web exposes. Front cameras don't get this. `zoom` is a
        // Chrome-only constrainable not in the standard TS lib types → cast through any.
        const facing = (settings?.facingMode as Facing | undefined) || wantFacing || undefined;
        const caps = (videoTrack?.getCapabilities?.() as any)?.zoom as
          | { min: number; max: number }
          | undefined;
        const zoomCaps =
          caps && typeof caps.min === 'number' && caps.min < 1.0 && facing !== 'user'
            ? { min: caps.min, max: caps.max }
            : null;
        const activeZoom = (settings as any)?.zoom ?? 1;

        videoTrack.onended = () => {
          set({ isActive: false, stream: null, activeCameraId: null, zoomCaps: null, activeZoom: 1 });
        };

        set({
          stream, isActive: true, error: null, errorType: null,
          activeCameraId: activeCamId, activeFacing: facing ?? 'unknown', zoomCaps, activeZoom,
        });

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
    set({ stream: null, isActive: false, error: null, activeCameraId: null, zoomCaps: null, activeZoom: 1 });
  },

  switchCamera: async (cameraDeviceId: string) => {
    await get().start(cameraDeviceId);
  },

  switchFacing: async (facing: 'user' | 'environment') => {
    await get().start(undefined, { facing });
  },

  applyZoom: async (zoom: number) => {
    const track = get().stream?.getVideoTracks()[0];
    if (!track) return;
    try {
      // Mutates the live track in place — the SAME MediaStreamTrack stays published, so the SFU
      // and all viewers see the new field of view with no track replacement / renegotiation.
      await track.applyConstraints({ advanced: [{ zoom }] } as any);
      set({ activeZoom: zoom });
    } catch {
      // Device rejected the zoom (unsupported) — leave state untouched.
    }
  },

  selectLocalLens: async (key: string) => {
    if (key.startsWith('z:')) await get().applyZoom(parseFloat(key.slice(2)));
    else await get().switchCamera(key);
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

/**
 * The `camera:cameraListUpdate` payload for THIS device, computed over the zoom-expanded lens list
 * so peers index the same canonical order (front/back + optical 0.5×/1× chips). Used by every
 * broadcast site so device and peers stay in lockstep.
 */
export function buildCameraListPayload() {
  const { availableCameras, activeCameraId, zoomCaps, activeZoom } = useAlwaysOnCamera.getState();
  const expanded = expandWithZoom(availableCameras, { activeDeviceId: activeCameraId, zoom: zoomCaps });
  const activeKey = activeLensKey(expanded, activeCameraId, activeZoom);
  const activeIndex = Math.max(0, expanded.findIndex((c) => lensKey(c) === activeKey));
  return {
    cameraCount: expanded.length,
    activeIndex,
    lenses: expanded.map((c) => ({ facing: c.facing, zoomRank: c.zoomRank, zoom: c.zoom })),
  };
}

/**
 * Apply a peer's `camera:switchRequested`: resolve `cameraIndex` against the same zoom-expanded
 * list, then either applyZoom (synthetic optical lens on the live track) or switchCamera (real
 * deviceId). Falls back to cycling when no index is given. Returns false when there's nothing to
 * switch (≤1 lens). Lives here so the socket handler stays a thin relay over the canonical list.
 */
export async function applyRemoteLensSwitch(cameraIndex?: number): Promise<boolean> {
  const cam = useAlwaysOnCamera.getState();
  const expanded = expandWithZoom(cam.availableCameras, {
    activeDeviceId: cam.activeCameraId,
    zoom: cam.zoomCaps,
  });
  if (expanded.length <= 1) return false;

  let target: CameraLens;
  if (cameraIndex !== undefined && cameraIndex >= 0 && cameraIndex < expanded.length) {
    target = expanded[cameraIndex];
  } else {
    const curKey = activeLensKey(expanded, cam.activeCameraId, cam.activeZoom);
    const curIdx = expanded.findIndex((c) => lensKey(c) === curKey);
    target = expanded[(curIdx + 1) % expanded.length];
  }

  if (target.zoom != null && target.deviceId === cam.activeCameraId) {
    await cam.applyZoom(target.zoom);
  } else {
    await cam.switchCamera(target.deviceId);
    if (target.zoom != null) await useAlwaysOnCamera.getState().applyZoom(target.zoom);
  }
  return true;
}
