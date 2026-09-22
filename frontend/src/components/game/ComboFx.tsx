import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useGameStore } from '../../stores/gameStore';
import { prefersReducedMotion } from '../../games/motion';

/** 콤보 티어 색 (§6.3 / v2.1) */
function tier(combo: number): { text: string; glow: string } {
  if (combo >= 8) return { text: 'text-transparent bg-clip-text bg-gradient-to-r from-primary via-warning to-secondary', glow: '#FE2C55' };
  if (combo >= 6) return { text: 'text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary', glow: '#FE2C55' };
  if (combo >= 4) return { text: 'text-primary', glow: '#FE2C55' };
  return { text: 'text-secondary', glow: '#25F4EE' };
}

interface Shown { id: number; combo: number; }

/**
 * 콤보 연출: 아레나 상단 중앙 "×N COMBO" 팝 + 콤보 5↑ 가장자리 플래시 + 8↑ PERFECT!!.
 * 전부 실제 `fxQueue`의 pop 이벤트(내 보드·내 제거)에서만 트리거된다.
 */
export function ComboFx({ boardId, myUserId }: { boardId?: string; myUserId: string | null }) {
  const fxQueue = useGameStore((s) => s.fxQueue);
  const [shown, setShown] = useState<Shown | null>(null);
  const lastId = useRef(0);
  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (!boardId) return;
    const hot = fxQueue.find(
      (f) => f.type === 'pop' && f.boardId === boardId && f.fromUserId === myUserId
        && (f.combo ?? 0) >= 2 && f.id > lastId.current,
    );
    if (!hot) return;
    lastId.current = hot.id;
    setShown({ id: hot.id, combo: hot.combo ?? 2 });
    const t = setTimeout(() => setShown((cur) => (cur?.id === hot.id ? null : cur)), reduced ? 250 : 700);
    return () => clearTimeout(t);
  }, [fxQueue, boardId, myUserId, reduced]);

  const combo = shown?.combo ?? 0;
  const t = tier(combo);

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key={shown.id}
          className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center pt-6"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* 가장자리 색 플래시 (콤보 5+) */}
          {combo >= 5 && !reduced && (
            <motion.span
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.9, 0] }}
              transition={{ duration: 0.4 }}
              style={{ boxShadow: `inset 0 0 60px 14px ${t.glow}66` }}
            />
          )}
          <motion.span
            className={`font-display text-4xl font-black tabular-nums drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)] ${t.text}`}
            initial={reduced ? { opacity: 0 } : { scale: 1.8, rotate: combo % 2 ? -6 : 6, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { scale: 1, rotate: 0, opacity: [0, 1, 1, 0] }}
            transition={reduced
              ? { duration: 0.2 }
              : { scale: { type: 'spring', stiffness: 420, damping: 14 }, opacity: { duration: 0.7, times: [0, 0.1, 0.55, 1] } }}
          >
            ×{combo} COMBO
          </motion.span>
          {combo >= 8 && (
            <motion.span
              className="mt-1 font-display text-lg font-black text-warning drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]"
              initial={reduced ? { opacity: 0 } : { scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: [0, 1, 1, 0] }}
              transition={{ duration: 0.7, times: [0, 0.15, 0.6, 1] }}
            >
              PERFECT!!
            </motion.span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
