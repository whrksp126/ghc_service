import { useEffect, useRef } from 'react';
import { setTetrisPainter, type BoardFx } from '../../hooks/useTetrisGame';
import { COLS, PIECE_COLORS, ROWS } from '../../games/tetris/types';
import {
  CLEAR_PHASE, DANGER_ROW_INDEX, FX_MS, PIECE_SHAPE,
  colorOfCell, drawGhost, drawTile, isActiveCell, isGhostCell,
} from '../../games/tetris/ui';
import { clamp01, comboGlow, easeOutCubic, easeOutQuad } from '../../games/tetris/fx';

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
      // 화면 흔들림은 **아레나 컨테이너**(HOLD/NEXT/게이지 포함)가 통째로 담당한다.
      // 캔버스만 흔들면 보드와 주변 UI가 따로 놀아서 싸구려로 보인다.

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

      // 위험선 — 스택이 이 위로 올라오면 곧 탑아웃이다. 위험할수록 진해진다.
      const dy = oy + DANGER_ROW_INDEX * cell;
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = `rgba(254,44,85,${0.35 + 0.45 * fx.danger})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ox, dy + 0.5);
      ctx.lineTo(ox + bw, dy + 0.5);
      ctx.stroke();
      ctx.restore();

      // --- 줄 지움 타임라인 (번쩍 → 수축 → 낙하) --------------------------------
      let clearT = -1;
      let fallT = 1;
      if (fx.clear) {
        clearT = clamp01((fx.now - fx.clear.start) / fx.clear.ms);
        fallT = easeOutCubic(clamp01((clearT - CLEAR_PHASE.shrink) / (1 - CLEAR_PHASE.shrink)));
      }
      /** 위 블록은 "접기 전 위치"에서 시작해 제자리로 내려앉는다(음수 = 위쪽). */
      const rowShift = (row: number) =>
        fx.clear ? -(fx.clear.shift[row] ?? 0) * cell * (1 - fallT) : 0;

      // --- 보드 내용(판 안에서만 그린다) -----------------------------------------
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, bw, bh);
      ctx.clip();

      // 쓰레기 줄이 밀고 올라온 직후: 판 내용을 아래에서 위로 밀어 올린다.
      if (fx.rise) {
        const t = easeOutQuad(clamp01((fx.now - fx.rise.start) / FX_MS.rise));
        ctx.translate(0, (1 - t) * cell);
      }

      // 하드드롭 잔상 — 조각이 지나간 열에 세로 그라디언트
      if (fx.trail) {
        const t = clamp01((fx.now - fx.trail.start) / FX_MS.trail);
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

      // 락 대기 중이면 조각이 깜빡인다 — 락 딜레이가 눈에 보여야 컨트롤이 는다(§T6.1).
      const blink = fx.lockDelay > 0
        ? 0.62 + 0.38 * Math.cos(fx.now * (0.02 + 0.05 * fx.lockDelay))
        : 1;

      // 셀
      const lockT = fx.lock ? 1 - clamp01((fx.now - fx.lock.start) / FX_MS.lock) : 0;
      const baseAlpha = fx.alive ? 1 : 0.35;
      for (let i = 0; i < cells.length; i++) {
        const v = cells[i];
        if (!v) continue;
        const row = (i / COLS) | 0;
        const x = ox + (i % COLS) * cell;
        const ghost = isGhostCell(v);
        const active = isActiveCell(v);
        // 현재 조각/그림자는 낙하 연출을 따라가면 안 된다(중력과 싸워 떨려 보인다).
        const y = oy + row * cell + (active || ghost ? 0 : rowShift(row));
        if (ghost) { drawGhost(ctx, x, y, cell); continue; }
        const color = colorOfCell(v);
        if (!color) continue;
        drawTile(ctx, x, y, cell, color, {
          bright: active,
          alpha: active ? baseAlpha * blink : baseAlpha,
        });
      }

      // 줄 파편 + 착지 먼지 (풀 재사용 — 매 프레임 배열을 만들지 않는다)
      fx.particles.draw(ctx, ox, oy, cell);

      // 줄 지움: ① 흰 번쩍 → ② 가운데로 수축
      if (fx.clear && clearT < CLEAR_PHASE.shrink) {
        const sT = easeOutQuad(
          clamp01((clearT - CLEAR_PHASE.flash) / (CLEAR_PHASE.shrink - CLEAR_PHASE.flash)),
        );
        const width = bw * (1 - sT);
        const left = ox + (bw - width) / 2;
        for (const r of fx.clear.rows) {
          const y = oy + r * cell;
          ctx.fillStyle = `rgba(255,255,255,${0.95 - 0.2 * sT})`;
          ctx.fillRect(left, y, width, cell);
          // 지운 조각 색 테두리 — 흰색만이면 어떤 블록이 터졌는지 안 읽힌다.
          ctx.fillStyle = fx.clear.color;
          ctx.globalAlpha = 0.55 * (1 - sT);
          ctx.fillRect(left, y, width, Math.max(1, cell * 0.14));
          ctx.fillRect(left, y + cell - Math.max(1, cell * 0.14), width, Math.max(1, cell * 0.14));
          ctx.globalAlpha = 1;
        }
      }

      // 4줄 = 판 전체 시안 플래시 + 세로 광선
      if (fx.beam) {
        const t = clamp01((fx.now - fx.beam.start) / FX_MS.beam);
        const a = 1 - t;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(37,244,238,${0.2 * a})`;
        ctx.fillRect(ox, oy, bw, bh);
        const beam = ctx.createLinearGradient(0, oy, 0, oy + bh);
        beam.addColorStop(0, `rgba(165,243,252,${0.5 * a})`);
        beam.addColorStop(0.5, `rgba(37,244,238,${0.32 * a})`);
        beam.addColorStop(1, 'rgba(37,244,238,0)');
        ctx.fillStyle = beam;
        const bwidth = cell * (0.18 + 0.5 * t);
        for (let c = 0; c < COLS; c++) {
          ctx.fillRect(ox + c * cell + (cell - bwidth) / 2, oy, bwidth, bh);
        }
        ctx.restore();
      }

      // T-스핀 = 보라 파문(원형 링 2겹이 퍼져 나간다)
      if (fx.ring) {
        const t = clamp01((fx.now - fx.ring.start) / FX_MS.ring);
        const cx = ox + fx.ring.x * cell;
        const cy = oy + fx.ring.y * cell;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let k = 0; k < 2; k++) {
          const tt = clamp01(t - k * 0.2);
          if (tt <= 0 || tt >= 1) continue;
          ctx.strokeStyle = `rgba(168,85,247,${0.8 * (1 - tt)})`;
          ctx.lineWidth = Math.max(1, cell * 0.3 * (1 - tt));
          ctx.beginPath();
          ctx.arc(cx, cy, easeOutCubic(tt) * cell * 7.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.restore();  // 보드 클립 해제

      // 락 직후 1프레임 화이트 플래시 — "붙었다"는 촉감
      if (lockT > 0) {
        ctx.fillStyle = `rgba(255,255,255,${0.22 * lockT})`;
        ctx.fillRect(ox, oy, bw, bh);
      }

      // 퍼펙트 클리어 — 판 전체가 하얗게 번쩍
      if (fx.flash) {
        const t = clamp01((fx.now - fx.flash.start) / FX_MS.flash);
        ctx.fillStyle = `rgba(255,255,255,${0.75 * (1 - t) * (1 - t)})`;
        ctx.fillRect(ox, oy, bw, bh);
      }

      // 죽었으면 회색 막
      if (!fx.alive) {
        ctx.fillStyle = 'rgba(10,12,18,0.55)';
        ctx.fillRect(ox, oy, bw, bh);
      }

      // 테두리 — 기본 + 콤보 글로우 + 위험 맥박
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + 1, oy + 1, bw - 2, bh - 2);

      if (fx.combo >= 2 && fx.alive) {
        // 콤보가 유지되는 동안 테두리에 콤보 색 글로우가 **계속** 걸려 있다.
        const glow = comboGlow(fx.combo);
        ctx.save();
        ctx.shadowColor = glow;
        ctx.shadowBlur = Math.min(26, 8 + fx.combo * 2.5);
        ctx.strokeStyle = glow;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(ox + 1.5, oy + 1.5, bw - 3, bh - 3);
        ctx.restore();
      }

      if (fx.danger >= 0.8 && fx.alive) {
        const pulse = 0.5 + 0.5 * Math.sin(fx.now / 140);
        ctx.save();
        ctx.shadowColor = '#EF4444';
        ctx.shadowBlur = 10 + 18 * pulse;
        ctx.strokeStyle = `rgba(239,68,68,${0.45 + 0.45 * pulse})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(ox + 1.5, oy + 1.5, bw - 3, bh - 3);
        ctx.restore();
      }

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
