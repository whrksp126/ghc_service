import { useEffect, useRef } from 'react';
import { setTetrisPainter, type BoardFx } from '../../hooks/useTetrisGame';
import { COLS, PIECE_COLORS, ROWS } from '../../games/tetris/types';
import {
  CLEAR_PHASE, DANGER_ROW_INDEX, FX_MS, PIECE_SHAPE, WIPE_STAGE_MS,
  colorOfCell, drawGhost, drawTile, isActiveCell, isGhostCell, wipeStageOfCol,
} from '../../games/tetris/ui';
import { clamp01, comboGlow, easeOutCubic, easeOutQuad } from '../../games/tetris/fx';

/**
 * 내 보드 캔버스 (설계서 §T6).
 * 200칸을 DOM 으로 60fps 리렌더하면 버벅이므로 캔버스로 그리고, React 는 여기서 **한 번도**
 * 렌더되지 않는다(`setTetrisPainter` 로 루프가 직접 호출).
 */
/**
 * 한 칸의 최소 px (설계서 §Z1 불변식).
 * 6px × 10칸 = 60px → 상대 미니보드(좁은 창에서 50px, 넓은 창에서 90px)보다 절대 작아지지 않는다.
 * 아레나가 판 행에 최소 높이를 보장하므로 이 하한에 걸려 판이 상자 밖으로 넘치는 일은 없다.
 */
