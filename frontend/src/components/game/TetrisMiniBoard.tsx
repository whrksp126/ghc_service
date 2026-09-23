import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { COLS, ROWS, type TetrisFrame } from '../../games/tetris/types';
import { colorOfCell, isGhostCell } from '../../games/tetris/ui';
import { useTetrisStore } from '../../stores/tetrisStore';

interface TetrisMiniBoardProps {
  userId: string;
  nickname: string;
  color: string;
  frame?: TetrisFrame;
  /** 서버가 확정한 탈락 여부(프레임이 끊겨도 회색으로 보여야 한다) */
  dead?: boolean;
  /** 카드 너비(px) — 아레나가 상대 수에 따라 정한다 */
  width?: number;
}

/**
 * 상대 미니보드 (설계서 §T6).
 * **클릭해도 확대되지 않는다** — 내 판이 항상 가장 크다(사천성 v2.1 결정 계승).
 */
export function TetrisMiniBoard({
  userId, nickname, color, frame, dead, width = 96,
}: TetrisMiniBoardProps) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const alive = frame ? frame.alive && !dead : !dead;
  const pending = frame?.pending ?? 0;

  /**
   * 이 사람이 4줄(또는 4줄 이상 공격)을 날리면 미니보드가 짧게 번쩍인다.
   * `tetris:sent` 로 이미 들어와 있는 fx 를 읽기만 하므로 새 소켓/스토어 필드가 필요 없다.
   */
  const bigHit = useTetrisStore((s) => {
    for (let i = s.fxQueue.length - 1; i >= 0; i--) {
      const f = s.fxQueue[i];
      if (f.type === 'attack' && f.from === userId && (f.kind === 'tetris' || (f.amount ?? 0) >= 4)) {
        return f.id;
      }
    }
    return 0;
  });

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cell = Math.max(2, Math.floor(width / COLS));
    const w = cell * COLS;
    const h = cell * ROWS;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(5,8,16,0.9)';
    ctx.fillRect(0, 0, w, h);

    const cells = frame?.cells;
    if (cells) {
      for (let i = 0; i < cells.length; i++) {
        const v = cells[i];
        if (!v || isGhostCell(v)) continue;
        const c = colorOfCell(v);
        if (!c) continue;
        // 미니보드는 1~4px 칸이라 입체 베벨이 뭉개진다 → 단색 + 살짝 어두운 아래쪽만.
        ctx.fillStyle = alive ? c : '#4B5563';
        ctx.fillRect((i % COLS) * cell, Math.floor(i / COLS) * cell, cell - 0.5, cell - 0.5);
      }
    }
    ctx.strokeStyle = alive ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }, [frame, alive, width]);

  return (
    <div
      data-ghc-mini={userId}
      data-ghc-board={userId}
      data-ghc-pending={pending}
      data-ghc-lines={frame?.lines ?? 0}
      data-ghc-alive={alive ? '1' : '0'}
      className={`relative shrink-0 rounded-xl bg-white/5 p-1.5 ${alive ? '' : 'opacity-60'}`}
      style={{ boxShadow: `inset 0 0 0 1px ${alive ? `${color}66` : 'rgba(255,255,255,0.08)'}` }}
    >
      <div className="relative">
        <canvas ref={cvRef} className="block rounded" />
        {/* 받을 줄 경고 — 미니보드 왼쪽에 붙는 작은 빨간 바 */}
        {pending > 0 && alive && (
          <motion.span
            className="absolute -left-1 bottom-0 w-1 rounded-full bg-danger"
            animate={{ height: `${Math.min(100, pending * 10)}%`, opacity: [0.7, 1, 0.7] }}
            transition={{ opacity: { duration: 0.8, repeat: Infinity } }}
          />
        )}
        {bigHit > 0 && (
          <motion.span
            key={bigHit}
            className="pointer-events-none absolute inset-0 rounded bg-secondary"
            initial={{ opacity: 0.75 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.34 }}
          />
        )}
        {!alive && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded bg-black/70 px-1.5 py-0.5 font-display text-[11px] font-black italic text-white/90">
              K.O.
            </span>
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1" style={{ maxWidth: width }}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 flex-1 truncate text-[10px] text-white/70">{nickname}</span>
        <span className="shrink-0 font-display text-[10px] tabular-nums text-white/90">{frame?.lines ?? 0}</span>
      </div>
      {pending > 0 && alive && (
        <p className="text-[9px] leading-none text-danger">
          +{pending}줄
        </p>
      )}
    </div>
  );
}
