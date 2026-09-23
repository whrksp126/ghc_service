import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Crown, WifiOff } from 'lucide-react';
import { isForfeited } from '../../games/events';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import type { GameSnapshot, PlayerState } from '../../games/types';

/**
 * 좌측 프로필 컬럼 폭(데스크탑).
 * **사천성과 테트리스가 같은 값을 쓴다** — 두 게임의 좌측이 따로 놀면 방을 옮길 때마다
 * 레이아웃이 튄다. 카메라는 이 폭을 16:9로 그대로 쓴다.
 */
export const PROFILE_COL_CLASS = 'lg:w-[280px]';

/** 카드 사이 간격(px) — Tailwind `gap-2` 와 같은 값이어야 계산이 맞는다. */
const CARD_GAP = 8;
/** 카드 안쪽 패딩(px) — Tailwind `p-1.5`. */
const CARD_PAD = 6;
/** 카메라가 이보다 작아지면 사람 얼굴이 안 보인다 — 더 줄이지 않고 컬럼을 스크롤시킨다. */
const MIN_CAM = 54;

export interface ProfileFit {
  /** true = 데스크탑 세로 컬럼 / false = 모바일 가로 스트립 */
  column: boolean;
  /** 컬럼 모드에서 카메라 높이(px). null 이면 16:9 그대로 */
  cam: number | null;
}

/**
 * 한 줄에 한 사람씩, **가로는 컬럼 폭을 항상 꽉 채우고** 세로만 인원수에 맞춰 줄인다.
 *
 * CSS 만으로는 "16:9를 유지하되 남는 세로에 맞춰 축소"가 안 된다(aspect-ratio + flex 가
 * 서로 싸운다). 그래서 컬럼의 **확정된 높이**를 재서 카메라 높이를 직접 계산한다.
 * 관측 대상은 부모가 높이를 정해 주는 엘리먼트라 ResizeObserver 루프가 생기지 않는다.
 */
export function useProfileFit(
  ref: React.RefObject<HTMLElement>, count: number, chromePx: number,
): ProfileFit {
  const [fit, setFit] = useState<ProfileFit>({ column: false, cam: null });

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');

    const measure = () => {
      const column = mq.matches;
      let cam: number | null = null;
      if (column && count > 0) {
        const rect = el.getBoundingClientRect();
        const per = (rect.height - CARD_GAP * (count - 1)) / count;
        // 카드 좌우 패딩(p-1.5 = 6px ×2)을 빼야 카메라가 정확히 16:9가 된다.
        const inner = Math.max(0, rect.width - CARD_PAD * 2);
        // 세로가 남으면 16:9(= 폭 그대로), 모자라면 그만큼만 낮춘다. 폭은 언제나 100%.
        cam = Math.max(MIN_CAM, Math.min(inner * 9 / 16, per - chromePx));
      }
      setFit((prev) => (prev.column === column && prev.cam === cam ? prev : { column, cam }));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    mq.addEventListener('change', measure);
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', measure);
    };
  }, [ref, count, chromePx]);

  return fit;
}

/** 프로필 카드 바깥 공통 클래스 — 모바일 스트립 / 데스크탑 풀폭. */
export const PROFILE_CARD_CLASS =
  'w-[150px] shrink-0 lg:w-full rounded-xl p-1.5 text-left transition-colors';

/** 컬럼 컨테이너 공통 클래스 — 모바일 가로 스크롤, lg 부터 세로 한 줄 한 사람. */
export const PROFILE_LIST_CLASS =
  'flex gap-2 overflow-x-auto scrollbar-none lg:h-full lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto';

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
}

/** 사천성 카드에서 카메라를 뺀 나머지(닉네임/남은 패/진행 바/여백)의 대략 높이. */
const SHISEN_CHROME = 66;

/**
 * 좌측 프로필 컬럼 (v4 §X3) — 카드 안에 그 사람 **카메라**, 등수 뱃지, 닉네임,
 * 남은 패 큰 숫자, 진행 바, 콤보 뱃지, 완주/기권 태그.
 *
 * 모바일/데스크탑을 **한 번만 렌더**한다. 예전처럼 두 벌 렌더하면 같은 카메라 트랙이
 * 두 엘리먼트에 attach 돼(중복 attach 금지 규칙 위반) `data-ghc-player` 도 중복된다.
 */
export function ProfileColumn({
  snapshot, myUserId, feeds, watchedUserId, onSelect,
}: ProfileColumnProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const fit = useProfileFit(boxRef, snapshot.players.length, SHISEN_CHROME);
  const feedFor = (userId: string) =>
    feeds.find((f) => f.userId === userId && !f.isScreen);

  return (
    <div ref={boxRef} data-ghc-profiles="" className={PROFILE_LIST_CLASS}>
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
            data-ghc-profile={p.userId}
            onClick={onSelect ? () => onSelect(p.userId) : undefined}
            className={`${PROFILE_CARD_CLASS} ${isMe ? 'bg-white/10' : 'bg-white/5'} ${
              isForfeited(p) ? 'opacity-50' : ''
            } ${onSelect ? 'cursor-pointer hover:bg-white/15' : 'cursor-default'}`}
            style={{ boxShadow: `inset 0 0 0 ${isMe || watched ? 2 : 1}px ${isMe || watched ? p.color : `${p.color}44`}` }}
          >
            {/* 카메라 (없으면 색 이니셜) — 컬럼 폭을 그대로 쓰고 세로만 인원수에 맞춰 줄어든다 */}
            <div
              className={`relative mb-1 w-full overflow-hidden rounded-lg bg-black/40 ${
                fit.cam == null ? 'aspect-video' : ''
              }`}
              style={fit.cam == null ? undefined : { height: fit.cam }}
            >
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
              <span className="min-w-0 flex-1 truncate text-xs text-white/90">{p.nickname}</span>
              {p.userId === snapshot.hostUserId && <Crown size={12} className="shrink-0 text-warning" />}
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
