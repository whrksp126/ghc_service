#!/bin/sh
set -eu

# Keep LiveKit compatibility and the 720p ABR encoder in separate processes/readers. If Ingress
# backpressures its RTMP socket, it must never stop the HLS fallback encoder or the original HLS.
input="rtsp://127.0.0.1:${RTSP_PORT}/${MTX_PATH}"
key="${G1}"

ffmpeg -nostdin -loglevel warning -rtsp_transport tcp -i "$input" \
  -map 0:v -map '0:a?' -c copy -f flv "${LIVEKIT_RTMP_TARGET}/x/${key}" &
livekit_pid=$!

ffmpeg -nostdin -loglevel warning -rtsp_transport tcp -i "$input" \
  -map 0:v -map '0:a?' \
  -vf 'scale=-2:720' -c:v libx264 -preset veryfast -threads 2 \
  -b:v 1800k -maxrate 2000k -bufsize 3600k -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a copy -f flv "rtmp://127.0.0.1:1935/abr/${key}" &
abr_pid=$!

cleanup() {
  kill "$livekit_pid" "$abr_pid" 2>/dev/null || true
  wait "$livekit_pid" "$abr_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Exit and let MediaMTX restart the hook if either independent branch dies.
while kill -0 "$livekit_pid" 2>/dev/null && kill -0 "$abr_pid" 2>/dev/null; do sleep 1; done
exit 1
