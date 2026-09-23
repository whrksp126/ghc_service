import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimationControls } from 'framer-motion';
import { LogOut } from 'lucide-react';
import { useGameStore } from '../../stores/gameStore';
import { useAuthStore } from '../../stores/authStore';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { prefersReducedMotion } from '../../games/motion';
import { pickActiveTile, emitSelect } from './ShisenBoard';
import { FittedBoard } from './FittedBoard';
import { ThemeBackdrop, TRAY_CLASS, themeOf } from './ArenaTheme';
import { ComboBurst } from './ComboBurst';
import { TopCounterBar, runItem } from './TopCounterBar';
import { PROFILE_COL_CLASS, ProfileColumn } from './ProfileColumn';
import { ProgressGauge } from './ProgressGauge';
import { LiveScoreboard } from './LiveScoreboard';
import { Countdown } from './Countdown';
import { ResultsOverlay } from './ResultsOverlay';
import { AttackFxLayer } from './AttackFx';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import { MAP_GUIDE } from '../../games/v3';
import { isForfeited } from '../../games/events';
import type { GameSnapshot, PlayerState } from '../../games/types';

const MODE_TEXT: Record<string, string> = {
  race: '각자 독립된 판 — 먼저 다 지우면 승리',
  coop: '한 판을 나눠 먹기 — 누가 더 많이, 빨리 지우나',
};

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 경기 시간 — race+제한시간은 카운트다운, 그 외는 카운트업. */
function ArenaClock({ snapshot }: { snapshot: GameSnapshot }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (!snapshot.startAt) return null;
  const limit = snapshot.options.timeLimitSec;
  const end = snapshot.endedAt ?? now;
  const value = limit > 0 ? snapshot.startAt + limit * 1000 - end : end - snapshot.startAt;
  const urgent = limit > 0 && value < 30000;
  return (
    <span className={`font-display tabular-nums ${urgent ? 'text-primary' : 'text-white/60'}`}>
      {fmtClock(value)}
    </span>
  );
}

/** 하단 바 — 모드·맵·시간 / 관전자 카메라 스트립 / 기권·나가기 (v4 §X3) */
function ArenaBottomBar({
  snapshot, feeds, canForfeit, onForfeit, onLeave,
}: {
  snapshot: GameSnapshot;
  feeds: GameFeed[];
  canForfeit: boolean;
  onForfeit: () => void;
  onLeave: () => void;
}) {
  const mapName = (MAP_GUIDE[snapshot.options.mapShape] ?? MAP_GUIDE.rect).name;
  return (
    // 테트리스 아레나와 **같은 보장**(설계서 §Z2): 어떤 폭·높이에서도 패널 바닥에 붙어 있다.
    // `mt-auto`(위가 모자라도 바닥) + `shrink-0`(위가 넘쳐도 이 줄은 안 줄어든다) + `z-20`.
    <div className="relative z-20 mt-auto flex shrink-0 items-center gap-2 px-1 text-[11px] text-white/45">
      <span className="hidden shrink-0 sm:inline">{MODE_TEXT[snapshot.mode]}</span>
      <span className="shrink-0 rounded bg-black/35 px-1.5 py-0.5">{mapName}</span>
      <ArenaClock snapshot={snapshot} />

      {/* 관전자 카메라 스트립 */}
      <div className="mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none">
        {snapshot.spectators.map((s) => {
          const feed = feeds.find((f) => f.userId === s.userId && !f.isScreen);
          return (
            <span key={s.userId} className="flex shrink-0 items-center gap-1 rounded-lg bg-white/5 px-1 py-1">
              <ProfileVideo
                feed={feed}
                color="#9CA3AF"
                label={s.nickname}
                rounded="rounded"
                className="h-9 w-16"
              />
              <span className="max-w-[70px] truncate text-[10px] text-white/55">{s.nickname}</span>
            </span>
          );
        })}
      </div>

      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {canForfeit && (
          <button
            onClick={onForfeit}
            className="rounded-full bg-dark-700 px-2 py-1 text-white/55 transition-colors hover:bg-dark-600"
          >
            기권
          </button>
        )}
        <button
          data-ghc-exit="1"
          onClick={onLeave}
          className="flex items-center gap-1 rounded-full bg-danger/80 px-2.5 py-1 text-white transition-colors hover:bg-danger"
        >
          <LogOut size={12} /> 나가기
        </button>
      </span>
    </div>
  );
}

