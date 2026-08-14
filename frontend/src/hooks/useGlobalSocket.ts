import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useCameraStore } from '../stores/cameraStore';
import { useAlwaysOnCamera, buildCameraListPayload, applyRemoteLensSwitch } from '../services/alwaysOnCamera';
import { getSocket, disconnectSocket } from '../lib/socket';
import { useBackgroundCamera } from '../services/backgroundCamera';
import { setupPreviewStreamer, setupCameraChangeListener, cleanupAllOutgoing } from '../services/previewStream';

let initialized = false;

/**
 * Should this device hold the camera open the whole time it's logged in?
 *
 * Phones/tablets are the ones that get parked as a remote camera, and their tab can be
 * backgrounded (screen off) when another device asks them to start — getUserMedia is unreliable
 * there, so they keep the stream warm, as before.
 *
 * A desktop/laptop is the machine you're sitting at. Holding a 1080p30 webcam open while you're
 * on the home page costs real battery (camera + ISP + the decode/paint of its preview) and buys
 * nothing: every consumer (room join, camera preview request, remote start, camera:powerOn)
 * already calls start() on demand, and a desktop is awake when it's asked. So it acquires lazily.
 */
const CAMERA_STANDBY = /Mobi|Android|iPhone|iPad|iPod/i.test(
  typeof navigator === 'undefined' ? '' : navigator.userAgent
);

/** Unsubscribe for the camera-active broadcaster; torn down on logout with the socket. */
let unsubCameraActive: (() => void) | null = null;

export function useGlobalSocket() {
  const token = useAuthStore((s) => s.token);
  const deviceId = useAuthStore((s) => s.deviceId);
  const bgCamera = useBackgroundCamera();

  // Initialize on login
  useEffect(() => {
    if (!token || initialized) return;
    initialized = true;

    const socket = getSocket();
    const { fetchCameras } = useCameraStore.getState();

    const broadcastCameraState = (isActive: boolean) => {
      if (!socket.connected) return;
      socket.emit('camera:activeStatusUpdate', { isActive });
      const payload = buildCameraListPayload();
      if (payload.cameraCount > 0) socket.emit('camera:cameraListUpdate', payload);
    };

    if (CAMERA_STANDBY) {
      useAlwaysOnCamera.getState().start().then(() => broadcastCameraState(true));
    } else {
      // Lazy: no getUserMedia yet. enumerateDevices still lists the lenses (with labels, once
      // permission has been granted before), so peers see this device's camera roster; the
      // stream itself is acquired the moment something actually needs it.
      useAlwaysOnCamera.getState().enumerateCameras().then(() => broadcastCameraState(false));
    }

    // Because acquisition is now deferred, peers learn the camera came up (or went away) from
    // the store rather than from a single emit at login.
    let wasActive = useAlwaysOnCamera.getState().isActive;
    const unsubActive = useAlwaysOnCamera.subscribe((s) => {
      if (s.isActive === wasActive) return;
      wasActive = s.isActive;
      broadcastCameraState(s.isActive);
    });
    unsubCameraActive = unsubActive;

    // The device list reflects only currently-connected devices, so resync it whenever
    // one of my devices connects (appears) or disconnects (disappears).
    socket.on('device:online', () => {
      useCameraStore.getState().fetchCameras(deviceId);
    });

    socket.on('device:offline', () => {
      useCameraStore.getState().fetchCameras(deviceId);
    });

    socket.on('camera:statusUpdate', ({ deviceId: id, isInRoom, roomSlug }) => {
      useCameraStore.getState().updateCamera(id, { isInRoom, roomSlug });
    });

    socket.on('camera:activeStatusUpdate', ({ deviceId: id, isActive }) => {
      useCameraStore.getState().updateCamera(id, { isCameraActive: isActive });
    });

    socket.on('camera:startRequested', ({ roomSlug }) => {
      bgCamera.startStreaming(roomSlug);
    });

    socket.on('camera:stopRequested', () => {
      bgCamera.stopStreaming();
    });

    socket.on('camera:powerOn', async () => {
      await useAlwaysOnCamera.getState().start();
      socket.emit('camera:activeStatusUpdate', { isActive: true });
      const payload = buildCameraListPayload();
      if (payload.cameraCount > 0) socket.emit('camera:cameraListUpdate', payload);
    });

    socket.on('camera:powerOff', () => {
      useAlwaysOnCamera.getState().stop();
      socket.emit('camera:activeStatusUpdate', { isActive: false });
    });

    socket.on('camera:switchRequested', async ({ cameraIndex }: { cameraIndex?: number }) => {
      const changed = await applyRemoteLensSwitch(cameraIndex);
      if (!changed) return;
      // Re-broadcast the (possibly re-enumerated / re-zoomed) roster so peers' active lens matches.
      socket.emit('camera:activeStatusUpdate', { isActive: true });
      socket.emit('camera:cameraListUpdate', buildCameraListPayload());
    });

    socket.on('camera:cameraListUpdate', ({ deviceId: id, cameraCount, activeIndex, lenses }: any) => {
      useCameraStore.getState().updateCamera(id, {
        remoteCameraCount: cameraCount,
        remoteCameraActiveIndex: activeIndex,
        remoteLenses: lenses,
      });
    });

    setupPreviewStreamer();
    setupCameraChangeListener();
    fetchCameras(deviceId);
  }, [token]);

  // Cleanup on logout
  useEffect(() => {
    if (!token && initialized) {
      initialized = false;
      unsubCameraActive?.();
      unsubCameraActive = null;
      useAlwaysOnCamera.getState().stop();
      cleanupAllOutgoing();
      disconnectSocket();
    }
  }, [token]);
}
