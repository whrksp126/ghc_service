import { motion } from 'framer-motion';
import { Crown, WifiOff } from 'lucide-react';
import { isForfeited } from '../../games/events';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import type { GameSnapshot, PlayerState } from '../../games/types';

/** 진행률 = (total - remaining) / total. total이 없으면 지운 타일로 역산한다. */
export function progressOf(p: PlayerState, snapshot: GameSnapshot): number {
  const b = snapshot.boards[p.boardId];
  if (!b) return 0;
  const total = b.total > 0 ? b.total : b.remaining + p.pairsCleared * 2;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(1, (total - b.remaining) / total));
}

interface ProfileColumnProps {
  snapshot: GameSnapshot;
  myUserId: string | null;
  feeds: GameFeed[];
  /** 관전 시점에서 보고 있는 보드 */
  watchedUserId?: string;
  onSelect?: (userId: string) => void;
  /** 모바일 가로 스크롤 */
  strip?: boolean;
}

/**
 * 좌측 프로필 컬럼 (v4 §X3) — 카드 안에 그 사람 **카메라**, 등수 뱃지, 닉네임,
 * 남은 패 큰 숫자, 진행 바, 콤보 뱃지, 완주/기권 태그.
 */
export function ProfileColumn({
  snapshot, myUserId, feeds, watchedUserId, onSelect, strip,
}: ProfileColumnProps) {
  const feedFor = (userId: string) =>
    feeds.find((f) => f.userId === userId && !f.isScreen);

  return (
    <div data-ghc-profiles="" className={strip ? 'flex gap-2 overflow-x-auto scrollbar-none' : 'flex flex-col gap-2'}>
      {snapshot.players.map((p, i) => {
        const board = snapshot.boards[p.boardId];
        const remaining = board?.remaining ?? 0;
        const isMe = p.userId === myUserId;
        const watched = watchedUserId === p.userId;
        const rank = p.rank > 0 ? p.rank : i + 1;
        const progress = progressOf(p, snapshot);
        return (
          <button
            key={p.userId}
            type="button"
            data-ghc-player={p.userId}
            onClick={onSelect ? () => onSelect(p.userId) : undefined}
            className={`${strip ? 'w-[150px] shrink-0' : 'w-full'} rounded-xl p-1.5 text-left transition-colors ${
              isMe ? 'bg-white/10' : 'bg-white/5'
            } ${isForfeited(p) ? 'opacity-50' : ''} ${onSelect ? 'cursor-pointer hover:bg-white/15' : 'cursor-default'}`}
            style={{ boxShadow: `inset 0 0 0 ${isMe || watched ? 2 : 1}px ${isMe || watched ? p.color : `${p.color}44`}` }}
          >
            {/* 카메라 (없으면 색 이니셜) */}
            <div className="relative mb-1 aspect-video w-full overflow-hidden rounded-lg bg-black/40">
              <ProfileVideo
                feed={feedFor(p.userId)}
                color={p.color}
                label={p.nickname}
                className="h-full w-full"
              />
              <span
                className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full font-display text-[11px] font-black text-dark-900"
                style={{ background: p.color }}
              >
                {rank}
              </span>
              {p.finishedAt !== null && (
                <span className="absolute right-1 top-1 rounded bg-success/90 px-1 text-[9px] font-bold text-dark-900">완주</span>
              )}
              {isForfeited(p) && (
                <span className="absolute right-1 top-1 rounded bg-white/70 px-1 text-[9px] font-bold text-dark-900">기권</span>
              )}
              {p.combo > 1 && (
                <motion.span
                  key={p.combo}
                  initial={{ scale: 0.6 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 600, damping: 12 }}
                  className={`absolute bottom-1 right-1 rounded-full px-1.5 text-[10px] font-bold ${
                    p.combo >= 6 ? 'bg-gradient-to-r from-primary to-secondary text-dark-900'
                      : p.combo >= 4 ? 'bg-primary text-white' : 'bg-secondary text-dark-900'
                  }`}
                >
                  x{p.combo}
                </motion.span>
              )}
            </div>

            <div className="flex items-center gap-1 px-0.5">
              <span className="min-w-0 flex-1 truncate text-[11px] text-white/90">{p.nickname}</span>
              {p.userId === snapshot.hostUserId && <Crown size={11} className="shrink-0 text-warning" />}
              {isMe && <span className="shrink-0 text-[10px] text-white/35">나</span>}
              {!p.connected && <WifiOff size={11} className="shrink-0 text-danger" />}
            </div>

            <div className="flex items-end gap-1.5 px-0.5">
              <span className="text-[9px] leading-none text-white/40">남은 패</span>
              <span className="font-display text-lg font-black leading-none tabular-nums text-white">
                {String(remaining).padStart(3, '0')}
              </span>
            </div>

            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/40">
              <motion.div
                className="h-full rounded-full"
                style={{ background: p.color }}
                animate={{ width: `${progress * 100}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}
