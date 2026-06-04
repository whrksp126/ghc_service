import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { LayoutGroup } from 'framer-motion';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import {
  connectToRoom, publishTrack, unpublishTrack, setTrackMuted, replacePublishedTrack, disconnectRoom,
} from '../lib/livekitRoom';
import { useRoomStore } from '../stores/roomStore';
import { useDeviceStore } from '../stores/deviceStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { useCameraStore, type CameraDevice } from '../stores/cameraStore';
import { CameraLensControl, CameraZoomControl, lensesFromLocal, lensesFromRemote } from '../components/common/CameraLensControl';
import { emitWithAck } from '../lib/socket';
import { api } from '../lib/api';
import { useAlwaysOnCamera } from '../services/alwaysOnCamera';
import { attachVoice, detachVoice, useVoiceStore } from '../services/voiceActivity';
import { useAudioSettings, micConstraints } from '../stores/audioSettings';
import { GridLayout } from '../components/room/GridLayout';
import { SpotlightLayout } from '../components/room/SpotlightLayout';
import { DocumentPipPortal } from '../components/room/DocumentPipPortal';
import { useFloatingWindowStore } from '../stores/floatingWindowStore';
import { TopBar } from '../components/layout/TopBar';
import { BottomBar } from '../components/layout/BottomBar';
import { ReconnectingOverlay } from '../components/connection/ReconnectingOverlay';
import { LoadingScreen } from '../components/common/LoadingScreen';
import { CameraPreviewTile } from '../components/devices/CameraPreviewTile';
import { ObsBroadcastModal } from '../components/room/ObsBroadcastModal';
import { Button } from '../components/common/Button';
import { showToast } from '../components/common/Toast';
import { Mic, MicOff, Video, VideoOff, Users, Power, Volume2, VolumeX } from 'lucide-react';
import { initSounds, playSound } from '../lib/sounds';
import type { Participant } from '../types/room';

type RoomPhase = 'lobby' | 'connecting' | 'inRoom';

