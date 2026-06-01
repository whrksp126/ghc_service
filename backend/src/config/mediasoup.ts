import { types as mediasoupTypes } from 'mediasoup';
import os from 'os';

const numWorkers = parseInt(process.env.NUM_WORKERS || '') || Math.min(os.cpus().length, 4);

export const mediasoupConfig = {
  numWorkers,

  worker: {
    rtcMinPort: parseInt(process.env.RTC_MIN_PORT || '40000'),
    rtcMaxPort: parseInt(process.env.RTC_MAX_PORT || '40100'),
    logLevel: 'warn' as mediasoupTypes.WorkerLogLevel,
    logTags: [
      'info',
      'ice',
      'dtls',
      'rtp',
      'srtp',
      'rtcp',
    ] as mediasoupTypes.WorkerLogTag[],
  },

  router: {
    mediaCodecs: [
      {
        kind: 'audio' as const,
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video' as const,
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
      },
      {
        kind: 'video' as const,
        mimeType: 'video/VP9',
        clockRate: 90000,
        parameters: {
          'profile-id': 2,
          'x-google-start-bitrate': 1000,
        },
      },
    ] as mediasoupTypes.RtpCodecCapability[],
  },

  webRtcTransport: {
    listenIps: [
      {
        ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
      },
    ],
    maxIncomingBitrate: 10000000,
    initialAvailableOutgoingBitrate: 6000000,
    minimumAvailableOutgoingBitrate: 1000000,
    maxSctpMessageSize: 262144,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  },
};

// Kept in sync with the client-side encodings in frontend/src/hooks/useMediasoup.ts.
// Two layers: a tiny thumbnail + a full-res HD layer (the HD layer claims the uplink).
export const simulcastEncodings = [
  { maxBitrate: 250000, scaleResolutionDownBy: 4, rid: 'r0', scalabilityMode: 'L1T3' },
  { maxBitrate: 5000000, scaleResolutionDownBy: 1, rid: 'r1', scalabilityMode: 'L1T3' },
];
