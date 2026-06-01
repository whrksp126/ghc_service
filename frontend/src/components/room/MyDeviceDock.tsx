import { useEffect, useRef, useState } from 'react';
import { Smartphone, Tablet, Monitor, Camera, Power, SwitchCamera, Loader2, MoreHorizontal } from 'lucide-react';
import { useCameraStore } from '../../stores/cameraStore';
import { useRoomStore } from '../../stores/roomStore';
import { useAuthStore } from '../../stores/authStore';
import { useAlwaysOnCamera } from '../../services/alwaysOnCamera';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { BottomSheet, type SheetAction } from '../common/BottomSheet';

interface MyDeviceDockProps {
  roomSlug: string;
  isCurrentCamOn: boolean;
  onToggleCurrentCam: () => void;
  onSwitchCurrentCam: () => void;
  localVideoTrack: MediaStreamTrack | null;
}

function DeviceIcon({ type, size = 14 }: { type: string; size?: number }) {
  switch (type) {
    case 'phone': return <Smartphone size={size} />;
    case 'tablet': return <Tablet size={size} />;
    case 'desktop': return <Monitor size={size} />;
    default: return <Camera size={size} />;
  }
}

/** Tiny live thumbnail bound to a single track. */
function DockVideo({ track, mirror }: { track: MediaStreamTrack; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`w-full h-full object-cover ${mirror ? 'scale-x-[-1]' : ''}`}
    />
  );
}

/**
 * Horizontal dock of the user's own devices, shown in-room. Acts as an admin console:
 * each of my cameras can be toggled on/off (and front/back switched) instantly. The
 * current device toggles its local producer; other devices are controlled over the
 * existing camera:* signaling (server only relays to devices owned by the same user).
 */
