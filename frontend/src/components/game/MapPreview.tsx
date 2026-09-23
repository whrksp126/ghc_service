import { useMemo } from 'react';
import { previewMask } from '../../games/shisen/engine';
import { BOARD_DIMS, type GameOptions } from '../../games/types';

/**
 * 로비 맵 실루엣 썸네일. 마스크를 작은 사각형 점으로 그린다(§V5).
 * `mapShape: 'random'`이면 "매 판 랜덤"이라는 뜻이므로 시드로 뽑은 **예시**를 보여 준다.
 */
export function MapPreview({
  options, seed, width = 168, compact,
}: { options: GameOptions; seed: number; width?: number; compact?: boolean }) {
  const { cols, rows } = BOARD_DIMS[options.boardSize];
  const mask = useMemo(() => {
    try {
      return previewMask(options, seed);
    } catch {
      return [] as boolean[];
    }
  }, [options, seed]);

  const dot = Math.max(3, Math.floor(width / cols) - 1);
  const gap = 1;
  const w = cols * (dot + gap) - gap;
  const h = rows * (dot + gap) - gap;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: w, height: h }}>
        {Array.from({ length: cols * rows }).map((_, i) => {
          if (!mask[i]) return null;
          const r = Math.floor(i / cols);
          const c = i % cols;
          return (
            <span
              key={i}
              className="absolute rounded-[2px] bg-[#EDE4D3]"
              style={{ left: c * (dot + gap), top: r * (dot + gap), width: dot, height: dot }}
            />
          );
        })}
      </div>
      {!compact && (
        <p className="text-[10px] text-white/40">
          {options.mapShape === 'random' ? '🎲 매 판 랜덤 (예시)' : `${cols}×${rows} 격자`}
          {options.specials.walls && ' · 벽 포함'}
        </p>
      )}
    </div>
  );
}
