import { useEffect, useRef } from 'react';
import { setTetrisPainter, type BoardFx } from '../../hooks/useTetrisGame';
import { COLS, PIECE_COLORS, ROWS } from '../../games/tetris/types';
import {
  DANGER_ROW_INDEX, FX_MS, PIECE_SHAPE, colorOfCell, drawGhost, drawTile, isActiveCell, isGhostCell,
} from '../../games/tetris/ui';

/**
 * 내 보드 캔버스 (설계서 §T6).
 * 200칸을 DOM 으로 60fps 리렌더하면 버벅이므로 캔버스로 그리고, React 는 여기서 **한 번도**
 * 렌더되지 않는다(`setTetrisPainter` 로 루프가 직접 호출).
 */
export function TetrisCanvas({ className = '' }: { className?: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  /** 마지막으로 그린 프레임 — 리사이즈 직후에도 빈 화면이 되지 않도록 보관 */
  const lastRef = useRef<{ cells: number[]; fx: BoardFx } | null>(null);
  const geomRef = useRef({ cell: 0, ox: 0, oy: 0, w: 0, h: 0 });

  useEffect(() => {
    const box = boxRef.current;
    const cv = cvRef.current;
    if (!box || !cv) return;

    const paint = (cells: number[], fx: BoardFx) => {
      lastRef.current = { cells, fx };
      const ctx = cv.getContext('2d');
      const g = geomRef.current;
      if (!ctx || g.cell <= 0) return;
      const { cell, ox, oy, w, h } = g;
      const bw = cell * COLS;
      const bh = cell * ROWS;

      ctx.save();
      ctx.clearRect(0, 0, w, h);

      // 하드드롭 착지 진동 — 캔버스 전체를 2px 흔든다(레이아웃을 건드리지 않는다).
      if (fx.shake) {
        const t = (fx.now - fx.shake.start) / FX_MS.shake;
        if (t < 1) ctx.translate(0, Math.sin(t * Math.PI * 3) * 2 * (1 - t));
      }

      // 판 바탕
      ctx.fillStyle = 'rgba(5,8,16,0.92)';
      ctx.fillRect(ox, oy, bw, bh);

      // 격자
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < COLS; c++) {
        ctx.moveTo(ox + c * cell + 0.5, oy);
        ctx.lineTo(ox + c * cell + 0.5, oy + bh);
      }
      for (let r = 1; r < ROWS; r++) {
        ctx.moveTo(ox, oy + r * cell + 0.5);
        ctx.lineTo(ox + bw, oy + r * cell + 0.5);
      }
      ctx.stroke();

      // 위험선 — 스택이 이 위로 올라오면 곧 탑아웃이다.
      const dy = oy + DANGER_ROW_INDEX * cell;
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(254,44,85,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ox, dy + 0.5);
      ctx.lineTo(ox + bw, dy + 0.5);
      ctx.stroke();
      ctx.restore();

      // 쓰레기 줄이 밀고 올라온 직후: 판 전체를 아래에서 위로 밀어 올린다.
      if (fx.rise) {
        const t = Math.min(1, (fx.now - fx.rise.start) / FX_MS.rise);
        ctx.translate(0, (1 - t) * cell);
      }

      // 하드드롭 잔상 — 조각이 지나간 열에 세로 그라디언트
      if (fx.trail) {
        const t = Math.min(1, (fx.now - fx.trail.start) / FX_MS.trail);
        const y0 = oy + fx.trail.fromRow * cell;
        const y1 = oy + (fx.trail.toRow + 1) * cell;
        const grad = ctx.createLinearGradient(0, y0, 0, y1);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(1, fx.trail.color);
        ctx.save();
        ctx.globalAlpha = 0.45 * (1 - t);
        ctx.fillStyle = grad;
        for (const c of fx.trail.cols) ctx.fillRect(ox + c * cell + cell * 0.15, y0, cell * 0.7, y1 - y0);
        ctx.restore();
      }

      // 셀
      const lockT = fx.lock ? 1 - Math.min(1, (fx.now - fx.lock.start) / FX_MS.lock) : 0;
      for (let i = 0; i < cells.length; i++) {
        const v = cells[i];
        if (!v) continue;
        const x = ox + (i % COLS) * cell;
        const y = oy + Math.floor(i / COLS) * cell;
        if (isGhostCell(v)) { drawGhost(ctx, x, y, cell); continue; }
        const color = colorOfCell(v);
        if (!color) continue;
        drawTile(ctx, x, y, cell, color, {
          bright: isActiveCell(v),
          alpha: fx.alive ? 1 : 0.35,
        });
      }

      // 락 직후 1프레임 화이트 플래시 — "붙었다"는 촉감
      if (lockT > 0) {
        ctx.fillStyle = `rgba(255,255,255,${0.22 * lockT})`;
        ctx.fillRect(ox, oy, bw, bh);
      }

      // 줄 지움 섬광 → 가로로 수축
      if (fx.clear) {
        const t = Math.min(1, (fx.now - fx.clear.start) / FX_MS.clear);
        for (const r of fx.clear.rows) {
          if (r < 0 || r >= ROWS) continue;
          const y = oy + r * cell;
          const shrink = (bw / 2) * t;
          ctx.fillStyle = `rgba(255,255,255,${0.95 * (1 - t)})`;
          ctx.fillRect(ox + shrink, y, bw - shrink * 2, cell);
        }
      }

      // 죽었으면 회색 막
      if (!fx.alive) {
        ctx.fillStyle = 'rgba(10,12,18,0.55)';
        ctx.fillRect(ox, oy, bw, bh);
      }

      // 테두리
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + 1, oy + 1, bw - 2, bh - 2);
      ctx.restore();
    };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = box.getBoundingClientRect();
      const w = Math.max(40, Math.floor(rect.width));
      const h = Math.max(40, Math.floor(rect.height));
      // 10:20 비율을 유지하면서 컨테이너에 꽉 채운다.
      const cell = Math.max(4, Math.floor(Math.min(w / COLS, h / ROWS)));
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const ctx = cv.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      geomRef.current = {
        cell,
        ox: Math.floor((w - cell * COLS) / 2),
        oy: Math.floor((h - cell * ROWS) / 2),
        w, h,
      };
      const last = lastRef.current;
      if (last) paint(last.cells, { ...last.fx, now: performance.now() });
    };

    resize();
    setTetrisPainter(paint);
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    return () => {
      ro.disconnect();
      setTetrisPainter(null);
    };
  }, []);

  return (
    <div
      ref={boxRef}
      data-ghc-tetris="1"
      className={`relative flex items-center justify-center ${className}`}
    >
      <canvas ref={cvRef} className="block" />
    </div>
  );
}

