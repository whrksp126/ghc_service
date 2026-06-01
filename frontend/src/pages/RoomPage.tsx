import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { LayoutGroup } from 'framer-motion';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { useMediasoup } from '../hooks/useMediasoup';
import { useRoomStore } from '../stores/roomStore';
import { useDeviceStore } from '../stores/deviceStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { useCameraStore } from '../stores/cameraStore';
import { emitWithAck, getSocket } from '../lib/socket';
import { api } from '../lib/api';
import { useAlwaysOnCamera } from '../services/alwaysOnCamera';
import { attachVoice, detachVoice, useVoiceStore } from '../services/voiceActivity';
import { useAudioSettings, micConstraints, sensitivityToThreshold } from '../stores/audioSettings';
import { GridLayout } from '../components/room/GridLayout';
import { SpotlightLayout } from '../components/room/SpotlightLayout';
import { TopBar } from '../components/layout/TopBar';
import { BottomBar } from '../components/layout/BottomBar';
import { ReconnectingOverlay } from '../components/connection/ReconnectingOverlay';
import { LoadingScreen } from '../components/common/LoadingScreen';
import { MyDeviceDock } from '../components/room/MyDeviceDock';
import { CameraPreviewTile } from '../components/devices/CameraPreviewTile';
import { Button } from '../components/common/Button';
import { showToast } from '../components/common/Toast';
import { Mic, MicOff, Video, VideoOff, Users } from 'lucide-react';
import { initSounds, playSound } from '../lib/sounds';
import type { Participant, ProducerInfo } from '../types/room';

type RoomPhase = 'lobby' | 'connecting' | 'inRoom';

/** Hidden sink that plays a remote participant's audio track + taps it for voice activity. */
function RemoteAudio({ track, voiceKey }: { track: MediaStreamTrack; voiceKey: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
    attachVoice(voiceKey, track);
    return () => detachVoice(voiceKey);
  }, [track, voiceKey]);
  return <audio ref={ref} autoPlay playsInline />;
}

