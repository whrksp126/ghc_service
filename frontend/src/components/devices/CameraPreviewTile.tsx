import { useEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { motion } from 'framer-motion';
import { Camera, WifiOff, Check, RefreshCw } from 'lucide-react';
import { requestPreview, type PreviewConnection, type PreviewStatus } from '../../services/previewStream';
import { useAlwaysOnCamera } from '../../services/alwaysOnCamera';
import { emitWithAck } from '../../lib/socket';
import { CameraLensControl, lensesFromLocal, lensesFromRemote } from '../common/CameraLensControl';
import { expandWithZoom, activeLensKey } from '../../lib/cameraLenses';
import type { RemoteLensMeta } from '../../stores/cameraStore';

interface CameraPreviewTileProps {
  camId: string;
  cameraName: string;
  deviceType: string;
  isOnline: boolean;
  isCurrentDevice?: boolean;
  /** Current-device only: whether the user intends to join with the camera on. */
  camOn?: boolean;
  /** Remote-device lens switching (from cameraStore). */
  remoteCameraCount?: number;
  remoteCameraActiveIndex?: number;
  remoteLenses?: RemoteLensMeta[];
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

type CurrentState = 'live' | 'muted' | 'no_camera' | 'failed' | 'connecting';

/**
 * Selectable camera preview used in the room lobby.
 *
 * The current device binds the always-on camera stream directly. The `<video>` element is
 * ALWAYS mounted for the current device (never gated behind status) so its ref is stable and
 * srcObject can be (re)bound on every stream change — this avoids the mount-order race that
 * previously left the preview stuck on "연결 중". Track mute/ended are observed live, and a dead
 * track self-heals by re-acquiring. Other devices pull a live P2P preview.
 */
export function CameraPreviewTile({
  camId,
  isOnline,
  isCurrentDevice,
  camOn = true,
  remoteCameraCount = 0,
  remoteCameraActiveIndex = 0,
  remoteLenses,
  selected,
  disabled,
  onToggle,
}: CameraPreviewTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const connRef = useRef<PreviewConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<PreviewStatus>('connecting');
  // Bumped whenever the current device's track changes mute/ended state so the render
  // re-derives liveness from the (mutated-in-place) MediaStreamTrack.
  const [, setTick] = useState(0);
  const healedRef = useRef(false);

  // Always-on store (drives the current device's preview + lens list).
  const aoStream = useAlwaysOnCamera((s) => s.stream);
  const aoError = useAlwaysOnCamera((s) => s.error);
  const availableCameras = useAlwaysOnCamera((s) => s.availableCameras);
  const activeCameraId = useAlwaysOnCamera((s) => s.activeCameraId);
  const zoomCaps = useAlwaysOnCamera((s) => s.zoomCaps);
  const activeZoom = useAlwaysOnCamera((s) => s.activeZoom);

  // ---- Current device --------------------------------------------------------------------
  // Make sure the camera is running (once per camOn flip).
  useEffect(() => {
    if (isCurrentDevice && camOn) useAlwaysOnCamera.getState().start();
  }, [isCurrentDevice, camOn]);

  // Bind the always-on stream to the (always-mounted) video element.
  useEffect(() => {
    if (!isCurrentDevice) return;
    const v = videoRef.current;
    if (!v) return;
    if (camOn && aoStream) {
      if (v.srcObject !== aoStream) v.srcObject = aoStream;
      if (v.paused) v.play().catch(() => {});
    } else if (v.srcObject) {
      v.srcObject = null;
    }
  });

  // Observe the current track's mute/ended so the placeholder reflects reality.
  useEffect(() => {
    if (!isCurrentDevice) return;
    const track = aoStream?.getVideoTracks()[0];
    if (!track) return;
    const bump = () => setTick((x) => x + 1);
    track.addEventListener('mute', bump);
    track.addEventListener('unmute', bump);
    track.addEventListener('ended', bump);
    return () => {
      track.removeEventListener('mute', bump);
      track.removeEventListener('unmute', bump);
      track.removeEventListener('ended', bump);
    };
  }, [isCurrentDevice, aoStream]);

  // Derive the current device's state fresh each render (reads live track fields).
  let currentState: CurrentState = 'connecting';
  if (isCurrentDevice) {
    const track = camOn ? aoStream?.getVideoTracks()[0] : undefined;
    if (!camOn) currentState = 'no_camera';
    else if (track && track.readyState === 'live' && !track.muted) currentState = 'live';
    else if (track && track.muted) currentState = 'muted';
    else if (aoError) currentState = 'failed';
    else currentState = 'connecting';
  }

  // Self-heal: a live stream that lost its frames (ended/muted, e.g. camera grabbed during a
  // page transition) is re-acquired once automatically before falling back to the retry UI.
  useEffect(() => {
    if (!isCurrentDevice || !camOn) return;
    if (currentState === 'live') {
      healedRef.current = false;
      return;
    }
    if (currentState === 'connecting' || currentState === 'muted') {
      const t = setTimeout(() => {
        if (!healedRef.current) {
          healedRef.current = true;
          useAlwaysOnCamera.getState().start(activeCameraId || undefined);
        }
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [isCurrentDevice, camOn, currentState, activeCameraId]);

  // ---- Other devices: P2P preview --------------------------------------------------------
  const connectPreview = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;
    streamRef.current = null;
    setStatus('connecting');
    connRef.current = requestPreview(
      camId,
      (stream) => {
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      },
      () => {},
      (s) => setStatus(s),
    );
  }, [camId]);

  useEffect(() => {
    if (isCurrentDevice || !isOnline) {
      if (!isOnline) setStatus('connecting');
      return;
    }
    connectPreview();
    return () => {
      connRef.current?.close();
      connRef.current = null;
    };
  }, [isCurrentDevice, isOnline, connectPreview]);

  useEffect(() => {
    if (status === 'live' && videoRef.current && streamRef.current && !isCurrentDevice) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status, isCurrentDevice]);

  // ---- Shared rendering ------------------------------------------------------------------
  const offline = !isOnline && !isCurrentDevice;
  // Current device keeps the <video> mounted whenever camOn, so srcObject binding never races.
  const showVideo = isCurrentDevice ? camOn : status === 'live' && isOnline;
  // The placeholder overlays the video when the current device has no usable frames.
  const overlay: CurrentState | 'offline' | 'p2p-connecting' | null = (() => {
    if (offline) return 'offline';
    if (isCurrentDevice) return currentState === 'live' ? null : currentState;
    if (status !== 'live') return 'p2p-connecting';
    return null;
  })();

  // Lens switching — same shared front/back + zoom control everywhere. For my current device the
  // roster is zoom-expanded (so an optical 0.5× ultra-wide shows as its own chip); keys are
  // deviceIds or `z:<zoom>`. For a remote device, keys are stringified indices into its broadcast
  // list (ask it to switch by index over the socket).
  const localExpanded = isCurrentDevice
    ? expandWithZoom(availableCameras, { activeDeviceId: activeCameraId, zoom: zoomCaps })
    : [];
  const lensList = isCurrentDevice ? lensesFromLocal(localExpanded) : lensesFromRemote(remoteLenses, remoteCameraCount);
  const lensActiveKey = isCurrentDevice ? activeLensKey(localExpanded, activeCameraId, activeZoom) : String(remoteCameraActiveIndex);
  const showLens = (isCurrentDevice ? currentState === 'live' : status === 'live' && isOnline) && lensList.length > 1;

  const onSelectLens = (key: string) => {
    if (isCurrentDevice) useAlwaysOnCamera.getState().selectLocalLens(key).catch(() => {});
    else emitWithAck('camera:requestSwitchCamera', { targetDeviceId: camId, cameraIndex: Number(key) }).catch(() => {});
  };

  const retry = (e: ReactMouseEvent) => {
    e.stopPropagation();
    healedRef.current = false;
    if (isCurrentDevice) useAlwaysOnCamera.getState().start(activeCameraId || undefined);
    else connectPreview();
  };

  return (
    // role=button (not a real <button>) so the on-viewer lens control can nest interactive
    // buttons without invalid markup.
    <motion.div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={selected}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      onClick={() => !disabled && onToggle()}
      className={`relative w-full aspect-video rounded-xl overflow-hidden bg-dark-800 text-left transition-colors border-2 ${
        selected ? 'border-primary' : 'border-transparent'
      } ${offline || disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {showVideo && (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className={`absolute inset-0 w-full h-full object-cover ${isCurrentDevice ? 'scale-x-[-1]' : ''} ${
            overlay ? 'opacity-0' : 'opacity-100'
          }`}
        />
      )}

      {overlay && (
        <div className="absolute inset-0 flex items-center justify-center text-white/25">
          {overlay === 'offline' ? (
            <div className="text-center">
              <WifiOff className="w-8 h-8 mx-auto mb-1 opacity-40" strokeWidth={1.5} />
              <p className="text-[11px]">오프라인</p>
            </div>
          ) : overlay === 'no_camera' ? (
            <div className="text-center">
              <Camera className="w-8 h-8 mx-auto mb-1 opacity-50" strokeWidth={1.5} />
              <p className="text-[11px] text-white/40">카메라 꺼짐</p>
            </div>
          ) : overlay === 'failed' ? (
            <div className="text-center">
              <button
                onClick={retry}
                className="flex items-center gap-1 mx-auto text-[11px] text-primary hover:text-primary-hover"
              >
                <RefreshCw size={12} /> 다시 시도
              </button>
            </div>
          ) : overlay === 'muted' ? (
            <div className="text-center">
              <Camera className="w-8 h-8 mx-auto mb-1 opacity-50" strokeWidth={1.5} />
              <p className="text-[11px] text-white/40">카메라 사용 중</p>
              <button
                onClick={retry}
                className="mt-1 flex items-center gap-1 mx-auto text-[11px] text-primary hover:text-primary-hover"
              >
                <RefreshCw size={11} /> 다시 시도
              </button>
            </div>
          ) : (
            <div className="text-center">
              <Camera className="w-8 h-8 mx-auto mb-1 opacity-50 animate-pulse" strokeWidth={1.5} />
              <p className="text-[11px] text-white/40">연결 중...</p>
            </div>
          )}
        </div>
      )}

      {/* On-viewer lens switcher (real lens deviceIds only). Bounded to the tile width + compact
          size so it wraps instead of overflowing on small lobby tiles. */}
      {showLens && (
        <div className="absolute bottom-2 inset-x-2 z-10 flex justify-center">
          <CameraLensControl lenses={lensList} activeKey={lensActiveKey} onSelect={onSelectLens} size="sm" />
        </div>
      )}

      {/* Selection check */}
      <div
        className={`absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
          selected ? 'bg-primary text-white' : 'bg-black/40 text-white/40 border border-white/20'
        }`}
      >
        {selected && <Check size={14} strokeWidth={3} />}
      </div>
    </motion.div>
  );
}
