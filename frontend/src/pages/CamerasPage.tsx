import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Smartphone, Camera,
  ChevronLeft, WifiOff, Power, RefreshCw,
  MoreHorizontal, Pencil,
} from 'lucide-react';
import { Button } from '../components/common/Button';
import { BottomSheet } from '../components/common/BottomSheet';
import { CameraLensControl, lensesFromLocal, lensesFromRemote } from '../components/common/CameraLensControl';
import { expandWithZoom, activeLensKey } from '../lib/cameraLenses';
import { showToast } from '../components/common/Toast';
import { useCameraStore, type RemoteLensMeta } from '../stores/cameraStore';
import { useAuthStore } from '../stores/authStore';
import { useAlwaysOnCamera } from '../services/alwaysOnCamera';
import { requestPreview, type PreviewConnection, type PreviewStatus } from '../services/previewStream';
import { getSocket } from '../lib/socket';
import { api } from '../lib/api';

function RemoteCameraPreview({
  camId,
  cameraName,
  isOnline,
  isCameraActive,
  remoteCameraCount,
  remoteCameraActiveIndex,
  remoteLenses,
  onEditName,
}: {
  camId: string;
  cameraName: string;
  isOnline: boolean;
  isCameraActive: boolean;
  remoteCameraCount: number;
  remoteCameraActiveIndex: number;
  remoteLenses?: RemoteLensMeta[];
  onEditName: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const connRef = useRef<PreviewConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>('connecting');
  const [powerToggling, setPowerToggling] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (previewStatus === 'live' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [previewStatus]);

  const connectPreview = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;
    streamRef.current = null;
    setPreviewStatus('connecting');

    connRef.current = requestPreview(
      camId,
      (stream) => {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      },
      () => {},
      (status) => setPreviewStatus(status),
    );
  }, [camId]);

  useEffect(() => {
    if (!isOnline) {
      setPreviewStatus('connecting');
      return;
    }

    connectPreview();

    return () => {
      connRef.current?.close();
      connRef.current = null;
    };
  }, [camId, isOnline, connectPreview]);

  function handleRetry() {
    if (!isOnline) return;
    connectPreview();
  }

  function handleTogglePower() {
    const socket = getSocket();
    if (!socket.connected) return;

    setPowerToggling(true);
    const event = isCameraActive ? 'camera:requestPowerOff' : 'camera:requestPowerOn';
    socket.emit(event, { targetDeviceId: camId }, (res: any) => {
      setPowerToggling(false);
      if (res?.error) showToast(res.error, 'error');
    });
  }

  function handleSwitchCamera(cameraIndex: number) {
    const socket = getSocket();
    if (!socket.connected) return;
    socket.emit('camera:requestSwitchCamera', { targetDeviceId: camId, cameraIndex }, (res: any) => {
      if (res?.error) showToast(res.error, 'error');
    });
  }

  return (
    <div className={`glass rounded-xl overflow-hidden ${!isOnline ? 'opacity-50' : ''}`}>
      <div className="bg-dark-800 relative">
        {previewStatus === 'live' && isOnline ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full block"
          />
        ) : (
          <div className="aspect-video flex items-center justify-center">
            {!isOnline ? (
              <div className="text-center text-white/20">
                <WifiOff className="w-10 h-10 mx-auto mb-1.5 opacity-30" strokeWidth={1.5} />
                <p className="text-xs">오프라인</p>
              </div>
            ) : previewStatus === 'no_camera' ? (
              <div className="text-center text-white/30">
                <Camera className="w-10 h-10 mx-auto mb-1.5 opacity-50" strokeWidth={1.5} />
                <p className="text-xs text-white/40 mb-2">카메라 꺼짐</p>
                <button
                  onClick={handleTogglePower}
                  disabled={powerToggling}
                  className="text-xs text-primary hover:text-primary-hover transition-colors disabled:opacity-50"
                >
                  카메라 켜기
                </button>
              </div>
            ) : previewStatus === 'failed' ? (
              <div className="text-center text-white/30">
                <Camera className="w-10 h-10 mx-auto mb-1.5 opacity-50" strokeWidth={1.5} />
                <p className="text-xs text-white/40 mb-2">연결 실패</p>
                <button
                  onClick={handleRetry}
                  className="flex items-center gap-1 mx-auto text-xs text-primary hover:text-primary-hover transition-colors"
                >
                  <RefreshCw size={12} />
                  다시 시도
                </button>
              </div>
            ) : (
              <div className="text-center text-white/30">
                <Camera className="w-10 h-10 mx-auto mb-1.5 opacity-50" strokeWidth={1.5} />
                <p className="text-xs text-white/40">연결 중...</p>
              </div>
            )}
          </div>
        )}

        {isOnline && (
          <button
            onClick={() => setSheetOpen(true)}
            disabled={powerToggling}
            className="absolute top-2 right-2 w-8 h-8 rounded-full flex items-center justify-center bg-black/45 backdrop-blur-sm text-white/80 hover:text-white transition-colors disabled:opacity-50"
            title="더보기"
          >
            <MoreHorizontal size={16} />
          </button>
        )}

        {/* On-viewer lens switcher (front/back + zoom) — same control as the room */}
        {previewStatus === 'live' && isOnline && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
            <CameraLensControl
              lenses={lensesFromRemote(remoteLenses, remoteCameraCount)}
              activeKey={String(remoteCameraActiveIndex)}
              onSelect={(key) => handleSwitchCamera(Number(key))}
            />
          </div>
        )}
      </div>

      <BottomSheet
        isOpen={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={cameraName}
        actions={[
          {
            icon: <Power size={18} />,
            label: isCameraActive ? '카메라 끄기' : '카메라 켜기',
            onClick: handleTogglePower,
            danger: isCameraActive,
            disabled: powerToggling,
          },
          { icon: <Pencil size={18} />, label: '이름 변경', onClick: onEditName },
        ]}
      />
    </div>
  );
}

