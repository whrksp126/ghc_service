import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useAnimationControls } from 'framer-motion';
import { Lightbulb, X } from 'lucide-react';
import { useGameStore } from '../../stores/gameStore';
import { useAuthStore } from '../../stores/authStore';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { playGameSound } from '../../games/sounds';
import { prefersReducedMotion } from '../../games/motion';
import { ShisenBoard, BOARD_GAP, pickActiveTile, emitSelect } from './ShisenBoard';
import { PlayerHeader } from './PlayerHeader';
import { Countdown } from './Countdown';
import { ResultsOverlay } from './ResultsOverlay';
import { AttackFxLayer } from './AttackFx';
import type { Board, GameSnapshot, HintAck, PlayerState } from '../../games/types';

const MODE_TEXT: Record<string, string> = {
  race: '같은 판이에요 — 누가 먼저?',
  coop: '한 판을 같이 지워요',
};

/** 헤더 카드가 차지하는 높이(px) — 보드 크기 계산에서 미리 빼 둔다. */
const HEADER_H = 30;

/** 컨테이너를 실측해 `cellPx`를 구하고, 헤더 카드 + 보드를 보드 폭에 맞춰 세로 중앙 배치한다(§6.2). */
function FittedBoard({
  board, player, interactive, minCell = 22, maxCell, compactHeader, isMe, isHost, showMeter, onExpand,
  alignTop,
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
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [cellPx, setCellPx] = useState(minCell);
  // 작은 판일수록 타일을 크게 — 1280×800 패널에서 8×5 판이 허전하지 않도록.
  const cap = maxCell ?? (board.cols * board.rows <= 72 ? 80 : 64);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const usableH = h - (player ? HEADER_H : 0);
      const raw = Math.floor(Math.min(w / board.cols, usableH / board.rows)) - BOARD_GAP;
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
  }, [board.cols, board.rows, minCell, cap, player]);

  const boardWidth = board.cols * (cellPx + BOARD_GAP) - BOARD_GAP;

  return (
    <div
      ref={ref}
      className={`flex h-full min-h-0 w-full min-w-0 justify-center overflow-hidden ${
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
          className={onExpand ? 'cursor-zoom-in' : undefined}
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

/** 경기 시간 — race+제한시간은 카운트다운, 그 외(협동·무제한)는 카운트업. */
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
  // 기권하면 내 판도 관전 취급 — 조작 불가 + 관전자 레이아웃.
  const meActive = !!me && !me.forfeited;
  const isCoop = snapshot.mode === 'coop';
  const playing = snapshot.phase === 'playing';
  const others = snapshot.players.filter((p) => p.userId !== myUserId);
  const myBoard = me ? snapshot.boards[me.boardId] : undefined;
  const sharedBoard = snapshot.boards['shared'] ?? Object.values(snapshot.boards)[0];
  const interactiveBoardId = meActive ? (isCoop ? sharedBoard?.id : myBoard?.id) : undefined;

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
      className="relative flex h-full min-h-0 flex-col gap-2 p-2"
    >
      {/* HUD */}
      <div className="flex shrink-0 items-center gap-2 px-1">
        <span className="text-xs text-white/40">{MODE_TEXT[snapshot.mode]}</span>
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
          <div className="flex shrink-0 flex-wrap gap-1.5 px-1">
            {snapshot.players.map((p) => (
              <span
                key={p.userId}
                data-ghc-player={p.userId}
                className="flex items-center gap-1.5 rounded-full bg-white/5 px-2 py-0.5 text-[11px]"
                style={{ boxShadow: `inset 0 0 0 1px ${p.color}55` }}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                <span className="max-w-[80px] truncate">{p.nickname}</span>
                <span className="font-display tabular-nums text-white/50">{p.pairsCleared}쌍</span>
                {p.combo > 1 && <span className="font-display text-secondary">x{p.combo}</span>}
              </span>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            <FittedBoard board={sharedBoard} interactive={playing && meActive} alignTop />
          </div>
        </div>
      ) : me && myBoard && meActive ? (
        /* 레이스: 내 판 + 상대 미니보드 */
        <div className="flex min-h-0 flex-1 flex-col gap-2 md:flex-row">
          {others.length > 0 && (
            <div
              className={`order-1 flex shrink-0 gap-2 overflow-x-auto overflow-y-hidden scrollbar-none
                h-24 md:order-2 md:h-auto md:flex-col md:overflow-x-hidden md:overflow-y-auto
                ${others.length === 1 ? 'md:w-1/2' : 'md:w-[34%]'}`}
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
                      maxCell={others.length === 1 ? 80 : 34}
                      compactHeader
                      isHost={p.userId === snapshot.hostUserId}
                      showMeter={snapshot.options.items}
                      onExpand={() => setFocusBoard(b.id)}
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
              <FittedBoard board={focusBoard} player={focusPlayer} interactive={false} />
            </div>
          </div>
        </div>
      )}

      <AttackFxLayer myBoardId={interactiveBoardId} arenaRef={arenaRef} />

      {snapshot.phase === 'countdown' && snapshot.startAt && (
        <Countdown startAt={snapshot.startAt} modeText={MODE_TEXT[snapshot.mode]} />
      )}
      {snapshot.phase === 'finished' && <ResultsOverlay snapshot={snapshot} />}
    </motion.div>
  );
}
