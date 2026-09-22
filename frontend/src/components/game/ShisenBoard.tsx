import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { motion } from 'framer-motion';
import { useGameStore, type FxEvent } from '../../stores/gameStore';
import { useAuthStore } from '../../stores/authStore';
import { findPath } from '../../games/shisen/engine';
import { playGameSound } from '../../games/sounds';
import { prefersReducedMotion } from '../../games/motion';
import { emitWithAck, getSocket } from '../../lib/socket';
import { syncGame } from '../../hooks/useGameSocket';
import { showToast } from '../common/Toast';
import { ShisenTile } from './ShisenTile';
import { BoardEffectOverlay } from './AttackFx';
import { symbolOf } from '../../games/symbols';
import type { Board, Effect, PickAck, PickReason, PlayerState, Point } from '../../games/types';

export const BOARD_GAP = 4;

interface ShisenBoardProps {
  board: Board;
  /** 이 보드의 주인(협동은 undefined). 헤더는 PlayerHeader가 따로 그린다. */
  player?: PlayerState;
  /** 내가 클릭할 수 있는 판인지 */
  interactive: boolean;
  cellPx: number;
}

/** 예상 밖의 거절만 토스트로 알린다. `gone`은 협동에서 흔해서 토스트를 띄우지 않는다. */
const PICK_REASON_TEXT: Partial<Record<PickReason, string>> = {
  same: '같은 타일이에요',
  symbol: '다른 그림이에요',
  nopath: '이어지지 않아요',
  phase: '아직 시작 전이에요',
};

// game:select 스로틀(50ms) — 상대에게 내 첫 선택만 알려주면 되므로 유실돼도 무방하다.
let lastSelectAt = 0;
let selectTimer: ReturnType<typeof setTimeout> | null = null;
export function emitSelect(idx: number | null) {
  const send = () => {
    lastSelectAt = Date.now();
    try { getSocket().emit('game:select', { idx }); } catch { /* 연결 전 — 무시 */ }
  };
  if (selectTimer) { clearTimeout(selectTimer); selectTimer = null; }
  const wait = 50 - (Date.now() - lastSelectAt);
  if (wait <= 0) send();
  else selectTimer = setTimeout(send, wait);
}

/**
 * 현재 "내가 조작 가능한" 보드의 클릭 핸들러. 키보드 입력(Space/Enter)이 마우스 클릭과
 * **똑같은 경로**(예측·롤백 포함)를 타도록 아레나가 이걸 통해 타일을 누른다.
 */
let activePickHandler: ((idx: number) => void) | null = null;
export function pickActiveTile(idx: number) { activePickHandler?.(idx); }

/** freeze 한 번당 토스트도 한 번만 (연타하면 5개씩 쌓였다). */
let lastFrozenToastUntil = 0;
function toastFrozenOnce(until: number) {
  if (until <= lastFrozenToastUntil) return;
  lastFrozenToastUntil = until;
  showToast('얼어붙었어요 — 잠깐만요', 'info');
}

/**
 * 효과(freeze/fog) 표시용 시계.
 * 반환값은 **렌더 시점의 진짜 `Date.now()`** 다 — state에 담아 두면 타이머가 멈춘 사이
 * (효과가 잠깐 비었다가 다시 들어오는 등) 낡은 값으로 "1.9s"가 굳어버린다.
 * state는 "다시 그려라" 신호로만 쓰고, 마지막 효과가 끝나는 순간에도 한 번 더 강제로 그린다.
 */
function useEffectClock(effects: Effect[]): number {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const maxUntil = effects.reduce((m, e) => Math.max(m, e.until), 0);
  useEffect(() => {
    const left = maxUntil - Date.now();
    if (left <= 0) return;
    const tick = setInterval(force, 100);
    // 만료 직후 1회 — 스토어 갱신이 없어도 서리/안개가 반드시 걷힌다.
    const end = setTimeout(force, left + 60);
    return () => { clearInterval(tick); clearTimeout(end); };
  }, [maxUntil]);
  return Date.now();
}

/**
 * 보드 1개. 타일 그리드 + 경로 SVG 오버레이 + 파티클 + 효과 오버레이.
 * 좌표는 전부 `cellPx`/`BOARD_GAP` 픽셀 계산이라 SVG와 타일이 정확히 겹친다.
 */
