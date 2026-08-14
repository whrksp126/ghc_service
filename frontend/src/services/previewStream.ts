import { getSocket } from '../lib/socket';
import { useAlwaysOnCamera } from './alwaysOnCamera';

const FALLBACK_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// ── Streamer side (remote device) ──

interface OutgoingPreview {
  pc: RTCPeerConnection;
  viewerSocketId: string;
}

const outgoing = new Map<string, OutgoingPreview>();

/** Half-resolution, 24fps, 1.2Mbps ceiling for the P2P preview sender. */
function capPreviewEncoding(pc: RTCPeerConnection): void {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    for (const enc of params.encodings) {
      enc.maxBitrate = 1_200_000;
      enc.maxFramerate = 24;
      enc.scaleResolutionDownBy = 2;
    }
    void sender.setParameters(params).catch(() => {});
  } catch {
    /* older browser without setParameters encodings — leave it uncapped */
  }
}

export function setupPreviewStreamer() {
  const socket = getSocket();

  socket.on('preview:requested', async ({ viewerSocketId, iceServers }) => {
    try {
      let cam = useAlwaysOnCamera.getState();
      let videoTrack = cam.getVideoTrack();

      if (!videoTrack) {
        await cam.start();
        cam = useAlwaysOnCamera.getState();
        videoTrack = cam.getVideoTrack();
      }

      if (!videoTrack) {
        console.warn('[preview-streamer] no video track after start attempt');
        socket.emit('preview:noTrack', { targetSocketId: viewerSocketId, reason: 'no_camera' });
        return;
      }

      const existing = outgoing.get(viewerSocketId);
      if (existing) {
        existing.pc.close();
        outgoing.delete(viewerSocketId);
      }

      const servers = iceServers?.length ? iceServers : FALLBACK_ICE;
      const pc = new RTCPeerConnection({ iceServers: servers });

      const stream = new MediaStream([videoTrack]);
      const audioTrack = cam.getAudioTrack();
      if (audioTrack) stream.addTrack(audioTrack);

      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }

      // A preview is a small tile, but an unconstrained sender ramps the full capture (1080p on
      // desktop / 720p on a phone) up to several Mbps — pure encoder heat and battery on the
      // device being previewed, for pixels nobody can see. Cap it at half resolution / 1.2Mbps.
      capPreviewEncoding(pc);

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('preview:ice', { targetSocketId: viewerSocketId, candidate: e.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          outgoing.delete(viewerSocketId);
        }
      };

      outgoing.set(viewerSocketId, { pc, viewerSocketId });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('preview:offer', { targetSocketId: viewerSocketId, sdp: offer.sdp });
    } catch (err) {
      console.error('[preview-streamer] error:', err);
    }
  });

  socket.on('preview:answer', async ({ viewerSocketId, sdp }) => {
    const entry = outgoing.get(viewerSocketId);
    if (!entry) return;
    if (entry.pc.signalingState !== 'have-local-offer') return;
    try {
      await entry.pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (err) {
      console.error('[preview-streamer] setRemoteDescription error:', err);
    }
  });

  socket.on('preview:ice', async ({ fromSocketId, candidate }) => {
    const entry = outgoing.get(fromSocketId);
    if (entry) {
      await entry.pc.addIceCandidate(candidate).catch(() => {});
    }
  });

  socket.on('preview:stopped', ({ viewerSocketId }) => {
    const entry = outgoing.get(viewerSocketId);
    if (entry) {
      entry.pc.close();
      outgoing.delete(viewerSocketId);
    }
  });
}

function replaceTrackInAllOutgoing(newVideoTrack: MediaStreamTrack | null) {
  if (!newVideoTrack) return;
  for (const [, entry] of outgoing) {
    const sender = entry.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) {
      sender.replaceTrack(newVideoTrack).catch(() => {});
    }
  }
}

export function setupCameraChangeListener() {
  let prevCameraId = useAlwaysOnCamera.getState().activeCameraId;
  return useAlwaysOnCamera.subscribe((state) => {
    if (state.activeCameraId !== prevCameraId) {
      prevCameraId = state.activeCameraId;
      const videoTrack = state.getVideoTrack();
      if (videoTrack && outgoing.size > 0) {
        replaceTrackInAllOutgoing(videoTrack);
      }
    }
  });
}

