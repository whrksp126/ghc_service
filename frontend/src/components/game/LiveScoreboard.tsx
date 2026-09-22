import { motion } from 'framer-motion';
import { Crown } from 'lucide-react';
import type { PlayerState } from '../../games/types';

/** 쟁탈전 순위 규칙: 지운 쌍 내림차순 → 점수 내림차순 (v2.1) */
export function rankGrab(players: PlayerState[]): PlayerState[] {
  return [...players].sort((a, b) => b.pairsCleared - a.pairsCleared || b.score - a.score);
}

/**
 * 쟁탈전 실시간 점수판 — 보드 위에 크게. 1위 왕관은 순위가 바뀌는 즉시 따라 움직인다
 * (`layout` 애니메이션으로 행이 부드럽게 자리를 바꾼다).
 */
export function LiveScoreboard({ players, myUserId }: { players: PlayerState[]; myUserId: string | null }) {
  const ranked = rankGrab(players);
  const lead = ranked[0];
  return (
    <div className="flex shrink-0 flex-wrap items-stretch gap-2 px-1">
      {ranked.map((p) => {
        const isLead = lead && p.userId === lead.userId && p.pairsCleared > 0;
        return (
          <motion.div
            key={p.userId}
            layout
            data-ghc-player={p.userId}
            className={`flex min-w-[140px] flex-1 items-center gap-2 rounded-xl px-2.5 py-1.5 ${
              p.userId === myUserId ? 'bg-white/10' : 'bg-white/5'
            }`}
            style={{ boxShadow: `inset 0 0 0 1px ${p.color}55` }}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color, boxShadow: `0 0 8px ${p.color}` }} />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-white/90">{p.nickname}</span>
            {isLead && <Crown size={14} className="shrink-0 text-warning" />}
            {p.combo > 1 && (
              <motion.span
                key={p.combo}
                initial={{ scale: 0.6 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 600, damping: 12 }}
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  p.combo >= 6 ? 'bg-gradient-to-r from-primary to-secondary text-dark-900'
                    : p.combo >= 4 ? 'bg-primary text-white' : 'bg-secondary text-dark-900'
                }`}
              >
                x{p.combo}
              </motion.span>
            )}
            <span className="shrink-0 font-display text-base font-black tabular-nums text-white">
              {p.pairsCleared}
              <span className="ml-0.5 text-[10px] font-medium text-white/40">쌍</span>
            </span>
            <span className="shrink-0 font-display text-xs tabular-nums text-white/55">{p.score}점</span>
          </motion.div>
        );
      })}
    </div>
  );
}