export function ShisenBoard({ board, interactive, cellPx }: ShisenBoardProps) {
  const snapshot = useGameStore((s) => s.snapshot);
  const selectedIdx = useGameStore((s) => s.selectedIdx);
  const cursorIdx = useGameStore((s) => s.cursorIdx);
  const hintPair = useGameStore((s) => s.hintPair);
  const peerSelect = useGameStore((s) => s.peerSelect);
  const fxQueue = useGameStore((s) => s.fxQueue);
  const myUserId = useAuthStore((s) => s.userId);
  const reduced = prefersReducedMotion();

  const glowId = `shisen-glow-${board.id}`;
  const step = cellPx + BOARD_GAP;
  const width = board.cols * step - BOARD_GAP;
  const height = board.rows * step - BOARD_GAP;

  const now = useEffectClock(board.effects);
  const fog = board.effects.find((e) => e.type === 'fog' && e.until > now);
  const masked = useMemo(() => new Set(fog?.hidden ?? []), [fog]);

  const myPlayer = snapshot?.players.find((p) => p.userId === myUserId);
  const myColor = myPlayer?.color ?? '#FE2C55';
  // 콤보 4 이상이면 판 테두리가 은은하게 빛난다(§6.3).
  const comboGlow = interactive && (myPlayer?.combo ?? 0) >= 4 ? myColor : null;

  // 이 판에 표시할 상대 선택: race=보드 주인, coop=나를 뺀 모든 플레이어.
  const peerMarks = useMemo(() => {
    const out: Record<number, string> = {};
    if (!snapshot) return out;
    for (const p of snapshot.players) {
      if (p.boardId !== board.id) continue;
      if (p.userId === myUserId && interactive) continue;
      const idx = peerSelect[p.userId];
      if (idx === null || idx === undefined) continue;
      out[idx] = p.color;
    }
    return out;
  }, [snapshot, peerSelect, board.id, myUserId, interactive]);

  // 이 보드에 해당하는 연출만 소비한다.
  const fx = useMemo(() => fxQueue.filter((f) => f.boardId === board.id), [fxQueue, board.id]);
  const shakeCells = useMemo(() => {
    const set = new Set<number>();
    fx.filter((f) => f.type === 'invalid').forEach((f) => f.cells?.forEach((c) => set.add(c)));
    return set;
  }, [fx]);
  const flashCells = useMemo(() => {
    const out: Record<number, string> = {};
    fx.filter((f) => f.type === 'flash').forEach((f) => f.cells?.forEach((c) => { out[c] = f.color ?? '#FFFFFF'; }));
    return out;
  }, [fx]);
  const tumbling = fx.some((f) => f.type === 'shuffle');

  // 일회성 연출(흔들림·번쩍임·셔플)은 시간이 지나면 스스로 큐에서 빠진다.
  // deps는 배열 대신 **id 문자열** — 매 렌더(효과 시계·아레나 타이머)마다 타이머가 리셋되면
  // 연출이 영영 안 걷힌다.
  const oneShotKey = fx
    .filter((f) => f.type === 'invalid' || f.type === 'shuffle' || f.type === 'flash')
    .map((f) => f.id)
    .join(',');
  useEffect(() => {
    if (!oneShotKey) return;
    const ids = oneShotKey.split(',').map(Number);
    const t = setTimeout(() => {
      const consume = useGameStore.getState().consumeFx;
      ids.forEach(consume);
    }, 320);
    return () => clearTimeout(t);
  }, [oneShotKey]);

  const handleTile = useCallback(async (idx: number) => {
    if (!interactive) return;
    const st = useGameStore.getState();
    const snap = st.snapshot;
    if (!snap || snap.phase !== 'playing') return;
    const live = snap.boards[board.id];
    if (!live || live.cells[idx] === 0) return;
    st.setCursor(idx);

    const frozen = live.effects.find((e) => e.type === 'freeze' && e.until > Date.now());
    if (frozen) {
      st.pushFx({ type: 'invalid', boardId: board.id, cells: [idx] });
      playGameSound('invalid');
      toastFrozenOnce(frozen.until);
      return;
    }

    const sel = st.selectedIdx;
    if (sel === null || live.cells[sel] === 0) {
      st.setSelected(idx);
      emitSelect(idx);
      playGameSound('select');
      return;
    }
    if (sel === idx) {
      st.setSelected(null);
      emitSelect(null);
      return;
    }
    // 다른 그림이거나 길이 없으면 — 흔들고 방금 누른 타일을 새 첫 선택으로(사천성 관례).
    const sameSymbol = live.cells[sel] === live.cells[idx];
    const path = sameSymbol ? findPath(live.cells, live.cols, live.rows, sel, idx) : null;
    if (!path) {
      st.pushFx({ type: 'invalid', boardId: board.id, cells: [sel, idx] });
      st.setSelected(idx);
      emitSelect(idx);
      playGameSound('invalid');
      return;
    }

    // --- 클라 예측: 즉시 제거하고 서버 응답을 기다린다 ---
    st.predictPick(board.id, sel, idx, path, myColor);
    emitSelect(null);
    playGameSound('match', { combo: (st.me()?.combo ?? 0) + 1 });
    if (!reduced) navigator.vibrate?.(10);

    try {
      const ack = await emitWithAck<PickAck>('game:pick', { a: sel, b: idx });
      if (ack.ok) return;
      const store = useGameStore.getState();
      const pick = store.takePending(sel, idx);
      if (!pick) return;   // 이미 `game:matched`로 확정된 픽
      if (ack.reason === 'gone' || pick.superseded) {
        // 협동에서 흔한 충돌 — 타일은 정말로 사라진 게 맞으니 **되살리지 않는다**.
        store.dropPending(pick);
        playGameSound('invalid', { gain: 0.35 });
        return;
      }
      store.rollbackPick(pick);
      if (ack.reason === 'frozen') {
        playGameSound('attackHit');
        const until = store.snapshot?.boards[board.id]?.effects
          .find((e) => e.type === 'freeze')?.until ?? Date.now();
        toastFrozenOnce(until);
      } else {
        playGameSound('invalid');
        const msg = PICK_REASON_TEXT[ack.reason];
        if (msg) showToast(msg, 'error');
      }
      // 되살린 뒤에는 서버 상태로 한 번 맞춰 둔다(어긋남 방지).
      void syncGame();
    } catch (err) {
      const store = useGameStore.getState();
      const pick = store.takePending(sel, idx);
      if (pick) store.rollbackPick(pick);
      showToast(err instanceof Error ? err.message : '서버 응답 실패', 'error');
      void syncGame();
    }
  }, [interactive, board.id, myColor, reduced]);

  // 키보드 입력이 쓸 수 있도록 현재 조작 가능한 보드의 핸들러를 등록해 둔다.
  useEffect(() => {
    if (!interactive) return;
    activePickHandler = handleTile;
    return () => { if (activePickHandler === handleTile) activePickHandler = null; };
  }, [interactive, handleTile]);

  return (
    <div
      className="relative shrink-0 rounded-xl"
      style={{
        width,
        height,
        boxShadow: comboGlow ? `0 0 24px ${comboGlow}55` : undefined,
      }}
    >
      {board.cells.map((sym, idx) => {
        if (sym === 0) return null;
        const r = Math.floor(idx / board.cols);
        const c = idx % board.cols;
        return (
          <ShisenTile
            key={idx}
            idx={idx}
            symbol={sym}
            x={c * step}
            y={r * step}
            size={cellPx}
            selected={interactive && selectedIdx === idx}
            selectColor={myColor}
            peerColor={peerMarks[idx]}
            hint={interactive && !!hintPair && (hintPair[0] === idx || hintPair[1] === idx)}
            masked={masked.has(idx)}
            shake={shakeCells.has(idx)}
            flashColor={flashCells[idx]}
            focused={interactive && cursorIdx === idx && selectedIdx !== idx}
            tumble={tumbling}
            tumbleDelay={tumbling ? (idx * 37) % 200 : 0}
            reduced={reduced}
            /* 얼어 있어도 클릭은 받는다 — handleTile이 흔들림 피드백을 준다(§6.3) */
            interactive={interactive}
            onClick={handleTile}
          />
        );
      })}

      {/* 제거 고스트 + 파티클 */}
      {fx.filter((f) => f.type === 'pop').map((f) => (
        <PopGhosts key={f.id} fx={f} cols={board.cols} step={step} size={cellPx} reduced={reduced} />
      ))}

      {/* 네온 경로 */}
      <svg
        className="absolute left-0 top-0 pointer-events-none overflow-visible"
        width={width}
        height={height}
      >
        <defs>
          {/* 보드마다 고유 id — 여러 보드가 같은 filter id를 쓰면 DOM id가 중복된다 */}
          <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {fx.filter((f) => f.type === 'path' && f.path).map((f) => (
          <PathLine key={f.id} fx={f} step={step} size={cellPx} reduced={reduced} glowId={glowId} />
        ))}
      </svg>

      <BoardEffectOverlay board={board} now={now} width={width} height={height} />
    </div>
  );
}

