import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTetrisStore } from '../../stores/tetrisStore';
import { BADGE_GRADIENT, FX_MS } from '../../games/tetris/ui';
import { prefersReducedMotion } from '../../games/motion';

/**
 * 대형 배지(TETRIS! / T-SPIN DOUBLE! / B2B xN) + 4줄 화면 플래시.
 * 사천성 v4 결정 계승 — **떴다가 즉시 사라진다**. 화면에 절대 쌓이지 않는다.
 */
export function TetrisHud() {
  const badge = useTetrisStore((s) => s.badge);
  const fxQueue = useTetrisStore((s) => s.fxQueue);
  const clearBadge = useTetrisStore((s) => s.clearBadge);
  const consumeFx = useTetrisStore((s) => s.consumeFx);
  const reduced = prefersReducedMotion();

  // 배지는 수명이 고정 — 새 배지가 오면 이전 타이머는 id 비교로 자동 무력화된다.
  useEffect(() => {
    if (!badge) return;
    const id = badge.id;
    const t = setTimeout(() => clearBadge(id), FX_MS.badge);
    return () => clearTimeout(t);
  }, [badge, clearBadge]);

  // 4줄/퍼펙트 = 화면 전체 시안 플래시. 소비하면 큐에서 지운다.
  const flash = fxQueue.find((f) => f.type === 'screen');
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => consumeFx(flash.id), FX_MS.screen);
    return () => clearTimeout(t);
  }, [flash, consumeFx]);

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      <AnimatePresence>
        {flash && !reduced && (
          <motion.div
            key={`flash-${flash.id}`}
            className="absolute inset-0"
            style={{
              // 퍼펙트 클리어는 4줄과 **다른 색**이어야 한다 — 같으면 최고의 순간이 묻힌다.
              background: flash.text === 'perfect'
                ? 'radial-gradient(circle at 50% 45%, rgba(255,255,255,0.55), rgba(250,204,21,0.22) 45%, transparent 70%)'
                : 'radial-gradient(circle at 50% 45%, rgba(37,244,238,0.35), transparent 65%)',
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: FX_MS.screen / 1000 }}
          />
        )}
      </AnimatePresence>

      <div className="absolute left-1/2 top-[26%] -translate-x-1/2 text-center">
        <AnimatePresence>
          {badge && (
            <motion.div
              key={badge.id}
              data-ghc-badge={badge.text}
              className="relative"
              initial={reduced ? { opacity: 0 } : { scale: 0.6, opacity: 0, rotate: -6 }}
              animate={reduced ? { opacity: 1 } : { scale: [0.6, 1.14, 1], opacity: 1, rotate: -4 }}
              exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.18 } }}
              transition={{ duration: reduced ? 0.1 : 0.18, times: reduced ? undefined : [0, 0.55, 1] }}
            >
              <span
                className="absolute inset-0 whitespace-nowrap font-display text-4xl font-black italic"
                style={{ color: 'rgba(0,0,0,0.7)', transform: 'translate(3px,4px)' }}
              >
                {badge.text}
              </span>
              <span
                className="absolute inset-0 whitespace-nowrap font-display text-4xl font-black italic text-white"
                style={{ WebkitTextStroke: '5px #FFFFFF' }}
              >
                {badge.text}
              </span>
              <span
                className="relative whitespace-nowrap font-display text-4xl font-black italic text-transparent"
                style={{
                  backgroundImage: BADGE_GRADIENT[badge.tone],
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  filter: reduced ? undefined : 'drop-shadow(0 0 14px rgba(255,255,255,0.5))',
                }}
              >
                {badge.text}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
