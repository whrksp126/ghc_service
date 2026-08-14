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
  /** Tiny scratch buffer used to fake the ambient blur — see drawOnce(). */
  private glowBuf = document.createElement('canvas');
  /** The single video that actually goes into the OS PiP overlay. */
  private out = mkVideo();
  private outAttached = false;
  private sources = new Map<string, Source>();
  private timer = 0;
  private onExitCb: (() => void) | null = null;
  /** Shared canvas captureStream (one stream feeds both the OS-PiP <video> and the inline overlay). */
  private stream: MediaStream | null = null;
  /** Inline (in-page) floating overlay — the fallback when the browser blocks the PiP API
   *  (e.g. mobile Chrome with Picture-in-Picture disabled at the device level). */
  private floatEl: HTMLDivElement | null = null;
  private onFs = () => this.placeFloat();

  constructor() {
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.out.style.cssText = OUT_HIDDEN;
    this.out.addEventListener('leavepictureinpicture', () => this.clear());
  }

  private ensureStream(): MediaStream {
    if (!this.stream) {
      this.stream = (this.canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(24);
    }
    return this.stream;
  }

  inlineActive(): boolean {
    return !!this.floatEl;
  }

  /**
   * Show the combined feeds in a draggable in-page floating window (no PiP API). When an element
   * goes HTML5-fullscreen, the overlay is re-parented INTO it so it stays visible above the
   * fullscreen video — letting the user watch a fullscreen live AND see the call at once on any
   * browser, including ones where requestPictureInPicture is disabled.
   */
  enterInline(): void {
    this.startLoop();
    if (!this.floatEl) {
      const box = document.createElement('div');
      box.style.cssText =
        'position:fixed;right:12px;bottom:96px;width:150px;z-index:2147483647;border-radius:12px;overflow:hidden;' +
        'box-shadow:0 6px 28px rgba(0,0,0,.55);background:#000;touch-action:none;cursor:grab;user-select:none;';
      const v = mkVideo();
      v.srcObject = this.ensureStream();
      v.style.cssText = 'width:100%;height:auto;display:block;pointer-events:none;';
      v.play().catch(() => {});
      box.appendChild(v);
      // Close button.
      const close = document.createElement('button');
      close.textContent = '✕';
      close.setAttribute('aria-label', '닫기');
      close.style.cssText =
        'position:absolute;top:4px;right:4px;width:22px;height:22px;border:none;border-radius:50%;' +
        'background:rgba(0,0,0,.55);color:#fff;font-size:12px;line-height:22px;padding:0;cursor:pointer;';
      close.addEventListener('pointerdown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => { e.stopPropagation(); this.clear(); });
      box.appendChild(close);
      this.makeDraggable(box);
      this.floatEl = box;
    }
    this.placeFloat();
    document.addEventListener('fullscreenchange', this.onFs);
    document.addEventListener('webkitfullscreenchange', this.onFs);
  }

  /** Keep the floating overlay inside the current fullscreen element (so it shows over fullscreen),
   *  else on <body>. */
  private placeFloat(): void {
    if (!this.floatEl) return;
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const host = (document.fullscreenElement || doc.webkitFullscreenElement || document.body) as HTMLElement;
    if (this.floatEl.parentElement !== host) host.appendChild(this.floatEl);
  }

  private makeDraggable(box: HTMLDivElement): void {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    box.addEventListener('pointerdown', (e) => {
      dragging = true;
      box.setPointerCapture(e.pointerId);
      const r = box.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      box.style.cursor = 'grabbing';
    });
    box.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nx = Math.max(4, ox + (e.clientX - sx));
      const ny = Math.max(4, oy + (e.clientY - sy));
      box.style.left = nx + 'px'; box.style.top = ny + 'px';
      box.style.right = 'auto'; box.style.bottom = 'auto';
    });
    const end = (e: PointerEvent) => { dragging = false; try { box.releasePointerCapture(e.pointerId); } catch { /* */ } box.style.cursor = 'grab'; };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  private removeFloat(): void {
    document.removeEventListener('fullscreenchange', this.onFs);
    document.removeEventListener('webkitfullscreenchange', this.onFs);
    if (this.floatEl) { this.floatEl.remove(); this.floatEl = null; }
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
    if (this.sources.size === 0 && document.pictureInPictureElement !== this.out && !this.floatEl) return;
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
  enter(): Promise<string | null> {
    const fmt = (e: { name?: string; message?: string } | undefined) =>
      `${e?.name || 'Err'}:${(e?.message || '').slice(0, 90)}`;
    if (!this.outAttached) {
      document.body.appendChild(this.out);
      this.outAttached = true;
    }
    if (!this.out.srcObject) {
      try {
        this.out.srcObject = this.ensureStream();
      } catch (e) {
        return Promise.resolve('captureStream:' + fmt(e as { message?: string }));
      }
      this.out.play().catch(() => {});
    }
    if (document.pictureInPictureElement === this.out) return Promise.resolve(null);
    const req = () =>
      (this.out as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> })
        .requestPictureInPicture?.();
    // Called synchronously within the click handler so user-activation holds. Resolves null on
    // success, or the error string (name:message) so the caller can show WHY it failed.
    return Promise.resolve(req())
      .then(() => null as string | null)
      .catch((e) => new Promise<string | null>((resolve) => {
        let done = false;
        const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
        const retry = () => {
          this.out.removeEventListener('loadeddata', retry);
          Promise.resolve(req()).then(() => finish(null)).catch((e2) => finish(fmt(e2)));
        };
        // The out video may not have a frame yet → retry on loadeddata; if that already fired, retry
        // once shortly; give up with the original error after a moment so we always resolve.
        this.out.addEventListener('loadeddata', retry);
        setTimeout(() => { if (!done) { this.out.removeEventListener('loadeddata', retry); Promise.resolve(req()).then(() => finish(null)).catch((e3) => finish(fmt(e3))); } }, 400);
        setTimeout(() => finish(fmt(e)), 1500);
      }));
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
        // PERF: `ctx.filter = 'blur(30px)'` is a real Gaussian convolution over the whole cell and
        // runs on the CPU in most browsers — at 24fps it was the most expensive thing in the PiP
        // loop by a wide margin. Downscale to a 32px-wide scratch buffer and stretch it back up
        // instead: the bilinear upscale IS the blur, at a fraction of the cost, and it looks the same
        // once it's sitting behind the video at 70% opacity.
        {
          const gw = vw * scale;
          const gh = vh * scale;
          const bw = 32;
          const bh = Math.max(1, Math.round((bw * vh) / vw));
          if (this.glowBuf.width !== bw || this.glowBuf.height !== bh) {
            this.glowBuf.width = bw;
            this.glowBuf.height = bh;
          }
          const bctx = this.glowBuf.getContext('2d');
          if (bctx) {
            bctx.drawImage(s.video, 0, 0, bw, bh);
            ctx.save();
            ctx.globalAlpha = 0.7;
            // Overdraw a little so the soft edge bleeds past the video, as the blur used to.
            const pad = Math.min(cw, ch) * 0.06;
            ctx.drawImage(
              this.glowBuf,
              cx + (cw - gw) / 2 - pad, cy + (ch - gh) / 2 - pad,
              gw + pad * 2, gh + pad * 2,
            );
            ctx.restore();
          }
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
    this.removeFloat();
    try {
      if (document.pictureInPictureElement === this.out) document.exitPictureInPicture();
    } catch {
      /* already gone */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.out.srcObject = null;
    this.onExitCb?.();
  }
}

export const compositePip = new CompositePipController();
