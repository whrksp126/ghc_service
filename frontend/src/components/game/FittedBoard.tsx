import { useLayoutEffect, useRef, useState } from 'react';
import { ShisenBoard, BOARD_GAP, boardBox } from './ShisenBoard';
import type { Board } from '../../games/types';

/** 보드를 올려 두는 트레이 여백(px, 좌우·상하 합) */
const TRAY_PAD = 20;

interface FittedBoardProps {
  board: Board;
  interactive: boolean;
  minCell?: number;
  maxCell?: number;
  /** 테마 트레이 클래스 */
  tray?: string;
  /** 모바일 세로에서 위쪽 정렬 */
  alignTop?: boolean;
}

/**
 * 컨테이너를 실측해 `cellPx`를 구하고 보드를 가운데(모바일은 위쪽) 배치한다.
 * 맵 마스크의 바운딩 박스 기준이라 빈 가장자리 때문에 타일이 작아지지 않는다.
 */
export function FittedBoard({
  board, interactive, minCell = 14, maxCell, tray, alignTop,
}: FittedBoardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [cellPx, setCellPx] = useState(minCell);
  const bbox = boardBox(board);
  const bCols = bbox.c1 - bbox.c0 + 1;
  const bRows = bbox.r1 - bbox.r0 + 1;
  // 타일 수가 적을수록 크게 — 넓은 패널에서 작은 맵이 허전하지 않도록.
  const cap = maxCell ?? (bCols * bRows <= 90 ? 84 : 68);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const raw = Math.floor(Math.min((w - TRAY_PAD) / bCols, (h - TRAY_PAD) / bRows)) - BOARD_GAP;
      setCellPx(Math.max(minCell, Math.min(cap, raw)));
    };
    measure(el.clientWidth, el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) measure(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [bCols, bRows, minCell, cap]);

  return (
    <div
      ref={ref}
      // overflow-hidden이면 자리가 모자랄 때 바깥 줄이 소리 없이 잘린다 → 스크롤로.
      className={`flex h-full min-h-0 w-full min-w-0 justify-center overflow-auto scrollbar-none ${
        alignTop ? 'items-start md:items-center' : 'items-center'
      }`}
    >
      <div
        data-ghc-board={board.id}
        className={`flex items-center justify-center p-[10px] ${tray ?? ''}`}
      >
        <ShisenBoard board={board} interactive={interactive} cellPx={cellPx} />
      </div>
    </div>
  );
}
