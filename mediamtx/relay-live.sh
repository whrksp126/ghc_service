#!/bin/sh
set -eu

# Keep LiveKit compatibility and the 720p ABR encoder in separate processes/readers. If Ingress
# backpressures its RTMP socket, it must never stop the HLS fallback encoder or the original HLS.
input="rtsp://127.0.0.1:${RTSP_PORT}/${MTX_PATH}"
key="${G1}"

start_livekit() {
  ffmpeg -nostdin -loglevel warning -rtsp_transport tcp -i "$input" \
    -map 0:v -map '0:a?' -c copy -f flv "${LIVEKIT_RTMP_TARGET}/x/${key}" &
  livekit_pid=$!
}

start_abr() {
  ffmpeg -nostdin -loglevel warning -rtsp_transport tcp -i "$input" \
    -map 0:v -map '0:a?' \
    -vf 'scale=-2:720' -c:v libx264 -preset veryfast -threads 2 \
    -b:v 1800k -maxrate 2000k -bufsize 3600k -g 60 -keyint_min 60 -sc_threshold 0 \
    -c:a copy -f flv "rtmp://127.0.0.1:1935/abr/${key}" &
  abr_pid=$!
}

start_livekit
start_abr

cleanup() {
  kill "$livekit_pid" "$abr_pid" 2>/dev/null || true
  wait "$livekit_pid" "$abr_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Restart only the failed branch. Ingress backpressure/restarts can no longer reset HLS, and an ABR
# encoder restart does not remove the room's LiveKit participant.
while :; do
  if ! kill -0 "$livekit_pid" 2>/dev/null; then
    wait "$livekit_pid" 2>/dev/null || true
    sleep 1
    start_livekit
  fi
  if ! kill -0 "$abr_pid" 2>/dev/null; then
    wait "$abr_pid" 2>/dev/null || true
    sleep 1
    start_abr
  fi
  sleep 1
done