export function cleanupAllOutgoing() {
  for (const [, entry] of outgoing) {
    entry.pc.close();
  }
  outgoing.clear();
}

// ── Viewer side (CamerasPage device) ──

export type PreviewStatus = 'connecting' | 'live' | 'no_camera' | 'failed';

export interface PreviewConnection {
  deviceId: string;
  close: () => void;
}

export function requestPreview(
  targetDeviceId: string,
  onStream: (stream: MediaStream) => void,
  onDisconnect: () => void,
  onStatusChange?: (status: PreviewStatus) => void,
): PreviewConnection {
  const socket = getSocket();
  let pc: RTCPeerConnection | null = null;
  let streamerSocketId: string | null = null;
  let closed = false;
  let offerReceived = false;

  onStatusChange?.('connecting');

  const handleOffer = async ({ streamerSocketId: sid, streamerDeviceId, sdp, iceServers: offerIceServers }: any) => {
    if (streamerDeviceId !== targetDeviceId || closed) return;
    offerReceived = true;

    try {
      streamerSocketId = sid;

      if (pc) pc.close();

      const servers = offerIceServers?.length ? offerIceServers : FALLBACK_ICE;
      pc = new RTCPeerConnection({ iceServers: servers });

      pc.ontrack = (e) => {
        if (closed) return;
        if (e.track.kind === 'video') {
          const stream = e.streams[0] || new MediaStream([e.track]);
          onStream(stream);
          onStatusChange?.('live');
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate && streamerSocketId) {
          socket.emit('preview:ice', { targetSocketId: streamerSocketId, candidate: e.candidate });
        }
      };

      pc.onconnectionstatechange = () => {
        if (!pc) return;
        const state = pc.connectionState;
        if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          if (!closed) {
            onStatusChange?.('failed');
            onDisconnect();
          }
        }
      };

      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('preview:answer', { targetSocketId: streamerSocketId, sdp: answer.sdp });
    } catch (err) {
      console.error('[preview-viewer] handleOffer error:', err);
      if (!closed) {
        onStatusChange?.('failed');
        onDisconnect();
      }
    }
  };

  const handleIce = async ({ fromSocketId, candidate }: any) => {
    if (fromSocketId !== streamerSocketId || !pc) return;
    await pc.addIceCandidate(candidate).catch(() => {});
  };

  const handleNoTrack = ({ streamerDeviceId, reason }: any) => {
    if (streamerDeviceId !== targetDeviceId || closed) return;
    onStatusChange?.(reason === 'no_camera' ? 'no_camera' : 'failed');
    onDisconnect();
  };

  // 1. Register listeners FIRST
  socket.on('preview:offer', handleOffer);
  socket.on('preview:ice', handleIce);
  socket.on('preview:noTrack', handleNoTrack);

  // 2. Request preview
  function sendRequest() {
    if (closed) return;
    socket.emit('preview:request', { targetDeviceId }, (res: any) => {
      if (res?.error) {
        console.warn('[preview-viewer] request failed:', res.error);
        if (!closed) {
          onStatusChange?.('failed');
          onDisconnect();
        }
        return;
      }
    });
  }

  if (socket.connected) {
    sendRequest();
  } else {
    socket.once('connect', sendRequest);
  }

  // 3. Timeout: if no offer received within 15 seconds, mark as failed
  const timeoutId = setTimeout(() => {
    if (!offerReceived && !closed) {
      onStatusChange?.('failed');
      onDisconnect();
    }
  }, 15000);

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeoutId);
    socket.off('connect', sendRequest);
    socket.off('preview:offer', handleOffer);
    socket.off('preview:ice', handleIce);
    socket.off('preview:noTrack', handleNoTrack);
    if (socket.connected) {
      socket.emit('preview:stop', { targetDeviceId });
    }
    if (pc) {
      pc.close();
      pc = null;
    }
  };

  return { deviceId: targetDeviceId, close };
}