export function CamerasPage() {
  const navigate = useNavigate();
  const { deviceId } = useAuthStore();
  const { cameras, fetchCameras } = useCameraStore();
  const {
    stream, isActive, availableCameras, activeCameraId, zoomCaps, activeZoom,
    selectLocalLens, enumerateCameras, start, stop,
  } = useAlwaysOnCamera();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [currentSheetOpen, setCurrentSheetOpen] = useState(false);
  const previewRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    fetchCameras(deviceId);
    enumerateCameras();
    // This page IS the camera preview, so acquire here. Devices that don't keep the camera on
    // standby (desktops — see CAMERA_STANDBY in useGlobalSocket) otherwise land on "카메라 꺼짐".
    start();
  }, [deviceId, fetchCameras, enumerateCameras, start]);

  useEffect(() => {
    if (previewRef.current) {
      previewRef.current.srcObject = stream || null;
    }
  }, [stream, activeCameraId]);

  function startEditing(camId: string, currentName: string) {
    setEditingId(camId);
    setEditName(currentName);
  }

  async function saveName(camId: string) {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      await api.updateDevice(camId, { camera_name: editName.trim() });
      await fetchCameras(deviceId);
      setEditingId(null);
      showToast('카메라 이름이 변경되었습니다', 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  const currentDevice = cameras.find((c) => c.isCurrentDevice);
  const otherDevices = cameras.filter((c) => !c.isCurrentDevice);

  return (
    <div className="min-h-screen bg-dark-900 flex flex-col">
      <header className="p-6 flex items-center justify-between">
        <button onClick={() => navigate('/')} className="text-white/50 hover:text-white transition-colors">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-lg font-display font-bold">카메라 관리</h1>
        <div className="w-6" />
      </header>

      <main className="flex-1 px-6 pb-20 max-w-lg mx-auto w-full space-y-6">
        {/* Current device */}
        <div>
          <h3 className="text-sm font-semibold text-white/40 uppercase tracking-wider mb-3">이 기기</h3>
          <div className="glass rounded-xl overflow-hidden">
            <div className="bg-dark-800 relative aspect-video">
              {isActive && stream ? (
                <video
                  ref={previewRef}
                  autoPlay
                  muted
                  playsInline
                  className="absolute inset-0 w-full h-full object-contain mirror"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-white/30">
                  <div className="text-center">
                    <Camera className="w-12 h-12 mx-auto mb-2 opacity-50" strokeWidth={1.5} />
                    <p className="text-sm">{isActive ? '불러오는 중...' : '카메라 꺼짐'}</p>
                  </div>
                </div>
              )}

              <button
                onClick={() => setCurrentSheetOpen(true)}
                className="absolute top-3 right-3 w-9 h-9 rounded-full flex items-center justify-center bg-black/45 backdrop-blur-sm text-white/80 hover:text-white transition-colors"
                title="더보기"
              >
                <MoreHorizontal size={18} />
              </button>

              {/* On-viewer lens switcher (real lens deviceIds only) — same control as the room */}
              {isActive && stream && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
                  {(() => {
                    const expanded = expandWithZoom(availableCameras, { activeDeviceId: activeCameraId, zoom: zoomCaps });
                    const lensActiveKey = activeLensKey(expanded, activeCameraId, activeZoom);
                    return (
                      <CameraLensControl
                        lenses={lensesFromLocal(expanded)}
                        activeKey={lensActiveKey}
                        disabled={switching}
                        onSelect={(key) => {
                          if (key === lensActiveKey) return;
                          setSwitching(true);
                          selectLocalLens(key)
                            .catch((err: any) => showToast(err.message || '전환 실패', 'error'))
                            .finally(() => setSwitching(false));
                        }}
                      />
                    );
                  })()}
                </div>
              )}
            </div>

            {currentDevice && editingId === currentDevice.id && (
              <div className="p-4">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveName(currentDevice.id)}
                    className="flex-1 bg-dark-700 border border-white/10 rounded-btn px-3 py-2 text-white text-sm focus:outline-none focus:border-primary/50"
                    autoFocus
                    maxLength={100}
                  />
                  <Button size="sm" loading={saving} onClick={() => saveName(currentDevice.id)}>
                    저장
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                    취소
                  </Button>
                </div>
              </div>
            )}
          </div>

          <BottomSheet
            isOpen={currentSheetOpen}
            onClose={() => setCurrentSheetOpen(false)}
            title={currentDevice?.cameraName || '이 기기'}
            actions={[
              {
                icon: <Power size={18} />,
                label: isActive ? '카메라 끄기' : '카메라 켜기',
                onClick: () => (isActive ? stop() : start()),
                danger: isActive,
              },
              ...(currentDevice
                ? [{
                    icon: <Pencil size={18} />,
                    label: '이름 변경',
                    onClick: () => startEditing(currentDevice.id, currentDevice.cameraName),
                  }]
                : []),
            ]}
          />
        </div>

        {/* Other devices */}
        <div>
          <h3 className="text-sm font-semibold text-white/40 uppercase tracking-wider mb-3">
            다른 기기 ({otherDevices.length})
          </h3>
          {otherDevices.length > 0 ? (
            <div className="space-y-3">
              <AnimatePresence>
                {otherDevices.map((cam) => (
                  <motion.div
                    key={cam.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    {editingId === cam.id ? (
                      <div className={`glass rounded-xl p-4 ${!cam.isOnline ? 'opacity-50' : ''}`}>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && saveName(cam.id)}
                            className="flex-1 bg-dark-700 border border-white/10 rounded-btn px-3 py-2 text-white text-sm focus:outline-none focus:border-primary/50"
                            autoFocus
                            maxLength={100}
                          />
                          <Button size="sm" loading={saving} onClick={() => saveName(cam.id)}>
                            저장
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            취소
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <RemoteCameraPreview
                        camId={cam.id}
                        cameraName={cam.cameraName}
                        isOnline={cam.isOnline}
                        isCameraActive={cam.isCameraActive}
                        remoteCameraCount={cam.remoteCameraCount}
                        remoteCameraActiveIndex={cam.remoteCameraActiveIndex}
                        remoteLenses={cam.remoteLenses}
                        onEditName={() => startEditing(cam.id, cam.cameraName)}
                      />
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          ) : (
            <div className="glass rounded-xl p-6 text-center text-white/30">
              <Smartphone className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm mb-1">다른 기기에서 같은 계정으로 로그인하면</p>
              <p className="text-sm">여기에 카메라로 자동 등록됩니다.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
