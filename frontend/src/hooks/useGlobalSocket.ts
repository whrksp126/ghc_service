import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useCameraStore } from '../stores/cameraStore';
import { useAlwaysOnCamera } from '../services/alwaysOnCamera';
import { getSocket, disconnectSocket } from '../lib/socket';
import { useBackgroundCamera } from '../services/backgroundCamera';
import { setupPreviewStreamer, setupCameraChangeListener, cleanupAllOutgoing } from '../services/previewStream';

let initialized = false;

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

    useAlwaysOnCamera.getState().start().then(() => {
      if (socket.connected) {
        socket.emit('camera:activeStatusUpdate', { isActive: true });
        const { availableCameras, activeCameraId } = useAlwaysOnCamera.getState();
        if (availableCameras.length > 0) {
          const activeIndex = availableCameras.findIndex((c) => c.deviceId === activeCameraId);
          socket.emit('camera:cameraListUpdate', {
            cameraCount: availableCameras.length,
            activeIndex: Math.max(0, activeIndex),
            lenses: availableCameras.map((c) => ({ facing: c.facing, zoomRank: c.zoomRank })),
          });
        }
      }
    });

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
      const { availableCameras, activeCameraId } = useAlwaysOnCamera.getState();
      if (availableCameras.length > 0) {
        const activeIndex = availableCameras.findIndex((c) => c.deviceId === activeCameraId);
        socket.emit('camera:cameraListUpdate', {
          cameraCount: availableCameras.length,
          activeIndex: Math.max(0, activeIndex),
          lenses: availableCameras.map((c) => ({ facing: c.facing, zoomRank: c.zoomRank })),
        });
      }
    });

    socket.on('camera:powerOff', () => {
      useAlwaysOnCamera.getState().stop();
      socket.emit('camera:activeStatusUpdate', { isActive: false });
    });

    socket.on('camera:switchRequested', async ({ cameraIndex }: { cameraIndex?: number }) => {
      const cam = useAlwaysOnCamera.getState();
      const { availableCameras, activeCameraId } = cam;
      if (availableCameras.length <= 1) return;

      let nextIdx: number;
      if (cameraIndex !== undefined && cameraIndex >= 0 && cameraIndex < availableCameras.length) {
        nextIdx = cameraIndex;
      } else {
        const currentIdx = availableCameras.findIndex((c) => c.deviceId === activeCameraId);
        nextIdx = (currentIdx + 1) % availableCameras.length;
      }

      await cam.switchCamera(availableCameras[nextIdx].deviceId);
      // Re-read the (possibly re-enumerated) roster so the lens metadata matches the new index.
      const after = useAlwaysOnCamera.getState().availableCameras;
      socket.emit('camera:activeStatusUpdate', { isActive: true });
      socket.emit('camera:cameraListUpdate', {
        cameraCount: after.length,
        activeIndex: nextIdx,
        lenses: after.map((c) => ({ facing: c.facing, zoomRank: c.zoomRank })),
      });
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
      useAlwaysOnCamera.getState().stop();
      cleanupAllOutgoing();
      disconnectSocket();
    }
  }, [token]);
}
