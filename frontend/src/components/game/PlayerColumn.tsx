import { motion } from 'framer-motion';
import { Crown, WifiOff } from 'lucide-react';
import { isForfeited } from '../../games/events';
import type { GameSnapshot, PlayerState } from '../../games/types';

function initials(nickname: string): string {
  return nickname.trim().slice(0, 2) || '?';
}

/** 진행 바: 지운 타일 / (지운 + 남은) */
function progressOf(p: PlayerState, remaining: number): number {
  const total = remaining + p.pairsCleared * 2;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, (p.pairsCleared * 2) / total));
}

interface PlayerColumnProps {
  snapshot: GameSnapshot;
  myUserId: string | null;
  /** 모바일 가로 스트립 모드 */
  strip?: boolean;
}

/** 인게임 좌측 플레이어 컬럼 (v3 §W3) — 아바타·닉·남은 패·진행 바·콤보. */
export function PlayerColumn({ snapshot, myUserId, strip }: PlayerColumnProps) {
  return (
    <div className={strip ? 'flex gap-2 overflow-x-auto scrollbar-none' : 'flex flex-col gap-1.5'}>
      {snapshot.players.map((p) => {
        const board = snapshot.boards[p.boardId];
        const remaining = board?.remaining ?? 0;
        const isMe = p.userId === myUserId;
        return (
          <div
            key={p.userId}
            data-ghc-player={p.userId}
            className={`${strip ? 'min-w-[140px] shrink-0' : 'w-full'} rounded-xl px-2 py-1.5 ${
              isMe ? 'bg-white/10' : 'bg-white/5'
            } ${isForfeited(p) ? 'opacity-50' : ''}`}
            style={{ boxShadow: `inset 0 0 0 1px ${p.color}44` }}
          >
            <div className="flex items-center gap-1.5">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-dark-900"
                style={{ background: p.color }}
              >
                {initials(p.nickname)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-white/90">{p.nickname}</span>
              {p.userId === snapshot.hostUserId && <Crown size={11} className="shrink-0 text-warning" />}
              {!p.connected && <WifiOff size={11} className="shrink-0 text-danger" />}
              {p.combo > 1 && (
                <motion.span
                  key={p.combo}
                  initial={{ scale: 0.6 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 600, damping: 12 }}
                  className={`shrink-0 rounded-full px-1 text-[9px] font-bold ${
                    p.combo >= 6 ? 'bg-gradient-to-r from-primary to-secondary text-dark-900'
                      : p.combo >= 4 ? 'bg-primary text-white' : 'bg-secondary text-dark-900'
                  }`}
                >
                  x{p.combo}
                </motion.span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/40">
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: p.color }}
                  animate={{ width: `${progressOf(p, remaining) * 100}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
              <span className="font-display text-[10px] tabular-nums text-white/60">{remaining}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
