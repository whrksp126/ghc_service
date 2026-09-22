import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimationControls } from 'framer-motion';
import { Lightbulb, X } from 'lucide-react';
import { useGameStore } from '../../stores/gameStore';
import { useAuthStore } from '../../stores/authStore';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { playGameSound } from '../../games/sounds';
import { prefersReducedMotion } from '../../games/motion';
import { ShisenBoard, BOARD_GAP, boardBox, pickActiveTile, emitSelect } from './ShisenBoard';
import { ThemeBackdrop, TRAY_CLASS, themeOf } from './ArenaTheme';
import { ComboFx } from './ComboFx';
import { LiveScoreboard } from './LiveScoreboard';
import { countMoves } from '../../games/moves';
import { PlayerHeader } from './PlayerHeader';
import { Countdown } from './Countdown';
import { ResultsOverlay } from './ResultsOverlay';
import { AttackFxLayer } from './AttackFx';
import type { Board, GameSnapshot, PlayerState } from '../../games/types';
import type { HintAck } from '../../games/events';
import { isForfeited } from '../../games/events';

const MODE_TEXT: Record<string, string> = {
  race: '각자 독립된 판 — 먼저 다 지우면 승리',
  coop: '한 판을 나눠 먹기 — 누가 더 많이, 빨리 지우나',
};

/** 헤더 카드가 차지하는 높이(px) — 보드 크기 계산에서 미리 빼 둔다. */
const HEADER_H = 30;
/** 보드를 올려 두는 트레이 여백(px, 좌우·상하 합) */
const TRAY_PAD = 20;

/** 컨테이너를 실측해 `cellPx`를 구하고, 헤더 카드 + 보드를 보드 폭에 맞춰 세로 중앙 배치한다(§6.2). */
function FittedBoard({
  board, player, interactive, minCell = 14, maxCell, compactHeader, isMe, isHost, showMeter, onExpand,
  alignTop, tray,
}: {
  board: Board;
  player?: PlayerState;
  interactive: boolean;
  minCell?: number;
  maxCell?: number;
  compactHeader?: boolean;
  isMe?: boolean;
  isHost?: boolean;
  showMeter?: boolean;
  onExpand?: () => void;
  /** 모바일 세로에서 위쪽 정렬(상대 미니 스트립 아래 빈 공간이 생기지 않도록) */
  alignTop?: boolean;
  /** 테마 트레이 클래스 */
  tray?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cellPx, setCellPx] = useState(minCell);
  // 맵 마스크의 바운딩 박스로 맞춘다 — 빈 가장자리까지 세면 타일만 작아진다(v2).
  const bbox = boardBox(board);
  const bCols = bbox.c1 - bbox.c0 + 1;
  const bRows = bbox.r1 - bbox.r0 + 1;
  // 타일 수가 적을수록 크게 — 1280×800 패널에서 작은 맵이 허전하지 않도록.
  const cap = maxCell ?? (bCols * bRows <= 90 ? 80 : 64);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const usableH = h - (player ? HEADER_H : 0) - TRAY_PAD;
      const usableW = w - TRAY_PAD;
      const raw = Math.floor(Math.min(usableW / bCols, usableH / bRows)) - BOARD_GAP;
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
  }, [bCols, bRows, minCell, cap, player]);

  const boardWidth = bCols * (cellPx + BOARD_GAP) - BOARD_GAP + TRAY_PAD;

  return (
    <div
      ref={ref}
      // overflow-hidden이면 자리가 모자랄 때 바깥 줄이 **소리 없이 잘려** 타일이 사라진 것처럼 보인다.
      // 스크롤로 바꿔 두면 최악의 경우에도 전부 접근 가능하다.
      className={`flex h-full min-h-0 w-full min-w-0 justify-center overflow-auto scrollbar-none ${
        alignTop ? 'items-start md:items-center' : 'items-center'
      }`}
    >
      <div className="flex flex-col gap-1" style={{ width: boardWidth }}>
        {player && (
          <div data-ghc-player={player.userId} className="w-full">
            <PlayerHeader
              player={player}
              board={board}
              compact={compactHeader}
              isMe={isMe}
              isHost={isHost}
              showMeter={showMeter}
            />
          </div>
        )}
        <div
          data-ghc-board={board.id}
          className={`flex items-center justify-center p-[10px] ${tray ?? ''} ${onExpand ? 'cursor-zoom-in' : ''}`}
          title={onExpand ? '크게 보기' : undefined}
          onClick={onExpand}
        >
          <ShisenBoard board={board} player={player} interactive={interactive} cellPx={cellPx} />
        </div>
      </div>
    </div>
  );
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 경기 시간 — race+제한시간은 카운트다운, 그 외(쟁탈전·무제한)는 카운트업. */
function ArenaClock({ snapshot }: { snapshot: GameSnapshot }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (!snapshot.startAt) return null;
  const limit = snapshot.options.timeLimitSec;
  const end = snapshot.endedAt ?? now;
  const value = limit > 0
    ? snapshot.startAt + limit * 1000 - end
    : end - snapshot.startAt;
  const urgent = limit > 0 && value < 30000;
  return (
    <span className={`font-display tabular-nums text-sm ${urgent ? 'text-primary' : 'text-white/60'}`}>
      {fmtClock(value)}
    </span>
  );
}