function pointToXY(p: Point, step: number, size: number) {
  return { x: p.c * step + size / 2, y: p.r * step + size / 2 };
}

/** 경로 폴리라인 — 120ms에 걸쳐 그려지고 200ms 페이드 후 스스로 큐에서 빠진다. */
function PathLine({
  fx, step, size, reduced, glowId,
}: { fx: FxEvent; step: number; size: number; reduced: boolean; glowId: string }) {
  const consumeFx = useGameStore((s) => s.consumeFx);
  const total = reduced ? 0.2 : 0.42;
  useEffect(() => {
    const t = setTimeout(() => consumeFx(fx.id), total * 1000);
    return () => clearTimeout(t);
  }, [fx.id, consumeFx, total]);
  const pts = (fx.path ?? []).map((p) => pointToXY(p, step, size));
  const d = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const color = fx.color ?? '#25F4EE';
  return (
    <motion.polyline
      points={d}
      fill="none"
      stroke={color}
      strokeWidth={4}
      strokeLinecap="round"
      strokeLinejoin="round"
      filter={`url(#${glowId})`}
      initial={{ pathLength: 0, opacity: 1 }}
      animate={{ pathLength: 1, opacity: [1, 1, 0] }}
      transition={{
        pathLength: { duration: reduced ? 0.05 : 0.12 },
        opacity: { duration: total, times: [0, 0.5, 1] },
      }}
    />
  );
}

