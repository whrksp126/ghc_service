import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../../games/motion';

interface Piece {
  x: number; y: number; vx: number; vy: number;
  size: number; rot: number; vr: number; color: string;
}

/**
 * 손으로 굴리는 캔버스 컨페티(외부 의존성 없음). 결과 오버레이에서 1등 발표 때 한 번 터진다.
 * `prefers-reduced-motion`이면 아무것도 그리지 않는다.
 */
export function Confetti({ colors, count = 90 }: { colors: string[]; count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const palette = colors.length > 0 ? colors : ['#FE2C55', '#25F4EE'];
    const pieces: Piece[] = Array.from({ length: count }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.5,
      y: H * 0.35 + (Math.random() - 0.5) * 40,
      vx: (Math.random() - 0.5) * 6,
      vy: -4 - Math.random() * 6,
      size: 4 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: palette[Math.floor(Math.random() * palette.length)],
    }));

    let raf = 0;
    const started = performance.now();
    const frame = () => {
      ctx.clearRect(0, 0, W, H);
      for (const p of pieces) {
        p.vy += 0.22;            // 중력
        p.vx *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, 1 - (performance.now() - started) / 2600);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (performance.now() - started < 2600) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [colors, count]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />;
}