/** Hidden sink that plays a remote participant's audio track + taps it for voice activity. */
function RemoteAudio({ track, voiceKey }: { track: MediaStreamTrack; voiceKey: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  // Local per-participant mute: I can silence someone without affecting anyone else.
  const muted = useUIStore((s) => !!s.mutedAudio[voiceKey]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);
  useEffect(() => {
    const el = ref.current;
    if (el) el.srcObject = new MediaStream([track]);
    attachVoice(voiceKey, track);

    // Autoplay of audio is often blocked by the browser when a track arrives at connect
    // time without a fresh user gesture (e.g. the always-on OBS ingress track right after a
    // refresh) → silent video-only. <audio autoPlay> alone won't recover. Explicitly play,
    // and retry on the next user interaction so a tap anywhere unblocks it.
    const tryPlay = () => { el?.play().catch(() => {}); };
    tryPlay();
    document.addEventListener('pointerdown', tryPlay);
    document.addEventListener('keydown', tryPlay);

    return () => {
      detachVoice(voiceKey);
      document.removeEventListener('pointerdown', tryPlay);
      document.removeEventListener('keydown', tryPlay);
      if (el) el.srcObject = null;
    };
  }, [track, voiceKey]);
  return <audio ref={ref} autoPlay playsInline />;
}

/** Toggle that locally mutes/unmutes one participant's audio (turns red when muted). */
function AudioMuteButton({ mutekey }: { mutekey: string }) {
  const muted = useUIStore((s) => !!s.mutedAudio[mutekey]);
  const toggle = useUIStore((s) => s.toggleAudioMute);
  return (
    <TileButton
      onClick={() => toggle(mutekey)}
      active={!muted}
      icon={muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
    />
  );
}

/** Round control button shown inside a feed tile's single-click overlay. */
function TileButton({ onClick, icon, danger, active }: { onClick: () => void; icon: ReactNode; danger?: boolean; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
        danger ? 'bg-danger text-white' : active === false ? 'bg-danger text-white' : 'bg-white/15 text-white hover:bg-white/25'
      }`}
    >
      {icon}
    </button>
  );
}

/**
 * My current device's lens switcher — reads the always-on roster and hot-swaps the published
 * track via onSelect(deviceId). Thin wrapper over the shared CameraLensControl so every surface
 * (room / lobby / manager) renders the identical front/back + zoom UI.
 */
function CameraSwitcher({ onSelect }: { onSelect: (deviceId: string) => void }) {
  const cameras = useAlwaysOnCamera((s) => s.availableCameras);
  const activeId = useAlwaysOnCamera((s) => s.activeCameraId);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <CameraLensControl lenses={lensesFromLocal(cameras)} activeKey={activeId} onSelect={onSelect} />
      <CameraZoomControl />
    </div>
  );
}

/**
 * Another of MY devices, shown in the room from its reported lens metadata. Selecting a lens
 * asks that device to switch by index (the order it enumerated and broadcast).
 */
function RemoteLensControl({ cam }: { cam: CameraDevice }) {
  const lenses = lensesFromRemote(cam.remoteLenses, cam.remoteCameraCount);
  return (
    <CameraLensControl
      lenses={lenses}
      activeKey={String(cam.remoteCameraActiveIndex)}
      onSelect={(key) =>
        emitWithAck('camera:requestSwitchCamera', { targetDeviceId: cam.id, cameraIndex: Number(key) }).catch(() => {})
      }
    />
  );
}

export function RoomPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { userId, nickname, deviceId } = useAuthStore();
  const {
    setRoom, clearRoom, setParticipants, setConnecting, isConnecting, consumers, participants,
  } = useRoomStore();
  const {
    isCamOn, isMicOn, setVideoTrack, setAudioTrack, setScreenSharing, isScreenSharing, setScreenTrack,
    reset: resetDevice, setAudioProducerId, setVideoProducerId, setScreenProducerId,
  } = useDeviceStore();
  const { layoutMode, setLayoutMode, spotlightProducerId, setSpotlightProducer } = useUIStore();
  const togglePip = useFloatingWindowStore((s) => s.toggle);
  const { cameras, fetchCameras } = useCameraStore();

  const { connect, disconnect } = useSocket();

  const [phase, setPhase] = useState<RoomPhase>('lobby');
  const [isOwner, setIsOwner] = useState(false);
  const [obsOpen, setObsOpen] = useState(false);
  const openObs = useCallback(() => setObsOpen(true), []);
  const closeObs = useCallback(() => setObsOpen(false), []);
  const [localVideoTrack, setLocalVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [localScreenTrack, setLocalScreenTrack] = useState<MediaStreamTrack | null>(null);
  const localAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const joinedRef = useRef(false);
  const sessionActiveRef = useRef(false);
  // Real room name from getRoom; falls back to slug until it resolves.
  const roomNameRef = useRef<string | null>(null);
  // Track which of my devices we auto-pulled in vs the user explicitly stopped, so a
  // stopped device doesn't immediately bounce back into the room.
  const autoStartedRef = useRef<Set<string>>(new Set());
  const manualStopRef = useRef<Set<string>>(new Set());

  // Lobby state
  const [lobbyMicOn, setLobbyMicOn] = useState(true);
  const [lobbyCamOn, setLobbyCamOn] = useState(true);
  const [selectedCameras, setSelectedCameras] = useState<Set<string>>(new Set());
  const [needsPin, setNeedsPin] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [roomJoined, setRoomJoined] = useState(false);

  // Check if room requires PIN and if we need to join first
  useEffect(() => {
    if (!slug) return;
    const inviteToken = searchParams.get('invite');

    (async () => {
      try {
        // Try to join without a PIN first. The server lets existing members (and invite
        // links) straight in, so a returning member is never re-challenged. Only a
        // first-time joiner of a PIN room gets 'PIN required' → show the prompt.
        await api.joinRoom(slug, undefined, inviteToken || undefined);
        setRoomJoined(true);
        // Pull room metadata (real name + PIN flag) for the top bar / share sheet.
        api.getRoom(slug)
          .then((res) => {
            roomNameRef.current = res.room.name;
            useRoomStore.setState({ roomName: res.room.name, hasPin: res.room.hasPin });
          })
          .catch(() => {});
      } catch (err: any) {
        if (err.message === 'PIN required') {
          setNeedsPin(true);
        } else {
          showToast(err.message || '방을 찾을 수 없습니다', 'error');
          navigate('/');
        }
      }
    })();
  }, [slug, searchParams]);

  // Use always-on camera for lobby preview. start() reuses a live stream or re-acquires
  // a dead one; the preview itself is read reactively via lobbyPreviewStream.
  useEffect(() => {
    if (phase !== 'lobby' || !roomJoined) return;
    fetchCameras(deviceId);
    useAlwaysOnCamera.getState().start();
  }, [phase, roomJoined]);

  // Initialize selected cameras (all online by default)
  useEffect(() => {
    if (cameras.length > 0 && selectedCameras.size === 0) {
      const onlineCams = new Set(cameras.filter((c) => c.isOnline || c.isCurrentDevice).map((c) => c.id));
      setSelectedCameras(onlineCams);
    }
  }, [cameras]);

  async function handlePinSubmit() {
    if (!slug || !pinInput) return;
    try {
      await api.joinRoom(slug, pinInput);
      setRoomJoined(true);
      setNeedsPin(false);
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  }

  function toggleCamera(camId: string) {
    setSelectedCameras((prev) => {
      const next = new Set(prev);
      if (next.has(camId)) {
        next.delete(camId);
      } else {
        next.add(camId);
      }
      return next;
    });
  }

  async function handleJoinFromLobby() {
    setPhase('connecting');

    // Request remote cameras to start
    for (const camId of selectedCameras) {
      const cam = cameras.find((c) => c.id === camId);
      if (cam && !cam.isCurrentDevice && cam.isOnline) {
        emitWithAck('camera:requestStart', { targetDeviceId: camId, roomSlug: slug }).catch(() => {});
      }
    }

    await joinRoom();
  }

  // Join the room over Socket.IO (presence + token) and connect to the LiveKit SFU.
  // LiveKit auto-subscribes remote tracks → roomStore.consumers, and auto-reconnects media.
  const establishSession = useCallback(async () => {
    const result = await emitWithAck<{
      participants: Participant[];
      isOwner: boolean;
      token: string;
    }>('room:join', { roomSlug: slug });

    setRoom(slug!, roomNameRef.current || slug!);
    setParticipants(result.participants);
    setIsOwner(!!result.isOwner);

    await connectToRoom(result.token);
  }, [slug, setRoom, setParticipants]);

  const joinRoom = useCallback(async () => {
    if (!slug || joinedRef.current) return;
    joinedRef.current = true;
    setConnecting(true);

    try {
      initSounds();
      const socket = connect();

      // Owner ended the room (or it was deleted) → leave gracefully.
      socket.off('room:closed');
      socket.on('room:closed', () => {
        sessionActiveRef.current = false;
        showToast('방이 종료되었습니다', 'info');
        navigate('/');
      });

      // Socket reconnect only needs to restore presence; LiveKit reconnects media itself.
      socket.io.off('reconnect');
      socket.io.on('reconnect', () => {
        emitWithAck('room:join', { roomSlug: slug }).catch(() => {});
      });

      await establishSession();

      // Stream this device by default; only skip it if the user explicitly unchecked it
      // in the lobby (selection populated but our id absent).
      const shouldStreamCurrent = selectedCameras.size === 0 || selectedCameras.has(deviceId || '');

      if (shouldStreamCurrent) {
        // Use always-on camera stream if available, otherwise get new one
        const alwaysOn = useAlwaysOnCamera.getState();
        let stream = alwaysOn.stream;

        if (!stream || !stream.active) {
          try {
            await alwaysOn.start();
            stream = useAlwaysOnCamera.getState().stream;
          } catch {
            // fallback
          }
        }

        if (!stream && navigator.mediaDevices?.getUserMedia) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: micConstraints(),
              video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' },
            });
          } catch {
            showToast('카메라/마이크 접근이 거부되었습니다', 'error');
          }
        }

        if (stream) {
          const audioTrack = stream.getAudioTracks()[0];
          const videoTrack = stream.getVideoTracks()[0];

          if (audioTrack) {
            if (lobbyMicOn) {
              localAudioTrackRef.current = audioTrack;
              setAudioTrack(audioTrack);
              const sid = await publishTrack(audioTrack, 'microphone');
              setAudioProducerId(sid);
            } else {
              audioTrack.stop();
              useDeviceStore.setState({ isMicOn: false });
            }
          }

          if (videoTrack) {
            if (lobbyCamOn) {
              setLocalVideoTrack(videoTrack);
              setVideoTrack(videoTrack);
              const sid = await publishTrack(videoTrack, 'camera');
              setVideoProducerId(sid);
            } else {
              videoTrack.stop();
              useDeviceStore.setState({ isCamOn: false });
            }
          }
        }
      }

      sessionActiveRef.current = true;
      playSound('join');
      setConnecting(false);
      setPhase('inRoom');
    } catch (err: any) {
      showToast(err.message || '방 참여에 실패했습니다', 'error');
      setConnecting(false);
      navigate('/');
    }
  }, [slug, connect, establishSession, setConnecting, setAudioTrack, setVideoTrack,
    setAudioProducerId, setVideoProducerId, navigate, lobbyMicOn, lobbyCamOn, selectedCameras, deviceId]);

  useEffect(() => {
    return () => {
      // Don't stop always-on camera tracks - they belong to the app
      sessionActiveRef.current = false;
      disconnectRoom();
      disconnect();
      clearRoom();
      resetDevice();
      joinedRef.current = false;
    };
  }, []);

  const handleToggleMic = useCallback(async () => {
    const { audioInput, isMicOn: currentMicOn } = useDeviceStore.getState();
    const audioProducerId = audioInput.producerId;

    if (currentMicOn) {
      if (audioInput.track) audioInput.track.stop();
      setAudioTrack(null);
      localAudioTrackRef.current = null;
      setAudioProducerId(null);
      useDeviceStore.setState({ isMicOn: false });
      await unpublishTrack(audioProducerId);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
        const newAudioTrack = stream.getAudioTracks()[0];
        if (newAudioTrack) {
          localAudioTrackRef.current = newAudioTrack;
          setAudioTrack(newAudioTrack);
          const sid = await publishTrack(newAudioTrack, 'microphone');
          setAudioProducerId(sid);
        }
        useDeviceStore.setState({ isMicOn: true });
      } catch {
        showToast('마이크를 다시 시작할 수 없습니다', 'error');
      }
    }
  }, [setAudioTrack, setAudioProducerId]);

  const handleToggleCam = useCallback(async () => {
    const { videoInput, isCamOn: currentCamOn } = useDeviceStore.getState();
    const videoProducerId = videoInput.producerId;

    if (currentCamOn) {
      if (videoInput.track) videoInput.track.stop();
      setVideoTrack(null);
      setLocalVideoTrack(null);
      setVideoProducerId(null);
      useDeviceStore.setState({ isCamOn: false });
      await unpublishTrack(videoProducerId);
    } else {
      try {
        const alwaysOn = useAlwaysOnCamera.getState();
        const currentCamId = alwaysOn.activeCameraId;
        await alwaysOn.start(currentCamId || undefined);
        const newStream = useAlwaysOnCamera.getState().stream;
        const newVideoTrack = newStream?.getVideoTracks()[0];

        if (newVideoTrack) {
          setVideoTrack(newVideoTrack);
          setLocalVideoTrack(newVideoTrack);
          const sid = await publishTrack(newVideoTrack, 'camera');
          setVideoProducerId(sid);
        }
        useDeviceStore.setState({ isCamOn: true });
      } catch {
        showToast('카메라를 다시 시작할 수 없습니다', 'error');
      }
    }
  }, [setVideoTrack, setVideoProducerId]);

  // Switch the current device to a specific camera (front/back or a zoom lens) in-room:
  // re-acquire that lens and hot-swap the live publication's track so others (and the
  // dock) see the new lens immediately.
  const switchToDevice = useCallback(async (targetDeviceId: string) => {
    const ao = useAlwaysOnCamera.getState();
    if (!targetDeviceId || ao.activeCameraId === targetDeviceId) return;
    try {
      await ao.switchCamera(targetDeviceId);
      const newTrack = useAlwaysOnCamera.getState().stream?.getVideoTracks()[0];
      const videoProducerId = useDeviceStore.getState().videoInput.producerId;
      if (newTrack) {
        await replacePublishedTrack(videoProducerId, newTrack);
        setVideoTrack(newTrack);
        setLocalVideoTrack(newTrack);
      }
    } catch {
      showToast('카메라 전환에 실패했습니다', 'error');
    }
  }, [setVideoTrack]);

  const handleToggleScreen = useCallback(async () => {
    if (isScreenSharing) {
      const screenProducerId = useDeviceStore.getState().screenShare.producerId;
      await unpublishTrack(screenProducerId);
      setScreenProducerId(null);
      localScreenTrack?.stop();
      setLocalScreenTrack(null);
      setScreenTrack(null);
      setScreenSharing(false);
    } else {
      // getDisplayMedia is desktop-only — mobile Safari/Chrome don't expose it. Tell the
      // user instead of silently doing nothing.
      if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
        showToast('이 기기에서는 화면 공유를 지원하지 않습니다 (PC에서 가능)', 'error');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) {
          showToast('공유할 화면을 가져오지 못했습니다', 'error');
          return;
        }
        setLocalScreenTrack(videoTrack);
        setScreenTrack(videoTrack);
        setScreenSharing(true);
        const sid = await publishTrack(videoTrack, 'screen');
        if (!sid) {
          // Room/SFU not connected — roll back so the button doesn't get stuck "on".
          videoTrack.stop();
          setLocalScreenTrack(null);
          setScreenTrack(null);
          setScreenSharing(false);
          showToast('화면 공유를 시작하지 못했습니다 (연결 확인)', 'error');
          return;
        }
        setScreenProducerId(sid);

        videoTrack.onended = () => {
          handleToggleScreen();
        };
      } catch (err: any) {
        // NotAllowedError = user dismissed the picker; anything else is a real failure.
        if (err?.name === 'NotAllowedError') {
          showToast('화면 공유가 취소되었습니다', 'info');
        } else {
          showToast('화면 공유를 시작할 수 없습니다', 'error');
        }
      }
    }
  }, [isScreenSharing, localScreenTrack, setScreenTrack, setScreenSharing, setScreenProducerId]);

  const handleLeave = useCallback(() => {
    sessionActiveRef.current = false;
    emitWithAck('room:leave', {}).catch(() => {});
    navigate('/');
  }, [navigate]);

  const handleCloseRoom = useCallback(() => {
    if (!window.confirm('방을 종료하면 모든 참가자의 연결이 끊깁니다. 종료할까요?')) return;
    sessionActiveRef.current = false;
    emitWithAck('room:close', {})
      .then(() => navigate('/'))
      .catch((err: any) => showToast(err.message || '방 종료에 실패했습니다', 'error'));
  }, [navigate]);

  // Auto-bring my online devices into the room (was in the now-removed dock). Capped at
  // 3 cameras/user; respects devices the user explicitly stopped.
  useEffect(() => {
    if (phase !== 'inRoom' || !slug) return;
    const MAX_DEVICES_PER_USER = 3;
    let inRoom = cameras.filter((c) => c.isCurrentDevice || c.isInRoom).length;
    for (const cam of cameras) {
      if (cam.isCurrentDevice) continue;
      if (!cam.isOnline) { autoStartedRef.current.delete(cam.id); continue; }
      if (cam.isInRoom || manualStopRef.current.has(cam.id) || autoStartedRef.current.has(cam.id)) continue;
      if (inRoom >= MAX_DEVICES_PER_USER) break;
      autoStartedRef.current.add(cam.id);
      inRoom++;
      emitWithAck('camera:requestStart', { targetDeviceId: cam.id, roomSlug: slug }).catch(() => {});
    }
  }, [cameras, phase, slug]);

  const handleStopDevice = useCallback((camId: string) => {
    manualStopRef.current.add(camId);
    autoStartedRef.current.delete(camId);
    emitWithAck('camera:requestStop', { targetDeviceId: camId }).catch(() => {});
  }, []);

  // userId:deviceId → nickname/deviceLabel fallback (LiveKit metadata is primary).
  const participantLookup = useMemo(() => {
    const m = new Map<string, { nickname: string; deviceLabel: string }>();
    for (const p of participants) {
      m.set(`${p.userId}:${p.deviceId}`, { nickname: p.nickname, deviceLabel: p.deviceLabel });
    }
    return m;
  }, [participants]);

  // Camera tiles are roster-driven: one tile per participant device (mine + others), so a
  // device that turns its camera off keeps its slot (FeedCard renders an avatar placeholder
  // when track is null) instead of vanishing. The video consumer's track is attached when
  // present. Stable per-device ids keep the tile mounted across camera on/off.
  const cameraFeeds = useMemo(() => {
    const selfKey = `${userId}:${deviceId}`;

    // key (`userId:deviceId`) → that device's camera (non-screen) video consumer.
    const camConsumers = new Map<string, any>();
    for (const c of consumers) {
      if (c.kind !== 'video' || c.source === 'screen') continue;
      camConsumers.set(`${c.userId}:${c.deviceId}`, c);
    }

    // Every participant device, plus any device that has a camera consumer (in case the
    // presence roster lags behind media). Excludes my current device — added explicitly.
    const keys = new Set<string>();
    for (const p of participants) keys.add(`${p.userId}:${p.deviceId}`);
    for (const k of camConsumers.keys()) keys.add(k);
    keys.delete(selfKey);

    const items: any[] = [];

    // My current device — always present so its slot stays even with the camera off.
    items.push({
      id: `self:${deviceId}`, track: localVideoTrack, label: nickname || '나',
      isLocal: true, isScreen: false, voiceKey: selfKey,
      controls: (
        <>
          <TileButton onClick={handleToggleMic} active={isMicOn} icon={isMicOn ? <Mic size={18} /> : <MicOff size={18} />} />
          <TileButton onClick={handleToggleCam} active={isCamOn} icon={isCamOn ? <Video size={18} /> : <VideoOff size={18} />} />
        </>
      ),
      belowControls: isCamOn ? <CameraSwitcher onSelect={switchToDevice} /> : null,
    });

    for (const key of keys) {
      const did = key.slice(key.indexOf(':') + 1);
      const uid = key.slice(0, key.indexOf(':'));
      const consumer = camConsumers.get(key);
      const info = participantLookup.get(key);
      const isMine = uid === userId;
      // OBS live ingress (identity `obs:<room>`) is not a real person — skip voice-activity
      // FX (speaking ring + waveform); those are only for connected users.
      const isObs = uid === 'obs';

      let controls: ReactNode | undefined;
      let belowControls: ReactNode | undefined;
      if (isMine) {
        const cam = cameras.find((x) => x.id === did);
        controls = <TileButton danger onClick={() => handleStopDevice(did)} icon={<Power size={18} />} />;
        // Same on-viewer front/back + lens picker as my current device, driven by the metadata
        // this device broadcasts. Replaces the old single "cycle camera" button.
        belowControls = cam ? <RemoteLensControl cam={cam} /> : undefined;
      } else {
        // Others (incl. OBS): let me locally mute/unmute their audio for myself.
        controls = <AudioMuteButton mutekey={key} />;
      }

      items.push({
        id: key, track: consumer?.track ?? null, lkTrack: consumer?.lkTrack,
        label: isMine ? (nickname || '나') : (consumer?.nickname || info?.nickname || (isObs ? 'OBS 라이브' : '참가자')),
        isMuted: false, isLocal: false, isScreen: false, voiceKey: isObs ? undefined : key, controls, belowControls,
      });
    }

    return items;
  }, [consumers, participants, participantLookup, localVideoTrack, deviceId, userId, nickname,
    isMicOn, isCamOn, cameras, handleToggleMic, handleToggleCam, switchToDevice, handleStopDevice]);

  // Screen shares are separate from the camera roster: my current-device screen (local
  // track) plus any screen consumer (mine-other-device or remote).
  const screenFeeds = useMemo(() => {
    const items: any[] = [];
    if (localScreenTrack) {
      items.push({
        id: 'local-screen', track: localScreenTrack, label: nickname || '나',
        deviceLabel: '화면 공유', isLocal: true, isScreen: true,
      });
    }
    for (const c of consumers) {
      if (c.kind !== 'video' || c.source !== 'screen') continue;
      const info = participantLookup.get(`${c.userId}:${c.deviceId}`);
      const isMine = c.userId === userId;
      items.push({
        id: c.consumerId, track: c.track, lkTrack: c.lkTrack,
        label: isMine ? (nickname || '나') : (c.nickname || info?.nickname || '참가자'),
        isMuted: false, isLocal: false, isScreen: true,
        voiceKey: `${c.userId}:${c.deviceId}`,
      });
    }
    return items;
  }, [consumers, participantLookup, nickname, userId, localScreenTrack]);

  // Everyone (camera roster + screen shares) — one unified set for grid and spotlight.
  const allFeeds = useMemo(() => [...cameraFeeds, ...screenFeeds], [cameraFeeds, screenFeeds]);

  // Remote audio is played through hidden <audio> sinks, not the video tiles (a video
  // element only renders one track). My own devices' audio is skipped to avoid echo.
  const audioConsumers = useMemo(() => {
    // Dedupe by device — if a reconnect ever leaves two audio consumers for the same
    // source, playing both <audio> sinks produces a delayed-echo doubling. Keep one per
    // `${userId}:${deviceId}` (last wins = freshest track).
    const byDevice = new Map<string, (typeof consumers)[number]>();
    for (const c of consumers) {
      if (c.kind !== 'audio' || c.userId === userId || !c.track) continue;
      byDevice.set(`${c.userId}:${c.deviceId}`, c);
    }
    return [...byDevice.values()];
  }, [consumers, userId]);

  // Tap my own mic for voice activity so my dock tile glows when I speak (no playback).
  const myVoiceKey = userId && deviceId ? `${userId}:${deviceId}` : '';
  const localAudioTrack = useDeviceStore((s) => s.audioInput.track);
  useEffect(() => {
    if (!myVoiceKey || !localAudioTrack) {
      if (myVoiceKey) detachVoice(myVoiceKey);
      return;
    }
    attachVoice(myVoiceKey, localAudioTrack);
    return () => detachVoice(myVoiceKey);
  }, [myVoiceKey, localAudioTrack]);

  // Noise gate (Discord "voice activity"): only transmit while my mic level is above the
  // sensitivity threshold. We mute/unmute the published mic track (a clone), so the local
  // analyser keeps reading the original track and can re-open the gate when I speak again.
  const { noiseGate, threshold: micThreshold } = useAudioSettings();
  const myLevel = useVoiceStore((s) => (myVoiceKey ? s.levels[myVoiceKey] ?? 0 : 0));
  const audioProducerId = useDeviceStore((s) => s.audioInput.producerId);
  const gateOpenRef = useRef(true);
  const gateHoldRef = useRef(0);
  useEffect(() => {
    if (!localAudioTrack || !audioProducerId) return;
    if (!noiseGate) {
      // Gate disabled → make sure we're not leaving the track muted.
      if (!gateOpenRef.current) {
        gateOpenRef.current = true;
        setTrackMuted(audioProducerId, false).catch(() => {});
      }
      return;
    }
    const now = Date.now();
    // 600ms hangover so the gate doesn't slam shut between words/syllables.
    if (myLevel >= micThreshold) gateHoldRef.current = now + 600;
    const open = now < gateHoldRef.current;
    if (open !== gateOpenRef.current) {
      gateOpenRef.current = open;
      setTrackMuted(audioProducerId, !open).catch(() => {});
    }
  }, [noiseGate, micThreshold, myLevel, localAudioTrack, audioProducerId]);

  // --- PIN required screen ---
  if (needsPin) {
    return (
      <div className="min-h-screen bg-dark-900 flex items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-4">
          <h2 className="text-xl font-display font-bold text-center mb-6">방 비밀번호 입력</h2>
          <input
            type="text"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && handlePinSubmit()}
            placeholder="4~6자리 숫자"
            className="w-full bg-dark-700 border border-white/10 rounded-btn px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50 transition-colors text-center text-2xl tracking-widest"
            inputMode="numeric"
            autoFocus
          />
          <Button className="w-full" size="lg" onClick={handlePinSubmit}>
            확인
          </Button>
          <button
            onClick={() => navigate('/')}
            className="w-full text-sm text-white/40 hover:text-white/60 text-center"
          >
            돌아가기
          </button>
        </div>
      </div>
    );
  }

  // --- Lobby phase ---
  if (phase === 'lobby') {
    if (!roomJoined) {
      return <LoadingScreen message="방 정보를 가져오는 중..." />;
    }

    const lobbyCameras = [...cameras].sort(
      (a, b) => Number(b.isCurrentDevice) - Number(a.isCurrentDevice)
    );

    return (
      <div className="min-h-screen bg-dark-900 flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-md space-y-6">
          <h2 className="text-xl font-display font-bold text-center">방 입장 준비</h2>

          {/* My cameras — live preview grid, tap to choose which join the room */}
          {lobbyCameras.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-white/40 uppercase tracking-wider mb-3">
                내 카메라 · 가져올 카메라를 선택하세요
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {lobbyCameras.map((cam) => (
                  <CameraPreviewTile
                    key={cam.id}
                    camId={cam.id}
                    cameraName={cam.cameraName}
                    deviceType={cam.deviceType}
                    isOnline={cam.isOnline}
                    isCurrentDevice={cam.isCurrentDevice}
                    camOn={lobbyCamOn}
                    remoteCameraCount={cam.remoteCameraCount}
                    remoteCameraActiveIndex={cam.remoteCameraActiveIndex}
                    remoteLenses={cam.remoteLenses}
                    selected={selectedCameras.has(cam.id)}
                    disabled={!cam.isOnline && !cam.isCurrentDevice}
                    onToggle={() => toggleCamera(cam.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* This device's mic / cam intent */}
          <div className="flex justify-center gap-4">
            <button
              onClick={() => setLobbyMicOn(!lobbyMicOn)}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
                lobbyMicOn ? 'bg-dark-700 text-white' : 'bg-danger text-white'
              }`}
              title={lobbyMicOn ? '마이크 켜짐' : '마이크 꺼짐'}
            >
              {lobbyMicOn ? <Mic size={20} /> : <MicOff size={20} />}
            </button>
            <button
              onClick={() => setLobbyCamOn(!lobbyCamOn)}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
                lobbyCamOn ? 'bg-dark-700 text-white' : 'bg-danger text-white'
              }`}
              title={lobbyCamOn ? '카메라 켜짐' : '카메라 꺼짐'}
            >
              {lobbyCamOn ? <Video size={20} /> : <VideoOff size={20} />}
            </button>
          </div>

          {/* Join button */}
          <Button className="w-full" size="lg" onClick={handleJoinFromLobby}>
            참여하기
          </Button>

          <button
            onClick={() => navigate('/')}
            className="w-full text-sm text-white/40 hover:text-white/60 text-center"
          >
            돌아가기
          </button>
        </div>
      </div>
    );
  }

  // --- Connecting phase ---
  if (phase === 'connecting' || isConnecting) {
    return <LoadingScreen message="방에 참여하는 중..." />;
  }

  // --- In-room phase ---
  return (
    <div className="h-screen w-screen bg-dark-900 flex flex-col overflow-hidden">
      <TopBar />

      {/* Remote audio sinks (hidden) — voice playback for other participants */}
      {audioConsumers.map((c) => (
        <RemoteAudio key={c.consumerId} track={c.track!} voiceKey={`${c.userId}:${c.deviceId}`} />
      ))}

      <div className="flex-1 min-h-0 relative">
        {allFeeds.length > 0 ? (
          <LayoutGroup>
            {layoutMode === 'grid' && (
              <GridLayout
                feeds={allFeeds}
                onFeedClick={(id) => {
                  setLayoutMode('spotlight');
                  setSpotlightProducer(id);
                }}
                onPip={togglePip}
              />
            )}
            {layoutMode === 'spotlight' && (
              <SpotlightLayout
                feeds={allFeeds}
                spotlightId={spotlightProducerId}
                onFeedClick={(id) => setSpotlightProducer(id)}
                onExit={() => setLayoutMode('grid')}
                onPip={togglePip}
              />
            )}
          </LayoutGroup>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-white/30 gap-2 px-6 text-center">
            <Users size={40} strokeWidth={1.5} />
            <p className="text-sm">카메라를 켜면 여기에 표시됩니다</p>
            <p className="text-xs text-white/20">타일을 한 번 누르면 설정, 두 번 누르면 크게 보기</p>
          </div>
        )}

      </div>

      <BottomBar
        onToggleMic={handleToggleMic}
        onToggleScreen={handleToggleScreen}
        onLeave={handleLeave}
        onCloseRoom={isOwner ? handleCloseRoom : undefined}
        onObsLive={isOwner ? openObs : undefined}
      />

      {slug && <ObsBroadcastModal isOpen={obsOpen} onClose={closeObs} slug={slug} />}

      {/* Desktop Chromium: popped cameras render into a single always-on-top OS window. */}
      <DocumentPipPortal feeds={allFeeds} />

      <ReconnectingOverlay />
    </div>
  );
}
