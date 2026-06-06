// Mobile / Safari can host only ONE classic video Picture-in-Picture at a time — opening a second
// closes the first. To show several camera feeds at once we composite them onto a single <canvas>,
// captureStream() that canvas, and put THAT one video into PiP. Adding/removing feeds then just
// changes the canvas grid live (no new requestPictureInPicture, so it never fights the single-PiP
// limit). Feeds are drawn UN-mirrored, so a self-camera's text reads correctly in the PiP.
//
// Desktop Chromium uses Document PiP instead (real DOM in an OS window) — see floatingWindowStore
// + DocumentPipPortal. This module is only the mobile/Safari fallback.

import type { RemoteTrack } from 'livekit-client';
import { useVoiceStore, SPEAKING_THRESHOLD } from '../services/voiceActivity';

interface Source {
  label: string;
  /** Mirror this cell horizontally (front/selfie cameras only). */
  mirror: boolean;
  /** Raw track (used for local feeds via srcObject). */
  track: MediaStreamTrack;
  /** LiveKit remote track, when this is a peer's feed — attached so adaptiveStream keeps it live. */
  lkTrack?: RemoteTrack;
  /** <video> bound to the feed's track; sampled into the canvas each frame. */
  video: HTMLVideoElement;
  /** Key into the voice-activity store (`${userId}:${deviceId}` or `obs:<room>`). The feed id can
   *  differ (e.g. the local feed id is `self:<deviceId>`), so the waveform looks this up. */
  voiceKey?: string;
}

// The PiP output video can sit fully off-viewport (it's a canvas captureStream, not a LiveKit track).
// This is the long-working layout (incl. mobile Chrome) — keep it as-is.
const OUT_HIDDEN = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
// Source videos MUST stay inside the viewport (opacity:0, behind everything). LiveKit adaptiveStream
// pauses a remote track when no *visible* element displays it; an off-viewport element counts as
// hidden → the tile freezes in the PiP. Keeping them in-viewport (just invisible) keeps frames flowing.
// Size matters: adaptiveStream picks the simulcast layer from the ELEMENT size, so a tiny element
// gets a low-res layer → blurry PiP. Use a 720p box so we receive a sharp layer to composite.
const SOURCE_HIDDEN = 'position:fixed;top:0;left:0;width:1280px;height:720px;opacity:0;pointer-events:none;z-index:-1;';

function mkVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.autoplay = true;
  v.setAttribute('playsinline', '');
  (v as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  return v;
}

class CompositePipController {
  private canvas = document.createElement('canvas');
  /** The single video that actually goes into the OS PiP overlay. */
  private out = mkVideo();
  private outAttached = false;
  private sources = new Map<string, Source>();
  private timer = 0;
  private onExitCb: (() => void) | null = null;

  constructor() {
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.out.style.cssText = OUT_HIDDEN;
    this.out.addEventListener('leavepictureinpicture', () => this.clear());
  }

  private bind(s: Source): void {
    if (s.lkTrack) s.lkTrack.attach(s.video);
    else s.video.srcObject = new MediaStream([s.track]);
    s.video.play().catch(() => {});
  }

  private unbind(s: Source): void {
    if (s.lkTrack) {
      try { s.lkTrack.detach(s.video); } catch { /* ignore */ }
    }
    s.video.srcObject = null;
  }

