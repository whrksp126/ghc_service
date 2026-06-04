// Mobile / Safari can host only ONE classic video Picture-in-Picture at a time — opening a second
// closes the first. To show several camera feeds at once we composite them onto a single <canvas>,
// captureStream() that canvas, and put THAT one video into PiP. Adding/removing feeds then just
// changes the canvas grid live (no new requestPictureInPicture, so it never fights the single-PiP
// limit). Feeds are drawn UN-mirrored, so a self-camera's text reads correctly in the PiP.
//
// Desktop Chromium uses Document PiP instead (real DOM in an OS window) — see floatingWindowStore
// + DocumentPipPortal. This module is only the mobile/Safari fallback.

interface Source {
  label: string;
  /** Offscreen <video> bound to the feed's track; sampled into the canvas each frame. */
  video: HTMLVideoElement;
}

// Offscreen but attached to the DOM: some mobile browsers won't decode frames from a detached
// <video>, which would leave the canvas (and thus the PiP) blank.
const OFFSCREEN = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';

function mkVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.autoplay = true;
  v.setAttribute('playsinline', '');
  (v as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
  v.style.cssText = OFFSCREEN;
  return v;
}

class CompositePipController {
  private canvas = document.createElement('canvas');
  /** The single video that actually goes into the OS PiP overlay. */
  private out = mkVideo();
  private outAttached = false;
  private sources = new Map<string, Source>();
  private raf = 0;
  private onExitCb: (() => void) | null = null;

  constructor() {
    this.canvas.width = 1280;
    this.canvas.height = 720;
    this.out.addEventListener('leavepictureinpicture', () => this.clear());
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

  /** Add (or replace the track of) a feed in the composite. Safe to call repeatedly. */
  add(id: string, track: MediaStreamTrack, label: string): void {
    const existing = this.sources.get(id);
    if (existing) {
      const cur = (existing.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
      if (cur !== track) existing.video.srcObject = new MediaStream([track]);
      existing.label = label;
    } else {
      const video = mkVideo();
      video.srcObject = new MediaStream([track]);
      document.body.appendChild(video);
      video.play().catch(() => {});
      this.sources.set(id, { label, video });
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
    s.video.srcObject = null;
    s.video.remove();
    this.sources.delete(id);
    if (this.sources.size === 0) this.clear();
  }

  /**
   * Enter the OS PiP overlay. MUST be called from within a user gesture the first time
   * (requestPictureInPicture requires user activation). No-op if already in PiP.
   */
  enter(): void {
    if (!this.outAttached) {
      document.body.appendChild(this.out);
      this.outAttached = true;
    }
    if (!this.out.srcObject) {
      const stream = (this.canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(24);
      this.out.srcObject = stream;
      this.out.play().catch(() => {});
    }
    if (document.pictureInPictureElement === this.out) return;
    const req = () =>
      (this.out as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> })
        .requestPictureInPicture?.();
    // Called synchronously within the click handler so user-activation holds. The canvas-captured
    // video may not have a decoded frame yet on the first tap → retry once on 'loadeddata' (still
    // inside the few-second transient-activation window the browser grants after the gesture).
    Promise.resolve(req()).catch(() => {
      const retry = () => {
        this.out.removeEventListener('loadeddata', retry);
        Promise.resolve(req()).catch(() => {});
      };
      this.out.addEventListener('loadeddata', retry);
    });
  }

  private startLoop(): void {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.drawOnce();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private drawOnce(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const items = [...this.sources.values()];
    const n = items.length;
    if (n === 0) {
      ctx.fillStyle = '#121212';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }

    // Stack feeds TOP-TO-BOTTOM (1 column) so each gets a full-width 16:9 cell — the PiP window
    // grows taller with each feed instead of squeezing them side-by-side. Fall back to a 2-column
    // grid only past 3 feeds so it doesn't become absurdly tall. The canvas (and thus the PiP
    // aspect ratio) is resized to match the layout.
    const CELL_W = 640;
    const CELL_H = 360; // 16:9 — matches the published track shape (1280×720)
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

    const cw = CELL_W;
    const ch = CELL_H;

    items.forEach((s, i) => {
      const cx = (i % cols) * cw;
      const cy = Math.floor(i / cols) * ch;
      const vw = s.video.videoWidth;
      const vh = s.video.videoHeight;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx + 2, cy + 2, cw - 4, ch - 4);
      ctx.clip();
      if (vw && vh && s.video.readyState >= 2) {
        // object-cover: scale to fill the cell, center-crop. Drawn un-mirrored on purpose so
        // a self-camera's text reads correctly in the PiP (fixes the mirrored-text complaint).
        const scale = Math.max(cw / vw, ch / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = cx + (cw - dw) / 2;
        const dy = cy + (ch - dh) / 2;
        ctx.drawImage(s.video, dx, dy, dw, dh);
      }
      // Label chip (bottom-left of the cell).
      ctx.font = '600 22px system-ui, sans-serif';
      const text = s.label || '';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(cx + 10, cy + ch - 40, tw + 20, 30);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, cx + 20, cy + ch - 19);
      ctx.restore();
    });
  }

  /** Tear everything down (called when the last feed leaves or the user closes the OS PiP). */
  private clear(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    for (const s of this.sources.values()) {
      s.video.srcObject = null;
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