/** 플레이어 수·역할별 아레나 레이아웃 + 카운트다운/결과 + 공격 연출 + 키보드. */
export function ShisenArena({ snapshot }: { snapshot: GameSnapshot }) {
  const myUserId = useAuthStore((s) => s.userId);
  const setHintPair = useGameStore((s) => s.setHintPair);
  const focusBoardId = useGameStore((s) => s.focusBoardId);
  const setFocusBoard = useGameStore((s) => s.setFocusBoard);
  const fxQueue = useGameStore((s) => s.fxQueue);
  const [hintBusy, setHintBusy] = useState(false);
  const shakeControls = useAnimationControls();
  const arenaRef = useRef<HTMLDivElement>(null);
  const reduced = prefersReducedMotion();

  const me = snapshot.players.find((p) => p.userId === myUserId);
  const theme = themeOf(snapshot.seed);
  const tray = TRAY_CLASS[theme];
  const notice = useGameStore((s) => s.notice);
  const banner = useGameStore((s) => s.banner);
  // 기권하면 내 판도 관전 취급 — 조작 불가 + 관전자 레이아웃.
  const meActive = !!me && !isForfeited(me);
  const isCoop = snapshot.mode === 'coop';
  const playing = snapshot.phase === 'playing';
  const others = snapshot.players.filter((p) => p.userId !== myUserId);
  const myBoard = me ? snapshot.boards[me.boardId] : undefined;
  const sharedBoard = snapshot.boards['shared'] ?? Object.values(snapshot.boards)[0];
  const interactiveBoardId = meActive ? (isCoop ? sharedBoard?.id : myBoard?.id) : undefined;
  const myPlayBoard = interactiveBoardId ? snapshot.boards[interactiveBoardId] : undefined;
  // 연결 가능 쌍 수: 서버 진실값(movesLeft, A3에서 추가)이 있으면 그걸, 없으면 보이는 판에서 계산.
  const visibleMoves = useMemo(
    () => (myPlayBoard ? countMoves(myPlayBoard) : 0),
    [myPlayBoard],
  );
  const serverMoves = (myPlayBoard as { movesLeft?: number } | undefined)?.movesLeft;
  const movesLeft = serverMoves ?? visibleMoves;
  const hiddenHint = visibleMoves === 0 && (serverMoves ?? 0) > 0;

  const boardOf = (p: PlayerState) => snapshot.boards[p.boardId];

  // 콤보 5 이상 제거 시 아레나 미세 흔들림(§6.3) — 실제 pop 연출 이벤트에서만, 한 번씩.
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

  // 짧은 안내는 1.2초, 배너는 2.5초 뒤 사라진다.
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

  const requestHint = useCallback(async () => {
    setHintBusy(true);
    try {
      const ack = await emitWithAck<HintAck>('game:hint', {});
      if (ack.ok) {
        setHintPair(ack.pair);
        playGameSound('hint');
        setTimeout(() => useGameStore.getState().setHintPair(null), 1800);
      } else {
        showToast('연결 가능한 쌍이 없어요', 'info');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '힌트를 쓸 수 없어요', 'error');
    } finally {
      setHintBusy(false);
    }
  }, [setHintPair]);

  // 키보드: 화살표 커서 이동 / Space·Enter 선택 / Esc 해제 / H 힌트 (§6.5)
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
          return;   // preventDefault 불필요
        case 'h':
        case 'H':
        case 'ㅗ':
          void requestHint();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, meActive, interactiveBoardId, requestHint]);

  const giveUp = async () => {
    try { await emitWithAck('game:spectate', {}); } catch (err) {
      showToast(err instanceof Error ? err.message : '기권할 수 없어요', 'error');
    }
  };

  const focusBoard = focusBoardId ? snapshot.boards[focusBoardId] : undefined;
  const focusPlayer = snapshot.players.find((p) => p.boardId === focusBoardId);

  return (
    <motion.div
      ref={arenaRef}
      animate={shakeControls}
      // isolate: 배경(-z-10)이 게임 패널 밖으로 빠지지 않도록 스태킹 컨텍스트를 만든다.
      className="relative isolate flex h-full min-h-0 flex-col gap-2 p-2"
    >
      <ThemeBackdrop theme={theme} seed={snapshot.seed} />

      {/* HUD */}
      <div className="relative flex shrink-0 items-center gap-2 px-1">
        <span className="text-xs text-white/40">{MODE_TEXT[snapshot.mode]}</span>
        {myPlayBoard && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              movesLeft === 0 ? 'bg-primary/20 text-primary' : 'bg-black/40 text-white/70'
            }`}
            title="지금 이을 수 있는 쌍"
          >
            {hiddenHint ? '물음표를 열어보세요' : `연결 가능 ${movesLeft}쌍`}
          </span>
        )}
        {myPlayBoard && myPlayBoard.nextNumber > 0 && (
          <span className="rounded-full bg-black/40 px-2 py-0.5 text-[11px] text-warning">
            다음 숫자 {myPlayBoard.nextNumber}
          </span>
        )}
        {myPlayBoard && myPlayBoard.keysLeft > 0 && (
          <span className="rounded-full bg-black/40 px-2 py-0.5 text-[11px] text-success">🔑 열쇠 찾는 중</span>
        )}
        <AnimatePresence>
          {notice && (
            <motion.span
              key={notice.at}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white/80"
            >
              {notice.text}
            </motion.span>
          )}
        </AnimatePresence>
        <span className="ml-auto flex items-center gap-2">
          <ArenaClock snapshot={snapshot} />
          {me && playing && meActive && (
            <>
              <button
                onClick={requestHint}
                disabled={hintBusy || me.hintsLeft <= 0}
                className="flex items-center gap-1 rounded-full bg-dark-700 px-2.5 py-1 text-xs text-white/80 transition-colors hover:bg-dark-600 disabled:opacity-40"
                title="힌트 (H)"
              >
                <Lightbulb size={13} className="text-warning" />
                {me.hintsLeft}
              </button>
              <button
                onClick={giveUp}
                className="rounded-full bg-dark-700 px-2.5 py-1 text-xs text-white/50 transition-colors hover:bg-dark-600"
              >
                기권
              </button>
            </>
          )}
        </span>
      </div>

      {/* 코옵: 보드 하나 + 플레이어 칩 */}
      {isCoop && sharedBoard ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <LiveScoreboard players={snapshot.players} myUserId={myUserId} />
          <div className="min-h-0 flex-1">
            <FittedBoard board={sharedBoard} interactive={playing && meActive} alignTop tray={tray} />
          </div>
        </div>
      ) : me && myBoard && meActive ? (
        /* 레이스: 내 판 + 상대 미니보드 */
        <div className="flex min-h-0 flex-1 flex-col gap-2 md:flex-row">
          {others.length > 0 && (
            <div
              className={`order-1 flex shrink-0 gap-2 overflow-x-auto overflow-y-hidden scrollbar-none
                h-24 md:order-2 md:h-auto md:flex-col md:overflow-x-hidden md:overflow-y-auto md:w-[34%]`}
            >
              {others.map((p) => {
                const b = boardOf(p);
                if (!b) return null;
                return (
                  <div key={p.userId} className="h-full w-[62%] shrink-0 md:h-auto md:w-full md:flex-1">
                    <FittedBoard
                      board={b}
                      player={p}
                      interactive={false}
                      minCell={10}
                      maxCell={38}
                      tray={tray}
                      compactHeader
                      isHost={p.userId === snapshot.hostUserId}
                      showMeter={snapshot.options.items}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <div className="order-2 min-h-0 min-w-0 flex-1 md:order-1">
            <FittedBoard
              board={myBoard}
              player={me}
              interactive={playing}
              alignTop
              tray={tray}
              isMe
              isHost={me.userId === snapshot.hostUserId}
              showMeter={snapshot.options.items}
            />
          </div>
        </div>
      ) : (
        /* 관전자: 균등 그리드 */
        <div
          className={`grid min-h-0 flex-1 gap-2 ${
            snapshot.players.length <= 1 ? 'grid-cols-1'
              : snapshot.players.length === 2 ? 'grid-cols-1 sm:grid-cols-2'
                : 'grid-cols-1 sm:grid-cols-2 sm:grid-rows-2'
          }`}
        >
          {snapshot.players.map((p) => {
            const b = boardOf(p);
            if (!b) return null;
            return (
              <div key={p.userId} className="min-h-0 min-w-0">
                <FittedBoard
                  board={b}
                  player={p}
                  interactive={false}
                  minCell={10}
                  tray={tray}
                  compactHeader
                  isMe={p.userId === myUserId}
                  isHost={p.userId === snapshot.hostUserId}
                  showMeter={snapshot.options.items}
                  onExpand={() => setFocusBoard(b.id)}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* 미니보드 확대 보기 */}
      {focusBoard && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-dark-900/90 p-3"
          onClick={() => setFocusBoard(null)}
        >
          <div className="h-full w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-end">
              <button onClick={() => setFocusBoard(null)} className="btn-icon bg-dark-700 hover:bg-dark-600">
                <X size={18} />
              </button>
            </div>
            <div className="h-[calc(100%-3rem)]">
              <FittedBoard board={focusBoard} player={focusPlayer} interactive={false} tray={tray} />
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {banner && (
          <motion.div
            key={banner.at}
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="pointer-events-none absolute left-1/2 top-12 z-30 -translate-x-1/2 rounded-full bg-black/75 px-4 py-1.5 text-xs text-white/90 shadow-lg"
          >
            {banner.text}
          </motion.div>
        )}
      </AnimatePresence>

      <ComboFx boardId={interactiveBoardId} myUserId={myUserId} />
      <AttackFxLayer myBoardId={interactiveBoardId} arenaRef={arenaRef} />

      {snapshot.phase === 'countdown' && snapshot.startAt && (
        <Countdown startAt={snapshot.startAt} modeText={MODE_TEXT[snapshot.mode]} />
      )}
      {snapshot.phase === 'finished' && <ResultsOverlay snapshot={snapshot} />}
    </motion.div>
  );
}