  /** Called once so the room can restore in-grid tiles when the user closes the OS PiP. */
  setOnExit(cb: () => void) {
    this.onExitCb = cb;
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  get count(): number {
    return this.sources.size;
  }

  /** Add (or replace the track of) a feed in the composite. Safe to call repeatedly. Pass the
   *  LiveKit RemoteTrack for peer feeds so adaptiveStream keeps the subscription flowing. */
  add(id: string, track: MediaStreamTrack, label: string, mirror = false, lkTrack?: RemoteTrack, voiceKey?: string): void {
    const existing = this.sources.get(id);
    if (existing) {
      existing.label = label;
      existing.mirror = mirror;
      existing.voiceKey = voiceKey;
      if (existing.track !== track || existing.lkTrack !== lkTrack) {
        this.unbind(existing);
        existing.track = track;
        existing.lkTrack = lkTrack;
        this.bind(existing);
      }
    } else {
      const video = mkVideo();
      video.style.cssText = SOURCE_HIDDEN;
      document.body.appendChild(video);
      const s: Source = { label, mirror, track, lkTrack, video, voiceKey };
      this.sources.set(id, s);
      this.bind(s);
    }
    this.drawOnce(); // give captureStream a frame immediately (so requestPictureInPicture is ready)
    this.startLoop();
  }

  /** Force-tear-down (e.g. leaving the room) so a closed PiP doesn't linger on frozen tracks. */
  stop(): void {
    if (this.sources.size === 0 && document.pictureInPictureElement !== this.out) return;
    this.clear();
  }

  remove(id: string): void {
    const s = this.sources.get(id);
    if (!s) return;
    this.unbind(s);
    s.video.remove();
    this.sources.delete(id);
    if (this.sources.size === 0) this.clear();
  }

  /**
   * Enter the OS PiP overlay. MUST be called from within a user gesture the first time
   * (requestPictureInPicture requires user activation). No-op if already in PiP.
   */
  enter(): Promise<boolean> {
    if (!this.outAttached) {
      document.body.appendChild(this.out);
      this.outAttached = true;
    }
    if (!this.out.srcObject) {
      const stream = (this.canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(24);
      this.out.srcObject = stream;
      this.out.play().catch(() => {});
    }
    if (document.pictureInPictureElement === this.out) return Promise.resolve(true);
    const req = () =>
      (this.out as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> })
        .requestPictureInPicture?.();
    // Called synchronously within the click handler so user-activation holds. The canvas-captured
    // video may not have a decoded frame yet on the first tap → retry once on 'loadeddata' (still
    // inside the few-second transient-activation window the browser grants after the gesture).
    return Promise.resolve(req())
      .then(() => true)
      .catch((e) => {
        console.warn('[compositePip] requestPictureInPicture failed, retrying on loadeddata', e?.name, e?.message);
        return new Promise<boolean>((resolve) => {
          const retry = () => {
            this.out.removeEventListener('loadeddata', retry);
            Promise.resolve(req()).then(() => resolve(true)).catch((e2) => {
              console.warn('[compositePip] requestPictureInPicture retry failed', e2?.name, e2?.message);
              resolve(false);
            });
          };
          this.out.addEventListener('loadeddata', retry);
        });
      });
  }

  private startLoop(): void {
    if (this.timer) return;
    // setInterval (not requestAnimationFrame) so the composite keeps redrawing even when the tab is
    // backgrounded — which is exactly when PiP is used. Background tabs throttle it but don't pause
    // it outright, so the PiP stays live instead of freezing on the last frame.
    this.timer = window.setInterval(() => this.drawOnce(), 1000 / 24);
  }

  private drawOnce(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const items = [...this.sources.entries()];
    const n = items.length;
    if (n === 0) {
      ctx.fillStyle = '#121212';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }

    // Every cell is a FIXED 16:9 landscape box; each feed is drawn object-contain (letterboxed),
    // so a portrait/rotated feed shows fully with side bars instead of stretching the PiP tall —
    // the same way desktop Document PiP renders. ≤3 feeds stack top-to-bottom; 4+ use a 2-col grid.
    // A single feed gets a 720p cell (sharp live); multi-feed cells are smaller to cap canvas size.
    const single = n === 1;
    const CELL_W = single ? 1280 : 640;
    const CELL_H = single ? 720 : 360; // 16:9
    const cols = n <= 3 ? 1 : 2;
    const rows = Math.ceil(n / cols);
    const W = cols * CELL_W;
    const H = rows * CELL_H;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, W, H);

    const levels = useVoiceStore.getState().levels;
    items.forEach(([id, s], i) => {
      const cx = (i % cols) * CELL_W;
      const cy = Math.floor(i / cols) * CELL_H;
      const cw = CELL_W;
      const ch = CELL_H;
      const vw = s.video.videoWidth;
      const vh = s.video.videoHeight;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, cy, cw, ch);
      ctx.clip();
      if (vw && vh && s.video.readyState >= 2) {
        // object-contain: fit the whole frame inside the cell (letterbox), never crop. Mirror
        // front/selfie cells so the composite matches the in-grid view (back stays readable).
        const scale = Math.min(cw / vw, ch / vh);
        // Ambient glow: a blurred copy the SAME size as the contained video, drawn just behind it,
        // so the blur fringe bleeds only a little past the edges (a soft halo) instead of filling
        // the whole letterbox. Clipped to the cell so it never leaks into neighbouring tiles.
        {
          const gw = vw * scale;
          const gh = vh * scale;
          ctx.save();
          ctx.filter = 'blur(30px)';
          ctx.globalAlpha = 0.7;
          ctx.drawImage(s.video, cx + (cw - gw) / 2, cy + (ch - gh) / 2, gw, gh);
          ctx.restore();
        }
        const dw = vw * scale;
        const dh = vh * scale;
        const dy = cy + (ch - dh) / 2;
        if (s.mirror) {
          // Flip horizontally within this cell, isolated so the label below isn't mirrored.
          ctx.save();
          ctx.translate(cx + cw, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(s.video, cw - (cw - dw) / 2 - dw, dy, dw, dh);
          ctx.restore();
        } else {
          ctx.drawImage(s.video, cx + (cw - dw) / 2, dy, dw, dh);
        }
      }
      // Label chip (bottom-left of the cell).
      ctx.font = '600 22px system-ui, sans-serif';
      const text = s.label || '';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(cx + 12, cy + ch - 42, tw + 22, 32);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, cx + 23, cy + ch - 20);

      // Voice-activity bars (bottom-right) — shows when this participant is speaking, like the
      // in-grid tiles, so you can tell who's talking from the PiP.
      const level = levels[s.voiceKey ?? id] ?? 0;
      if (level > SPEAKING_THRESHOLD) {
        const bars = 4;
        const bw = 5;
        const gap = 4;
        const maxH = 26;
        const baseY = cy + ch - 14;
        const startX = cx + cw - 14 - bars * (bw + gap);
        ctx.fillStyle = '#25F4EE'; // secondary
        for (let b = 0; b < bars; b++) {
          const phase = Date.now() / 110 + b * 0.9;
          const amp = Math.min(1, level / 0.25) * (0.45 + 0.55 * Math.abs(Math.sin(phase)));
          const h = 4 + amp * maxH;
          const x = startX + b * (bw + gap);
          ctx.beginPath();
          ctx.roundRect(x, baseY - h, bw, h, 2);
          ctx.fill();
        }
      }
      ctx.restore();
    });
  }

  /** Tear everything down (called when the last feed leaves or the user closes the OS PiP). */
  private clear(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = 0;
    }
    for (const s of this.sources.values()) {
      this.unbind(s);
      s.video.remove();
    }
    this.sources.clear();
    try {
      if (document.pictureInPictureElement === this.out) document.exitPictureInPicture();
    } catch {
      /* already gone */
    }
    (this.out.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
    this.out.srcObject = null;
    this.onExitCb?.();
  }
}

export const compositePip = new CompositePipController();