const MIN_CELL = 6;

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

      // --- 줄 지움 타임라인 (§Z4: 가운데→바깥 와이프 → 위 블록 낙하) ---------------
      let clearT = -1;
      let fallT = 1;
      if (fx.clear) {
        clearT = clamp01((fx.now - fx.clear.start) / fx.clear.ms);
        fallT = easeOutCubic(clamp01((clearT - CLEAR_PHASE.fall) / (1 - CLEAR_PHASE.fall)));
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

      /* --- 지워지는 줄: NES 식 가운데→바깥 5단계 와이프 (§Z4-1) --------------------
         엔진은 락 즉시 줄을 접으므로 `cells` 에는 이 줄이 이미 없다. 여기서 **직전 프레임에
         읽어 둔 원래 색**으로 다시 그려 주는 게 연출의 전부다.
         셀 루프보다 **먼저** 그려야 위에서 내려앉는 블록이 자연스럽게 이 줄을 덮는다. */
      if (fx.clear) {
        const cl = fx.clear;
        const el = fx.now - cl.start;
        for (let i = 0; i < cl.rows.length; i++) {
          const y = oy + cl.rows[i] * cell;
          for (let c = 0; c < COLS; c++) {
            const t = (el - wipeStageOfCol(c) * WIPE_STAGE_MS) / WIPE_STAGE_MS;
            if (t >= 1) continue;                    // 이 열은 이미 사라졌다
            const x = ox + c * cell;
            const color = cl.colors[i * COLS + c] || cl.color;
            if (t <= 0) { drawTile(ctx, x, y, cell, color); continue; }
            // 사라지는 순간: 칸이 가운데로 오므라들면서 하얗게 달아오른다
            const k = 1 - t;
            const inset = (cell * (1 - k)) / 2;
            drawTile(ctx, x + inset, y + inset, cell * k, color, { bright: true, alpha: 0.4 + 0.6 * k });
            // 섬광은 **칸 하나 크기**로만. 여기서 세게 때리면 4줄일 때 판 전체가 하얗게 날아간다.
            ctx.fillStyle = `rgba(255,255,255,${(Math.sin(t * Math.PI) * 0.5).toFixed(3)})`;
            ctx.fillRect(x, y, cell, cell);
          }
        }
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

      // 4줄 = Tetris Effect 식 바닥 폭발: 지워진 밴드가 하얗게 달아오르며 위아래로 번진다.
      // (reduced-motion 이면 생략 — 와이프만 남긴다)
      if (fx.clear && fx.clear.big && !fx.reduced) {
        let top = ROWS;
        let bot = 0;
        for (const r of fx.clear.rows) { if (r < top) top = r; if (r + 1 > bot) bot = r + 1; }
        // 빠르게 꺼지는 감쇠(3제곱) — 밴드가 오래 빛나면 판이 하얗게 날아가 조각이 안 보인다.
        const a = (1 - clearT) * (1 - clearT) * (1 - clearT);
        const grow = cell * 4 * easeOutCubic(clearT);
        const y0 = oy + top * cell;
        const y1 = oy + bot * cell;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,255,255,${(0.3 * a).toFixed(3)})`;
        ctx.fillRect(ox, y0, bw, y1 - y0);
        ctx.fillStyle = `rgba(165,243,252,${(0.16 * a).toFixed(3)})`;
        ctx.fillRect(ox, y0 - grow, bw, grow);
        ctx.fillRect(ox, y1, bw, grow);
        ctx.restore();
      }

      // 4줄 = 판 전체 시안 플래시 + 세로 광선
      if (fx.beam) {
        // 세로 광선은 **가운데→바깥 와이프를 가리면 안 된다** — 판 전체를 덮는 시안 막은
        // 얇게(0.2 → 0.1), 광선도 절반 세기로. 4줄 "번쩍"은 아레나 screen 플래시가 따로 담당한다.
        const t = clamp01((fx.now - fx.beam.start) / FX_MS.beam);
        const a = (1 - t) * (1 - t);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(37,244,238,${0.1 * a})`;
        ctx.fillRect(ox, oy, bw, bh);
        const beam = ctx.createLinearGradient(0, oy, 0, oy + bh);
        beam.addColorStop(0, `rgba(165,243,252,${0.28 * a})`);
        beam.addColorStop(0.5, `rgba(37,244,238,${0.18 * a})`);
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

      /* 가로 광선 (§Z4-4) — 지워진 줄에서 좌우 **판 밖으로** 빛이 빠져나간다.
         클립 밖에서 그려야 판을 넘어갈 수 있다. 그라디언트 객체를 매 프레임 만들지 않으려고
         밝기가 다른 사각형 3장을 겹쳐 같은 감쇠를 낸다. */
      if (fx.clear) {
        const cl = fx.clear;
        const a = (1 - clearT) * (1 - clearT);
        const reach = bw * (0.28 + 0.62 * easeOutCubic(clearT));
        const th = Math.max(1, cell * (0.9 - 0.45 * clearT));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const r of cl.rows) {
          const yc = oy + r * cell + cell / 2 - th / 2;
          for (let k = 0; k < 3; k++) {
            const len = (reach * (k + 1)) / 3;
            ctx.fillStyle = `rgba(255,255,255,${(a * 0.3 * (1 - k / 3)).toFixed(3)})`;
            ctx.fillRect(ox - len, yc, len, th);
            ctx.fillRect(ox + bw, yc, len, th);
          }
        }
        ctx.restore();
      }

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
      const availW = Math.max(40, Math.floor(rect.width));
      const availH = Math.max(40, Math.floor(rect.height));
      /**
       * **캔버스가 상자를 그대로 채우지 않는다** (설계서 §Z1).
       * 예전에는 상자 크기를 그대로 캔버스로 써서, 창이 좁아 상자가 818×79 로 눌리면
       * 칸이 3px 이 돼 플레이가 불가능했다. 이제는 상자 안에서 `min(w, h/2)` 로
       * **1:2 판**을 만들고 남는 자리는 비워 둔다 — 어떤 폭에서도 비율이 깨지지 않는다.
       */
      const cell = Math.max(MIN_CELL, Math.floor(Math.min(availW / COLS, availH / ROWS)));
      const bw = cell * COLS;
      const bh = cell * ROWS;
      // 좌우 여백 — 가로 광선(§Z4-4)이 판 밖으로 빠져나갈 자리. 없으면 잘려서 안 보인다.
      const pad = Math.round(cell * 0.6);
      const w = bw + pad * 2;
      const h = bh;
      cv.width = Math.floor(w * dpr);
      cv.height = Math.floor(h * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
      const ctx = cv.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      geomRef.current = { cell, ox: pad, oy: 0, w, h };
      // 검증(E2E)이 "실제로 그려진 판"을 잴 수 있게 — 캔버스에는 광선 여백이 섞여 있다.
      box.dataset.ghcBoardW = String(bw);
      box.dataset.ghcBoardH = String(bh);
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