/** 인게임 화면 (v4 §X3) — 상단 카운터 · 좌측 프로필(카메라) · 중앙 보드 · 우측 게이지 · 하단 바. */
export function ShisenArena({ snapshot, feeds = [] }: { snapshot: GameSnapshot; feeds?: GameFeed[] }) {
  const myUserId = useAuthStore((s) => s.userId);
  const fxQueue = useGameStore((s) => s.fxQueue);
  const notice = useGameStore((s) => s.notice);
  const banner = useGameStore((s) => s.banner);
  const closePanel = useGameStore((s) => s.closePanel);
  const shakeControls = useAnimationControls();
  const arenaRef = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();

  const theme = themeOf(snapshot.seed);
  const tray = TRAY_CLASS[theme];
  const me = snapshot.players.find((p) => p.userId === myUserId);
  const meActive = !!me && !isForfeited(me);
  const playing = snapshot.phase === 'playing';
  const isCoop = snapshot.mode === 'coop';
  const sharedBoard = snapshot.boards['shared'] ?? Object.values(snapshot.boards)[0];
  const myBoard = me ? snapshot.boards[me.boardId] : undefined;

  // 관전(기권 포함) 시점: 프로필을 누르면 그 사람 판으로 전환, 기본은 선두.
  const [watchedId, setWatchedId] = useState<string | null>(null);
  const leader = [...snapshot.players].sort((a, b) => (a.rank || 99) - (b.rank || 99))[0];
  const watchedPlayer: PlayerState | undefined = isCoop
    ? undefined
    : snapshot.players.find((p) => p.userId === watchedId) ?? leader;

  const centerBoard = isCoop
    ? sharedBoard
    : meActive ? myBoard : (watchedPlayer ? snapshot.boards[watchedPlayer.boardId] : undefined);
  const interactiveBoardId = meActive ? (isCoop ? sharedBoard?.id : myBoard?.id) : undefined;
  const hudBoard = meActive ? (isCoop ? sharedBoard : myBoard) : centerBoard;
  const myRank = me?.rank && me.rank > 0 ? me.rank : snapshot.players.length;

  // 짧은 안내 1.2초, 배너 2.5초.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => useGameStore.getState().setNotice(null), 1200);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => useGameStore.getState().setBanner(null), 2500);
    return () => clearTimeout(t);
  }, [banner]);

  // 콤보 5 이상이면 아레나 미세 흔들림 — 실제 pop 이벤트에서만, 한 번씩.
  const shookRef = useRef(0);
  useEffect(() => {
    if (reduced || !interactiveBoardId) return;
    const hot = fxQueue.find(
      (f) => f.type === 'pop' && f.boardId === interactiveBoardId
        && f.fromUserId === myUserId && (f.combo ?? 0) >= 5 && f.id > shookRef.current,
    );
    if (!hot) return;
    shookRef.current = hot.id;
    void shakeControls.start({ x: [0, -2, 2, -2, 0], transition: { duration: 0.12 } });
  }, [fxQueue, interactiveBoardId, myUserId, reduced, shakeControls]);

  // 키보드: 커서 이동 / 선택 / 해제 / 아이템(F1·F2·F3, H)
  useEffect(() => {
    if (!playing || !meActive || !interactiveBoardId) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const st = useGameStore.getState();
      const b = st.snapshot?.boards[interactiveBoardId];
      if (!b) return;
      const cur = st.cursorIdx ?? b.cells.findIndex((v) => v !== 0);
      if (cur < 0) return;
      const r = Math.floor(cur / b.cols);
      const c = cur % b.cols;
      const move = (dr: number, dc: number) => {
        const nr = Math.max(0, Math.min(b.rows - 1, r + dr));
        const nc = Math.max(0, Math.min(b.cols - 1, c + dc));
        st.setCursor(nr * b.cols + nc);
      };
      switch (e.key) {
        case 'ArrowUp': move(-1, 0); break;
        case 'ArrowDown': move(1, 0); break;
        case 'ArrowLeft': move(0, -1); break;
        case 'ArrowRight': move(0, 1); break;
        case ' ':
        case 'Enter':
          if (st.cursorIdx !== null) pickActiveTile(st.cursorIdx);
          else st.setCursor(cur);
          break;
        case 'Escape':
          st.setSelected(null);
          emitSelect(null);
          return;
        case 'h':
        case 'H':
        case 'ㅗ':
        case 'F1':
          void runItem('hint');
          break;
        case 'F2':
          void runItem('shuffle');
          break;
        case 'F3':
          void runItem('wand');
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, meActive, interactiveBoardId]);

  const forfeit = async () => {
    try { await emitWithAck('game:spectate', {}); } catch (err) {
      showToast(err instanceof Error ? err.message : '기권할 수 없어요', 'error');
    }
  };
  const leave = async () => {
    if (meActive) await forfeit();
    closePanel();
  };

  return (
    <motion.div
      ref={arenaRef}
      animate={shakeControls}
      // isolate: 배경(-z-10)이 게임 패널 밖으로 빠지지 않도록 스태킹 컨텍스트를 만든다.
      // overflow-hidden: 내용이 넘쳐도 하단 바(기권·나가기)가 화면 밖으로 밀려나지 않게 한다.
      className="relative isolate flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2"
    >
      <ThemeBackdrop theme={theme} seed={snapshot.seed} />

      <TopCounterBar
        board={hudBoard}
        me={me}
        active={playing && meActive}
        rank={myRank}
        spectating={!meActive}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        {/* 좌: 프로필 컬럼 — 한 줄에 한 사람, 카드가 컬럼 폭을 꽉 채운다(모바일은 상단 가로 스크롤).
            **한 번만 렌더**한다 — 두 벌 렌더하면 같은 카메라 트랙이 두 번 attach 된다. */}
        <div className={`min-h-0 shrink-0 ${PROFILE_COL_CLASS}`}>
          <ProfileColumn
            snapshot={snapshot}
            myUserId={myUserId}
            feeds={feeds}
            watchedUserId={meActive ? undefined : watchedPlayer?.userId}
            onSelect={meActive || isCoop ? undefined : setWatchedId}
          />
        </div>

        {/* 중앙: 보드 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
          {isCoop && <LiveScoreboard players={snapshot.players} myUserId={myUserId} />}
          {!meActive && watchedPlayer && !isCoop && (
            <p className="text-center text-[11px] text-white/40">
              {watchedPlayer.nickname}님의 판을 보는 중 — 프로필을 눌러 바꿀 수 있어요
            </p>
          )}
          {centerBoard ? (
            <FittedBoard
              board={centerBoard}
              interactive={playing && meActive && centerBoard.id === interactiveBoardId}
              alignTop
              tray={tray}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-white/30">판을 준비하는 중…</div>
          )}
        </div>

        {/* 우: 진행 게이지 */}
        {!isCoop && <ProgressGauge snapshot={snapshot} myUserId={myUserId} />}
      </div>

      <ArenaBottomBar
        snapshot={snapshot}
        feeds={feeds}
        canForfeit={playing && meActive}
        onForfeit={() => { void forfeit(); }}
        onLeave={() => { void leave(); }}
      />

      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice.at}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute bottom-12 left-1/2 z-30 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1 text-[11px] text-white/90"
          >
            {notice.text}
          </motion.div>
        )}
        {banner && (
          <motion.div
            key={banner.at}
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="pointer-events-none absolute left-1/2 top-16 z-30 -translate-x-1/2 rounded-full bg-black/75 px-4 py-1.5 text-xs text-white/90 shadow-lg"
          >
            {banner.text}
          </motion.div>
        )}
      </AnimatePresence>

      <ComboBurst boardId={interactiveBoardId} myUserId={myUserId} />
      <AttackFxLayer myBoardId={interactiveBoardId} arenaRef={arenaRef} />

      {snapshot.phase === 'countdown' && snapshot.startAt && (
        <Countdown startAt={snapshot.startAt} modeText={MODE_TEXT[snapshot.mode]} />
      )}
      {snapshot.phase === 'finished' && <ResultsOverlay snapshot={snapshot} />}
    </motion.div>
  );
}
