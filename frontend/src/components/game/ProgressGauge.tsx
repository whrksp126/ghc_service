import { AnimatePresence, motion } from 'framer-motion';
import { progressOf } from './ProfileColumn';
import { prefersReducedMotion } from '../../games/motion';
import type { GameSnapshot } from '../../games/types';

/**
 * 우측 세로 진행 게이지 (v4 §X3, 넷마블 참고).
 * 굵은 튜브 + 선두 진행률까지 차오르는 밝은 게이지 + 플레이어 마커(색 원 · 나/등수 · 남은 패).
 * 마커는 겹쳐도 읽히도록 좌우로 번갈아 밀고, 전부 컬럼 안쪽에 들어온다.
 */
export function ProgressGauge({ snapshot, myUserId }: { snapshot: GameSnapshot; myUserId: string | null }) {
  const reduced = prefersReducedMotion();
  const entries = snapshot.players.map((p) => ({ p, progress: progressOf(p, snapshot) }));
  const leadProgress = entries.reduce((m, e) => Math.max(m, e.progress), 0);
  const meFinished = snapshot.players.some((p) => p.userId === myUserId && p.finishedAt !== null);

  // 진행률이 비슷한 마커가 겹치지 않도록: 아래에서부터 정렬해 번갈아 밀어 준다.
  const ordered = [...entries].sort((a, b) => a.progress - b.progress);
  const shiftOf = (userId: string) => {
    const i = ordered.findIndex((e) => e.p.userId === userId);
    return i % 2 === 0 ? 6 : 22;
  };

  return (
    <div className="relative hidden w-[88px] shrink-0 pb-2 pt-5 md:block">
      {/* 골인 캡 */}
      <span className="absolute right-2 top-0 w-[26px] rounded-t bg-white/15 text-center font-display text-[9px] leading-4 text-white/70">
        골인
      </span>

      {/* 튜브 */}
      <div className="absolute bottom-2 right-2 top-5 w-[26px] overflow-hidden rounded-full bg-black/70 shadow-[inset_0_2px_10px_rgba(0,0,0,0.85)] ring-1 ring-white/15">
        {/* 눈금 (0/25/50/75/100) */}
        {[0, 25, 50, 75, 100].map((t) => (
          <span
            key={t}
            className={`absolute inset-x-1 h-px ${t % 50 === 0 ? 'bg-white/25' : 'bg-white/12'}`}
            style={{ bottom: `${t}%` }}
          />
        ))}
        {/* 선두 진행률까지 차오르는 게이지 */}
        <motion.div
          className="absolute inset-x-0 bottom-0 rounded-full bg-gradient-to-t from-secondary via-secondary to-primary"
          style={{ boxShadow: '0 0 18px rgba(37,244,238,0.65), inset 0 1px 0 rgba(255,255,255,0.45)' }}
          animate={{ height: `${Math.max(2, leadProgress * 100)}%` }}
          transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 140, damping: 22 }}
        />
      </div>

      {/* 마커 레이어 — 튜브와 정확히 같은 영역 위에 얹는다 */}
      <div className="absolute bottom-2 right-2 top-5 w-[26px]">
        {entries.map(({ p, progress }) => {
          const isMe = p.userId === myUserId;
          const lead = p.rank === 1;
          const board = snapshot.boards[p.boardId];
          return (
            <motion.div
              key={p.userId}
              className="absolute right-full flex translate-y-1/2 items-center gap-1"
              animate={{ bottom: `${progress * 100}%` }}
              transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 160, damping: 20 }}
            >
              <span className="font-display text-[10px] leading-none tabular-nums text-white/70">
                {board?.remaining ?? 0}
              </span>
              <span
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full font-display text-[10px] font-black text-dark-900"
                style={{
                  background: p.color,
                  boxShadow: lead
                    ? `0 0 12px ${p.color}, 0 0 0 2px rgba(255,255,255,0.85)`
                    : `0 0 0 1px rgba(0,0,0,0.5)`,
                }}
              >
                {isMe ? '나' : p.rank > 0 ? p.rank : '·'}
              </span>
              {/* 튜브까지 잇는 연결선 (겹침 방지용으로 길이를 번갈아) */}
              <span
                className="h-px shrink-0 bg-white/35"
                style={{ width: shiftOf(p.userId) }}
              />
            </motion.div>
          );
        })}
      </div>

      {/* 완주 연출 */}
      <AnimatePresence>
        {meFinished && (
          <motion.div
            key="goal"
            className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.span
              className="font-display text-5xl font-black italic text-secondary drop-shadow-[0_4px_18px_rgba(37,244,238,0.9)]"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: [0.5, 1.2, 1], opacity: [0, 1, 1, 0] }}
              transition={{ duration: 1.2, times: [0, 0.3, 0.6, 1] }}
            >
              GOAL IN!
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