export function RoomPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { userId, nickname, deviceId } = useAuthStore();
  const {
    setRoom, clearRoom, setParticipants, setConnecting, isConnecting, consumers, participants,
  } = useRoomStore();
  const { isCamOn, setVideoTrack, setAudioTrack,
    setScreenSharing, isScreenSharing, setScreenTrack, reset: resetDevice,
  } = useDeviceStore();
  const { layoutMode, setLayoutMode, spotlightProducerId, setSpotlightProducer } = useUIStore();
  const { cameras, fetchCameras } = useCameraStore();

  const { connect, disconnect } = useSocket();
  const {
    loadDevice, createSendTransport, createRecvTransport,
    produce, consume, closeProducer, cleanup: cleanupMedia,
    producersRef, consumersRef,
  } = useMediasoup();

  const [phase, setPhase] = useState<RoomPhase>('lobby');
  const [isOwner, setIsOwner] = useState(false);
  const [localVideoTrack, setLocalVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [localScreenTrack, setLocalScreenTrack] = useState<MediaStreamTrack | null>(null);
  const localAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const joinedRef = useRef(false);
  const consumedProducerIds = useRef<Set<string>>(new Set());
  // Reconnection bookkeeping (re-establishing transports/producers/consumers).
  const sessionActiveRef = useRef(false);
  const reestablishingRef = useRef(false);
  const recvReadyRef = useRef(false);
  const earlyProducersRef = useRef<string[]>([]);

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
        const roomInfo = await api.getRoom(slug);
        if (roomInfo.room.hasPin && !inviteToken) {
          setNeedsPin(true);
        } else {
          await api.joinRoom(slug, undefined, inviteToken || undefined);
          setRoomJoined(true);
        }
      } catch (err: any) {
        if (err.message === 'PIN required') {
          setNeedsPin(true);
        } else {
          // Already a member, proceed
          setRoomJoined(true);
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

  // Consume each producer at most once (existing + new), so we never miss or
  // double-consume a feed (e.g. another of my devices joining concurrently).
  const consumeOnce = useCallback((producerId: string) => {
    if (consumedProducerIds.current.has(producerId)) return;
    consumedProducerIds.current.add(producerId);
    consume(producerId).catch(() => consumedProducerIds.current.delete(producerId));
  }, [consume]);

  // Idempotent room/media socket listeners (re-attachable on reconnect via off→on).
  const attachRoomListeners = useCallback((socket: ReturnType<typeof getSocket>) => {
    // Buffer producers that arrive before the recv transport is ready.
    socket.off('media:newProducer');
    socket.on('media:newProducer', (data: ProducerInfo) => {
      if (recvReadyRef.current) consumeOnce(data.producerId);
      else earlyProducersRef.current.push(data.producerId);
    });

    // dynacast: cap how many simulcast layers we send to what viewers watch.
    socket.off('media:producerSendChange');
    socket.on('media:producerSendChange', (data: { producerId: string; maxSpatialLayer: number }) => {
      const producer = producersRef.current.get(data.producerId);
      if (!producer || producer.kind !== 'video') return;
      producer.setMaxSpatialLayer(data.maxSpatialLayer).catch(() => {});
    });

    socket.off('media:producerClosed');
    socket.on('media:producerClosed', (data: { producerId: string }) => {
      consumedProducerIds.current.delete(data.producerId);
      for (const [consumerId, consumer] of consumersRef.current) {
        if (consumer.producerId === data.producerId) {
          consumer.close();
          consumersRef.current.delete(consumerId);
        }
      }
      useRoomStore.getState().removeConsumersByProducerId(data.producerId);
    });

    // Owner ended the room (or it was deleted) → leave gracefully.
    socket.off('room:closed');
    socket.on('room:closed', () => {
      sessionActiveRef.current = false;
      showToast('방이 종료되었습니다', 'info');
      navigate('/');
    });
  }, [consumeOnce, navigate, producersRef, consumersRef]);

  // Join the room + (re)build transports + consume existing producers. Reused on reconnect.
  const establishSession = useCallback(async () => {
    const socket = getSocket();
    recvReadyRef.current = false;
    earlyProducersRef.current = [];
    consumedProducerIds.current.clear();
    attachRoomListeners(socket);

    const result = await emitWithAck<{
      participants: Participant[];
      existingProducers: ProducerInfo[];
      iceServers: any[];
      isOwner: boolean;
    }>('room:join', { roomSlug: slug });

    setRoom(slug!, slug!);
    setParticipants(result.participants);
    setIsOwner(!!result.isOwner);

    await loadDevice();
    await createSendTransport();
    await createRecvTransport();
    recvReadyRef.current = true;

    for (const producer of result.existingProducers) consumeOnce(producer.producerId);
    for (const id of earlyProducersRef.current) consumeOnce(id);
  }, [slug, attachRoomListeners, consumeOnce, loadDevice, createSendTransport, createRecvTransport,
    setRoom, setParticipants]);

  // Re-publish whatever this device is currently sharing (used on reconnect).
  const republishCurrent = useCallback(async () => {
    const { isMicOn: micOn, isCamOn: camOn, isScreenSharing: screenOn } = useDeviceStore.getState();
    const alwaysOn = useAlwaysOnCamera.getState();
    let stream = alwaysOn.stream;
    if ((camOn || micOn) && (!stream || !stream.active)) {
      try { await alwaysOn.start(); stream = useAlwaysOnCamera.getState().stream; } catch { /* ignore */ }
    }
    if (stream) {
      const audioTrack = stream.getAudioTracks()[0];
      const videoTrack = stream.getVideoTracks()[0];
      if (micOn && audioTrack) {
        localAudioTrackRef.current = audioTrack;
        setAudioTrack(audioTrack);
        await produce(audioTrack, { mediaType: 'audio' });
      }
      if (camOn && videoTrack) {
        setLocalVideoTrack(videoTrack);
        setVideoTrack(videoTrack);
        await produce(videoTrack, { mediaType: 'video' });
      }
    }
    const screenTrack = useDeviceStore.getState().screenShare.track;
    if (screenOn && screenTrack && screenTrack.readyState === 'live') {
      await produce(screenTrack, { mediaType: 'screen' });
    }
  }, [produce, setAudioTrack, setVideoTrack]);

  // Full media rebuild after the socket reconnects (server treated us as fresh).
  const handleReconnect = useCallback(async () => {
    if (!sessionActiveRef.current || reestablishingRef.current) return;
    reestablishingRef.current = true;
    useRoomStore.getState().setReconnecting(true);
    try {
      cleanupMedia();
      await establishSession();
      await republishCurrent();
      useRoomStore.getState().setReconnecting(false);
    } catch {
      // Leave the overlay up; the next 'reconnect' tick will retry.
    } finally {
      reestablishingRef.current = false;
    }
  }, [cleanupMedia, establishSession, republishCurrent]);

  const joinRoom = useCallback(async () => {
    if (!slug || joinedRef.current) return;
    joinedRef.current = true;
    setConnecting(true);

    try {
      initSounds();
      const socket = connect();

      // Rebuild media whenever the underlying connection comes back.
      socket.io.off('reconnect');
      socket.io.on('reconnect', () => { handleReconnect(); });

      await establishSession();

      const shouldStreamCurrent = selectedCameras.has(deviceId || '');

      if (shouldStreamCurrent !== false) {
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
              video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
            });
          } catch {
            showToast('카메라/마이크 접근이 거부되었습니다', 'error');
          }
        }

        if (stream) {
          const audioTrack = stream.getAudioTracks()[0];
          const videoTrack = stream.getVideoTracks()[0];

          if (audioTrack) {
            localAudioTrackRef.current = audioTrack;
            setAudioTrack(audioTrack);
            const audioProducer = await produce(audioTrack, { mediaType: 'audio' });
            if (!lobbyMicOn && audioProducer) {
              audioTrack.stop();
              localAudioTrackRef.current = null;
              setAudioTrack(null);
              useDeviceStore.setState({ isMicOn: false });
              emitWithAck('media:pauseProducer', { producerId: audioProducer.id }).catch(() => {});
            }
          }

          if (videoTrack) {
            setLocalVideoTrack(videoTrack);
            setVideoTrack(videoTrack);
            const videoProducer = await produce(videoTrack, { mediaType: 'video' });
            if (!lobbyCamOn && videoProducer) {
              videoTrack.stop();
              setLocalVideoTrack(null);
              setVideoTrack(null);
              useDeviceStore.setState({ isCamOn: false });
              emitWithAck('media:pauseProducer', { producerId: videoProducer.id }).catch(() => {});
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
  }, [slug, connect, establishSession, handleReconnect, produce,
    setConnecting, setAudioTrack, setVideoTrack, navigate,
    lobbyMicOn, lobbyCamOn, selectedCameras, deviceId]);

  useEffect(() => {
    return () => {
      // Don't stop always-on camera tracks - they belong to the app
      sessionActiveRef.current = false;
      cleanupMedia();
      consumedProducerIds.current.clear();
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
      useDeviceStore.setState({ isMicOn: false });
      if (audioProducerId) {
        emitWithAck('media:pauseProducer', { producerId: audioProducerId }).catch(() => {});
      }
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micConstraints(),
        });
        const newAudioTrack = stream.getAudioTracks()[0];
        if (newAudioTrack && audioProducerId) {
          const producer = producersRef.current.get(audioProducerId);
          if (producer) {
            await producer.replaceTrack({ track: newAudioTrack });
          }
          localAudioTrackRef.current = newAudioTrack;
          setAudioTrack(newAudioTrack);
          emitWithAck('media:resumeProducer', { producerId: audioProducerId }).catch(() => {});
        }
        useDeviceStore.setState({ isMicOn: true });
      } catch {
        showToast('마이크를 다시 시작할 수 없습니다', 'error');
      }
    }
  }, [setAudioTrack]);

  const handleToggleCam = useCallback(async () => {
    const { videoInput, isCamOn: currentCamOn } = useDeviceStore.getState();
    const videoProducerId = videoInput.producerId;

    if (currentCamOn) {
      if (videoInput.track) videoInput.track.stop();
      setVideoTrack(null);
      setLocalVideoTrack(null);
      useDeviceStore.setState({ isCamOn: false });
      if (videoProducerId) {
        emitWithAck('media:pauseProducer', { producerId: videoProducerId }).catch(() => {});
      }
    } else {
      try {
        const alwaysOn = useAlwaysOnCamera.getState();
        const currentCamId = alwaysOn.activeCameraId;
        await alwaysOn.start(currentCamId || undefined);
        const newStream = useAlwaysOnCamera.getState().stream;
        const newVideoTrack = newStream?.getVideoTracks()[0];

        if (newVideoTrack && videoProducerId) {
          const producer = producersRef.current.get(videoProducerId);
          if (producer) {
            await producer.replaceTrack({ track: newVideoTrack });
          }
          setVideoTrack(newVideoTrack);
          setLocalVideoTrack(newVideoTrack);
          emitWithAck('media:resumeProducer', { producerId: videoProducerId }).catch(() => {});
        }
        useDeviceStore.setState({ isCamOn: true });
      } catch {
        showToast('카메라를 다시 시작할 수 없습니다', 'error');
      }
    }
  }, [setVideoTrack]);

  // Switch the current device's lens in-room: rotate the always-on camera and swap the
  // live producer's track so the new lens is what others (and the dock) see immediately.
  const handleSwitchCurrentCam = useCallback(async () => {
    const ao = useAlwaysOnCamera.getState();
    const { availableCameras, activeCameraId } = ao;
    if (availableCameras.length <= 1) return;
    const idx = availableCameras.findIndex((c) => c.deviceId === activeCameraId);
    const next = availableCameras[(idx + 1) % availableCameras.length];
    try {
      await ao.switchCamera(next.deviceId);
      const newTrack = useAlwaysOnCamera.getState().stream?.getVideoTracks()[0];
      const videoProducerId = useDeviceStore.getState().videoInput.producerId;
      if (newTrack) {
        if (videoProducerId) {
          const producer = producersRef.current.get(videoProducerId);
          if (producer) await producer.replaceTrack({ track: newTrack });
        }
        setVideoTrack(newTrack);
        setLocalVideoTrack(newTrack);
      }
    } catch {
      showToast('카메라 전환에 실패했습니다', 'error');
    }
  }, [setVideoTrack, producersRef]);

  const handleToggleScreen = useCallback(async () => {
    if (isScreenSharing) {
      const screenProducerId = useDeviceStore.getState().screenShare.producerId;
      if (screenProducerId) {
        await closeProducer(screenProducerId);
      }
      localScreenTrack?.stop();
      setLocalScreenTrack(null);
      setScreenTrack(null);
      setScreenSharing(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const videoTrack = stream.getVideoTracks()[0];
        setLocalScreenTrack(videoTrack);
        setScreenTrack(videoTrack);
        setScreenSharing(true);
        await produce(videoTrack, { mediaType: 'screen' });

        videoTrack.onended = () => {
          handleToggleScreen();
        };
      } catch {
        showToast('화면 공유가 취소되었습니다', 'info');
      }
    }
  }, [isScreenSharing, localScreenTrack, produce, closeProducer, setScreenTrack, setScreenSharing]);

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

  const handleSwitchLayout = useCallback(() => {
    const modes: ('grid' | 'spotlight')[] = ['grid', 'spotlight'];
    const currentIdx = modes.indexOf(layoutMode);
    setLayoutMode(modes[(currentIdx + 1) % modes.length]);
  }, [layoutMode, setLayoutMode]);

  // userId:deviceId → nickname/deviceLabel, so remote feeds show real names not raw ids.
  const participantLookup = useMemo(() => {
    const m = new Map<string, { nickname: string; deviceLabel: string }>();
    for (const p of participants) {
      m.set(`${p.userId}:${p.deviceId}`, { nickname: p.nickname, deviceLabel: p.deviceLabel });
    }
    return m;
  }, [participants]);

  // Main area = OTHER participants' camera feeds + any screen share (mine or theirs).
  // My own device cameras live in the dock, never the main grid.
  const feeds = useMemo(() => {
    const items: any[] = [];

    if (localScreenTrack) {
      items.push({
        id: 'local-screen',
        track: localScreenTrack,
        label: nickname || '나',
        deviceLabel: '화면 공유',
        isLocal: true,
        isScreen: true,
      });
    }

    for (const consumer of consumers) {
      if (consumer.kind !== 'video') continue;
      if (consumer.userId === userId) continue; // my own devices → dock
      const info = participantLookup.get(`${consumer.userId}:${consumer.deviceId}`);
      items.push({
        id: consumer.consumerId,
        track: consumer.track,
        label: info?.nickname || '참가자',
        deviceLabel: info?.deviceLabel || '',
        isMuted: false,
        isLocal: false,
        isScreen: false,
        voiceKey: `${consumer.userId}:${consumer.deviceId}`,
      });
    }

    return items;
  }, [consumers, participantLookup, nickname, userId, localScreenTrack]);

  // Remote audio is played through hidden <audio> sinks, not the video tiles (a video
  // element only renders one track). My own devices' audio is skipped to avoid echo.
  const audioConsumers = useMemo(
    () => consumers.filter((c) => c.kind === 'audio' && c.userId !== userId && c.track),
    [consumers, userId]
  );

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
  // sensitivity threshold. We pause/resume the audio *producer* (not the track) so the
  // local analyser keeps reading real audio and can re-open the gate when I speak again.
  const { noiseGate, sensitivity } = useAudioSettings();
  const myLevel = useVoiceStore((s) => (myVoiceKey ? s.levels[myVoiceKey] ?? 0 : 0));
  const audioProducerId = useDeviceStore((s) => s.audioInput.producerId);
  const gateOpenRef = useRef(true);
  const gateHoldRef = useRef(0);
  useEffect(() => {
    if (!localAudioTrack || !audioProducerId) return;
    if (!noiseGate) {
      // Gate disabled → make sure we're not leaving the producer paused.
      if (!gateOpenRef.current) {
        gateOpenRef.current = true;
        emitWithAck('media:resumeProducer', { producerId: audioProducerId }).catch(() => {});
      }
      return;
    }
    const now = Date.now();
    if (myLevel >= sensitivityToThreshold(sensitivity)) gateHoldRef.current = now + 400;
    const open = now < gateHoldRef.current;
    if (open !== gateOpenRef.current) {
      gateOpenRef.current = open;
      emitWithAck(open ? 'media:resumeProducer' : 'media:pauseProducer', { producerId: audioProducerId }).catch(() => {});
    }
  }, [noiseGate, sensitivity, myLevel, localAudioTrack, audioProducerId]);

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
        {feeds.length > 0 ? (
          <LayoutGroup>
            {layoutMode === 'grid' && (
              <GridLayout
                feeds={feeds}
                onFeedClick={(id) => {
                  setLayoutMode('spotlight');
                  setSpotlightProducer(id);
                }}
              />
            )}
            {layoutMode === 'spotlight' && (
              <SpotlightLayout
                feeds={feeds}
                spotlightId={spotlightProducerId}
                onFeedClick={(id) => setSpotlightProducer(id)}
              />
            )}
          </LayoutGroup>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-white/30 gap-2 px-6 text-center">
            <Users size={40} strokeWidth={1.5} />
            <p className="text-sm">아직 다른 참가자가 없습니다</p>
            <p className="text-xs text-white/20">내 기기는 아래에서 켜고 끌 수 있어요</p>
          </div>
        )}

      </div>

      <MyDeviceDock
        roomSlug={slug || ''}
        isCurrentCamOn={isCamOn}
        onToggleCurrentCam={handleToggleCam}
        onSwitchCurrentCam={handleSwitchCurrentCam}
        localVideoTrack={localVideoTrack}
      />

      <BottomBar
        onToggleMic={handleToggleMic}
        onToggleScreen={handleToggleScreen}
        onLeave={handleLeave}
        onSwitchLayout={handleSwitchLayout}
        onCloseRoom={isOwner ? handleCloseRoom : undefined}
      />

      <ReconnectingOverlay />
    </div>
  );
}