/** 결정적 의사난수 — 파티클이 매 렌더 튀지 않도록 인덱스로 각도를 만든다. */
const PARTICLES = 8;

/** 제거된 두 타일의 잔상(scale 1.15 → 0) + 8방향 색 파티클. */
function PopGhosts({
  fx, cols, step, size, reduced,
}: { fx: FxEvent; cols: number; step: number; size: number; reduced: boolean }) {
  const consumeFx = useGameStore((s) => s.consumeFx);
  useEffect(() => {
    const t = setTimeout(() => consumeFx(fx.id), reduced ? 140 : 420);
    return () => clearTimeout(t);
  }, [fx.id, consumeFx, reduced]);
  const sym = fx.symbol ? symbolOf(fx.symbol) : null;
  const color = fx.color ?? '#25F4EE';
  return (
    <>
      {(fx.cells ?? []).map((idx) => {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        const Icon = sym?.icon;
        const cx = c * step + size / 2;
        const cy = r * step + size / 2;
        return (
          <div key={idx}>
            <motion.div
              className="absolute rounded-[10px] pointer-events-none flex items-center justify-center"
              style={{
                left: c * step,
                top: r * step,
                width: size,
                height: size,
                background: `radial-gradient(circle, ${color}55, transparent 70%)`,
              }}
              initial={{ scale: 1, opacity: 1 }}
              animate={{ scale: [1.15, 0], opacity: [1, 0] }}
              transition={{ duration: reduced ? 0.1 : 0.16 }}
            >
              {Icon && <Icon size={Math.round(size * 0.55)} color={sym?.color} />}
            </motion.div>

            {!reduced && Array.from({ length: PARTICLES }).map((_, i) => {
              const angle = (i / PARTICLES) * Math.PI * 2;
              const dist = size * 0.9;
              return (
                <motion.span
                  key={i}
                  className="absolute rounded-full pointer-events-none"
                  style={{
                    left: cx - 2,
                    top: cy - 2,
                    width: 4,
                    height: 4,
                    background: i % 2 === 0 ? color : sym?.color ?? color,
                  }}
                  initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
                  animate={{
                    x: Math.cos(angle) * dist,
                    y: Math.sin(angle) * dist,
                    opacity: 0,
                    scale: 0.4,
                  }}
                  transition={{ duration: 0.38, ease: 'easeOut' }}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}