export function MyDeviceDock({ roomSlug, isCurrentCamOn, onToggleCurrentCam, onSwitchCurrentCam, localVideoTrack }: MyDeviceDockProps) {
  const { cameras, fetchCameras } = useCameraStore();
  const { userId, deviceId } = useAuthStore();
  const consumers = useRoomStore((s) => s.consumers);
  const isReconnecting = useRoomStore((s) => s.isReconnecting);
  const localLensCount = useAlwaysOnCamera((s) => s.availableCameras.length);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [sheetCamId, setSheetCamId] = useState<string | null>(null);
  // Track which devices we auto-pulled into the room, and which the user explicitly
  // stopped, so reconnecting devices re-appear but manually-off ones stay off.
  const autoStartedRef = useRef<Set<string>>(new Set());
  const manualStopRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    fetchCameras(deviceId);
  }, [deviceId, fetchCameras]);

  // Auto-bring my online devices into the room (e.g. a phone that just reconnected /
  // refreshed). Respects devices the user explicitly turned off; retries after a device
  // goes offline and comes back.
  useEffect(() => {
    for (const cam of cameras) {
      if (cam.isCurrentDevice) continue;
      if (!cam.isOnline) {
        autoStartedRef.current.delete(cam.id);
        continue;
      }
      if (cam.isInRoom || manualStopRef.current.has(cam.id) || autoStartedRef.current.has(cam.id)) continue;
      autoStartedRef.current.add(cam.id);
      emitWithAck('camera:requestStart', { targetDeviceId: cam.id, roomSlug }).catch(() => {});
    }
  }, [cameras, roomSlug]);

  const setBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });

  // My remote devices appear as consumers keyed by my userId + their deviceId.
  const trackFor = (camDeviceId: string): MediaStreamTrack | null => {
    if (camDeviceId === deviceId) return localVideoTrack;
    const c = consumers.find((x) => x.userId === userId && x.deviceId === camDeviceId && x.kind === 'video');
    return c?.track ?? null;
  };

  async function handleToggle(camId: string, isCurrent: boolean, streaming: boolean) {
    if (isCurrent) {
      onToggleCurrentCam();
      return;
    }
    setBusy(camId, true);
    try {
      if (streaming) {
        manualStopRef.current.add(camId);
        autoStartedRef.current.delete(camId);
        await emitWithAck('camera:requestStop', { targetDeviceId: camId });
      } else {
        manualStopRef.current.delete(camId);
        autoStartedRef.current.add(camId);
        await emitWithAck('camera:requestStart', { targetDeviceId: camId, roomSlug });
      }
    } catch (err: any) {
      showToast(err.message || '요청에 실패했습니다', 'error');
    } finally {
      setBusy(camId, false);
    }
  }

  async function handleSwitch(camId: string, isCurrent: boolean) {
    if (isCurrent) {
      onSwitchCurrentCam();
      return;
    }
    setBusy(camId, true);
    try {
      await emitWithAck('camera:requestSwitchCamera', { targetDeviceId: camId });
    } catch (err: any) {
      showToast(err.message || '전환에 실패했습니다', 'error');
    } finally {
      setBusy(camId, false);
    }
  }

  if (cameras.length === 0) return null;

  const sorted = [...cameras].sort((a, b) => Number(b.isCurrentDevice) - Number(a.isCurrentDevice));

  // Per-camera runtime state, reused by both the tile and its "더보기" sheet.
  const camState = (cam: typeof cameras[number]) => {
    const isCurrent = cam.isCurrentDevice;
    const online = isCurrent ? true : cam.isOnline;
    const track = trackFor(cam.id);
    const streaming = isCurrent ? isCurrentCamOn && !!localVideoTrack : !!track;
    const canSwitch = isCurrent ? streaming && localLensCount > 1 : online && cam.remoteCameraCount > 1;
    return { isCurrent, online, track, streaming, canSwitch, busy: busyIds.has(cam.id) };
  };

  const sheetCam = sorted.find((c) => c.id === sheetCamId) || null;
  const sheetActions: SheetAction[] = sheetCam
    ? (() => {
        const { isCurrent, online, streaming, canSwitch, busy } = camState(sheetCam);
        const list: SheetAction[] = [{
          icon: <Power size={18} />,
          label: streaming ? '카메라 끄기' : '카메라 켜기',
          onClick: () => handleToggle(sheetCam.id, isCurrent, streaming),
          danger: streaming,
          disabled: busy || (!online && !isCurrent),
        }];
        if (canSwitch) {
          list.push({
            icon: <SwitchCamera size={18} />,
            label: '카메라 전환',
            onClick: () => handleSwitch(sheetCam.id, isCurrent),
            disabled: busy,
          });
        }
        return list;
      })()
    : [];

  return (
    <div className="shrink-0 px-3 pb-1">
      <div className="flex items-center gap-1.5 mb-1.5 px-1">
        <span className="text-[11px] font-semibold text-white/40 uppercase tracking-wider">내 기기</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-none">
        {sorted.map((cam) => {
          const { isCurrent, online, track, streaming, busy } = camState(cam);
          const reconnecting = isCurrent && isReconnecting;

          return (
            <div key={cam.id} className="relative w-28 shrink-0">
              <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-dark-800 border border-white/10">
                {track && streaming ? (
                  <DockVideo track={track} mirror={isCurrent} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-white/25">
                    <DeviceIcon type={cam.deviceType} size={22} />
                  </div>
                )}

                {/* Status badge — only transient states; "송출 중" is implied by the live tile. */}
                {(reconnecting || !online || (!streaming && online)) && (
                  <div className="absolute top-1 left-1 flex items-center gap-1 bg-black/55 backdrop-blur-sm rounded-full px-1.5 py-0.5">
                    {reconnecting ? (
                      <>
                        <Loader2 size={9} className="animate-spin text-warning" />
                        <span className="text-[9px] text-white/70">재연결</span>
                      </>
                    ) : !online ? (
                      <span className="text-[9px] text-white/50">오프라인</span>
                    ) : (
                      <span className="text-[9px] text-yellow-400/80">대기</span>
                    )}
                  </div>
                )}

                {/* More menu */}
                <button
                  onClick={() => setSheetCamId(cam.id)}
                  disabled={busy || (!online && !isCurrent)}
                  className="absolute bottom-1 right-1 w-7 h-7 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center text-white/70 hover:text-white disabled:opacity-40"
                  title="더보기"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <MoreHorizontal size={15} />}
                </button>
              </div>

              <div className="flex items-center gap-1 mt-1 px-0.5">
                <span className="text-white/50 shrink-0"><DeviceIcon type={cam.deviceType} size={11} /></span>
                <span className="text-[11px] text-white/70 truncate">{cam.cameraName}</span>
                {isCurrent && <span className="text-[9px] text-primary ml-auto shrink-0">이 기기</span>}
              </div>
            </div>
          );
        })}
      </div>

      <BottomSheet
        isOpen={!!sheetCam}
        onClose={() => setSheetCamId(null)}
        title={sheetCam?.cameraName}
        actions={sheetActions}
      />
    </div>
  );
}