/** HOLD / NEXT 미리보기 한 칸. 회전 규칙은 엔진 소관이라 여기서는 rot 0 만 그린다. */
export function PiecePreview({
  id, box = 56, dim = false,
}: { id: number; box?: number; dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.floor(box * dpr);
    cv.height = Math.floor((box / 2) * dpr);
    cv.style.width = `${box}px`;
    cv.style.height = `${box / 2}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box, box / 2);
    if (!id) return;
    const shape = PIECE_SHAPE[id as keyof typeof PIECE_SHAPE];
    const color = PIECE_COLORS[id];
    if (!shape || !color) return;
    const cell = box / 4.6;
    const xs = shape.map((p) => p[0]);
    const ys = shape.map((p) => p[1]);
    const ox = (box - (Math.max(...xs) - Math.min(...xs) + 1) * cell) / 2 - Math.min(...xs) * cell;
    const oy = (box / 2 - (Math.max(...ys) - Math.min(...ys) + 1) * cell) / 2 - Math.min(...ys) * cell;
    ctx.globalAlpha = dim ? 0.35 : 1;
    for (const [x, y] of shape) drawTile(ctx, ox + x * cell, oy + y * cell, cell, color);
  }, [id, box, dim]);

  return <canvas ref={ref} className="block" />;
}
