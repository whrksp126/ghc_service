import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useGameStore, predictedCombo, type FxEvent } from '../../stores/gameStore';
import { useAuthStore } from '../../stores/authStore';
import { canPick, findPath } from '../../games/shisen/engine';
import { playGameSound } from '../../games/sounds';
import { prefersReducedMotion } from '../../games/motion';
import { emitWithAck, getSocket } from '../../lib/socket';
import { syncGame } from '../../hooks/useGameSocket';
import { showToast } from '../common/Toast';
import { ShisenTile, kindOf } from './ShisenTile';
import { BoardEffectOverlay } from './AttackFx';
import { symbolOf } from '../../games/symbols';
import {
  EMPTY, MYSTERY, NUMBER_BASE, WALL,
  type Board, type Effect, type PlayerState, type Point,
} from '../../games/types';
import { isLockValue } from '../../games/v3';
import type { PeekAck, PickAck, PickReason } from '../../games/events';

export const BOARD_GAP = 4;

interface ShisenBoardProps {
  board: Board;
  /** (v4) 보드 위 헤더는 좌측 프로필 컬럼으로 옮겨져 더 이상 쓰지 않는다. */
  player?: PlayerState;
  /** 내가 클릭할 수 있는 판인지 */
  interactive: boolean;
  cellPx: number;
}

/** 규칙 위반은 토스트 대신 HUD 옆 짧은 안내로 (v2 §V5) */
const REASON_NOTICE: Partial<Record<PickReason, string>> = {
  symbol: '다른 그림이에요',
  nopath: '이어지지 않아요',
  locked: '같은 색 열쇠를 먼저 찾아요',
  wall: '벽은 지울 수 없어요',
  phase: '아직 시작 전이에요',
  gone: '먼저 지워졌어요',
};

/** 마스크(맵 모양)의 바운딩 박스 — 빈 가장자리 때문에 타일이 작아지지 않게. */
export interface BoardBox { r0: number; c0: number; r1: number; c1: number }
const boxCache = new Map<string, { box: BoardBox; remaining: number }>();

/** 지금 cells에 실제로 타일이 있는 영역(빈칸 제외). */
function footprint(board: Board): BoardBox {
  let r0 = board.rows; let c0 = board.cols; let r1 = -1; let c1 = -1;
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i] === EMPTY) continue;      // EMPTY(0)만 빈칸. WALL(-1)·98·99·100·200+ 는 모두 타일.
    const r = Math.floor(i / board.cols); const c = i % board.cols;
    if (r < r0) r0 = r;
    if (c < c0) c0 = c;
    if (r > r1) r1 = r;
    if (c > c1) c1 = c;
  }
  return r1 < 0 ? { r0: 0, c0: 0, r1: board.rows - 1, c1: board.cols - 1 } : { r0, c0, r1, c1 };
}

/**
 * 판에 실제로 타일이 놓이는 영역. 진행 중에는 타일이 줄기만 하므로 **처음 잡은 박스를 유지**한다
 * (줄어드는 대로 다시 잡으면 판이 점점 커지며 출렁인다).
 *
 * 다만 캐시된 박스를 그대로 쓰면 **다음 판(같은 boardId)의 마스크가 더 넓을 때 바깥 타일이
 * 잘려 보이지 않는다** — 그래서 항상 현재 footprint와 **합집합**을 취한다.
 * 이 불변식 덕분에 어떤 셀도 박스 밖으로 나갈 수 없다(= 크롭으로 타일이 사라지지 않는다).
 */
export function boardBox(board: Board): BoardBox {
  const key = `${board.id}:${board.cols}x${board.rows}`;
  const cur = footprint(board);
  const hit = boxCache.get(key);
  if (hit && board.remaining <= hit.remaining) {
    const merged: BoardBox = {
      r0: Math.min(hit.box.r0, cur.r0),
      c0: Math.min(hit.box.c0, cur.c0),
      r1: Math.max(hit.box.r1, cur.r1),
      c1: Math.max(hit.box.c1, cur.c1),
    };
    boxCache.set(key, { box: merged, remaining: hit.remaining });
    return merged;
  }
  boxCache.set(key, { box: cur, remaining: board.remaining });
  return cur;
}

/**
 * 현재 "내가 조작 가능한" 보드의 클릭 핸들러. 키보드 입력(Space/Enter)이 마우스 클릭과
 * **똑같은 경로**(예측·롤백 포함)를 타도록 아레나가 이걸 통해 타일을 누른다.
 */
let activePickHandler: ((idx: number) => void) | null = null;
export function pickActiveTile(idx: number) { activePickHandler?.(idx); }

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

/** freeze 한 번당 토스트도 한 번만 (연타하면 5개씩 쌓였다). */
let lastFrozenToastUntil = 0;
function toastFrozenOnce(until: number) {
  if (until <= lastFrozenToastUntil) return;
  lastFrozenToastUntil = until;
  showToast('얼어붙었어요 — 잠깐만요', 'info');
}

/**
 * 효과(freeze/fog) 표시용 시계. 반환값은 **렌더 시점의 진짜 `Date.now()`** 다 —
 * state에 담아 두면 타이머가 멈춘 사이 낡은 값으로 "1.9s"가 굳어버린다.
 */
function useEffectClock(effects: Effect[]): number {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const maxUntil = effects.reduce((m, e) => Math.max(m, e.until), 0);
  useEffect(() => {
    const left = maxUntil - Date.now();
    if (left <= 0) return;
    const tick = setInterval(force, 100);
    const end = setTimeout(force, left + 60);
    return () => { clearInterval(tick); clearTimeout(end); };
  }, [maxUntil]);
  return Date.now();
}

/**
 * 보드 1개. 마작 타일 그리드 + 경로 SVG 오버레이 + 파티클 + 효과 오버레이.
 * 좌표는 마스크 바운딩 박스 기준 픽셀이라 SVG와 타일이 정확히 겹친다.
 */
export function ShisenBoard({ board, interactive, cellPx }: ShisenBoardProps) {
  const snapshot = useGameStore((s) => s.snapshot);
  const selectedIdx = useGameStore((s) => s.selectedIdx);
  const cursorIdx = useGameStore((s) => s.cursorIdx);
  const peek = useGameStore((s) => s.peek);
  const hintPair = useGameStore((s) => s.hintPair);
  const peerSelect = useGameStore((s) => s.peerSelect);
  const fxQueue = useGameStore((s) => s.fxQueue);
  const myUserId = useAuthStore((s) => s.userId);
  const reduced = prefersReducedMotion();

  const glowId = `shisen-glow-${board.id}`;
  const box = boardBox(board);
  const cols = box.c1 - box.c0 + 1;
  const rows = box.r1 - box.r0 + 1;
  const step = cellPx + BOARD_GAP;
  const width = cols * step - BOARD_GAP;
  const height = rows * step - BOARD_GAP;
  const xOf = (c: number) => (c - box.c0) * step;
  const yOf = (r: number) => (r - box.r0) * step;

  const now = useEffectClock(board.effects);
  const fog = board.effects.find((e) => e.type === 'fog' && e.until > now);
  const masked = useMemo(() => new Set(fog?.hidden ?? []), [fog]);

  const myPlayer = snapshot?.players.find((p) => p.userId === myUserId);
  const myColor = myPlayer?.color ?? '#FE2C55';
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
  // 공개/해제 뒤집기: 자물쇠 해제는 순차(60ms 간격)로 넘어간다.
  const flips = useMemo(() => {
    const out: Record<number, { key: number; delay: number }> = {};
    fx.filter((f) => f.type === 'unlock').forEach((f) => {
      (f.cells ?? []).forEach((c, i) => { out[c] = { key: f.id, delay: i * 60 }; });
    });
    return out;
  }, [fx]);
  const tumbling = fx.some((f) => f.type === 'shuffle');

  // 엿보기는 열릴 때와 닫힐 때 모두 그 타일을 뒤집는다(v3 W1/W3).
  const [peekAnim, setPeekAnim] = useState<{ idx: number; nonce: number } | null>(null);
  const prevPeekIdx = useRef<number | null>(null);
  useEffect(() => {
    const cur = peek?.idx ?? null;
    const prev = prevPeekIdx.current;
    if (cur === prev) return;
    prevPeekIdx.current = cur;
    const target = cur ?? prev;
    if (target !== null) setPeekAnim({ idx: target, nonce: Date.now() });
  }, [peek]);

  const oneShotKey = fx
    .filter((f) => ['invalid', 'shuffle', 'flash', 'unlock'].includes(f.type))
    .map((f) => f.id)
    .join(',');
  useEffect(() => {
    if (!oneShotKey) return;
    const ids = oneShotKey.split(',').map(Number);
    const t = setTimeout(() => {
      const consume = useGameStore.getState().consumeFx;
      ids.forEach(consume);
    }, 400);
    return () => clearTimeout(t);
  }, [oneShotKey]);

  const handleTile = useCallback(async (idx: number) => {
    if (!interactive) return;
    const st = useGameStore.getState();
    const snap = st.snapshot;
    if (!snap || snap.phase !== 'playing') return;
    const live = snap.boards[board.id];
    if (!live) return;
    const value = live.cells[idx];
    if (value === EMPTY) return;
    st.setCursor(idx);

    const frozen = live.effects.find((e) => e.type === 'freeze' && e.until > Date.now());
    if (frozen) {
      st.pushFx({ type: 'invalid', boardId: board.id, cells: [idx] });
      playGameSound('invalid');
      toastFrozenOnce(frozen.until);
      return;
    }

    // 벽·자물쇠는 선택 자체가 안 된다 — 흔들림 + 짧은 안내만.
    if (value === WALL || isLockValue(value)) {
      st.pushFx({ type: 'invalid', boardId: board.id, cells: [idx] });
      st.setNotice(value === WALL ? '벽은 지울 수 없어요' : '같은 색 열쇠를 먼저 찾아요');
      playGameSound('invalid', { gain: 0.5 });
      return;
    }

    // 물음표를 **첫 선택**으로 누르면 엿보기(v3 W1). 두 번째 선택이면 아래 pick 경로로 간다.
    if (value === MYSTERY && st.selectedIdx === null) {
      try {
        const ack = await emitWithAck<PeekAck>('game:peek', { idx });
        if (ack.ok) {
          playGameSound('reveal');
          // 뒤집기 연출은 peekAnim이 담당한다(fx 큐에 남기지 않는다 — v4에서 영구 공개는 없음).
          useGameStore.getState().setPeek({ idx, symbol: ack.symbol });
          useGameStore.getState().setSelected(idx);
          emitSelect(idx);
        } else {
          st.setNotice(REASON_NOTICE[ack.reason] ?? '지금은 볼 수 없어요');
        }
      } catch {
        st.setNotice('지금은 볼 수 없어요');
      }
      return;
    }

    const sel = st.selectedIdx;
    if (sel === null || live.cells[sel] === EMPTY) {
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

    // 엿보고 있는 물음표는 그 심볼로 취급해서 판정한다(서버는 진실 심볼로 판정 — v3 W1).
    const peeked = useGameStore.getState().peek;
    const resolved = live.cells.slice();
    if (peeked && resolved[peeked.idx] === MYSTERY) resolved[peeked.idx] = peeked.symbol;
    const unknown = resolved[sel] === MYSTERY || resolved[idx] === MYSTERY;

    if (unknown) {
      // 아직 못 본 물음표가 끼어 있으면 예측하지 않고 서버 판정에 맡긴다.
      st.setSelected(null);
      st.setPeek(null);
      emitSelect(null);
      try {
        const ack = await emitWithAck<PickAck>('game:pick', { a: sel, b: idx });
        if (!ack.ok) {
          useGameStore.getState().pushFx({ type: 'invalid', boardId: board.id, cells: [sel, idx] });
          useGameStore.getState().setNotice(REASON_NOTICE[ack.reason] ?? '지울 수 없어요');
          playGameSound('invalid');
        }
      } catch {
        void syncGame();
      }
      return;
    }

    // v2/v3 규칙 검사(같은 심볼 + 숫자 순서 + 잠금 + 경로)를 서버와 같은 함수로.
    const view = {
      cells: resolved, cols: live.cols, rows: live.rows,
      nextNumber: live.nextNumber, keysLeft: live.keysLeft,
    };
    const reason = canPick(view, sel, idx);
    if (reason) {
      st.pushFx({ type: 'invalid', boardId: board.id, cells: [sel, idx] });
      st.setNotice(
        reason === 'order'
          ? `${live.nextNumber}번부터 지워야 해요`
          : REASON_NOTICE[reason] ?? '이어지지 않아요',
      );
      st.setSelected(idx);
      st.setPeek(null);
      emitSelect(idx);
      playGameSound('invalid');
      return;
    }

    // --- 클라 예측: 즉시 제거하고 서버 응답을 기다린다 ---
    // canPick이 통과했으니 경로는 반드시 있다(서버 ack의 path와 같은 꼭짓점).
    const path = findPath(resolved, live.cols, live.rows, sel, idx) ?? [];
    st.predictPick(board.id, sel, idx, path, myColor);
    emitSelect(null);
    playGameSound('match', { combo: predictedCombo(st.me()) });
    if (!reduced) navigator.vibrate?.(10);

    try {
      const ack = await emitWithAck<PickAck>('game:pick', { a: sel, b: idx });
      if (ack.ok) return;
      const store = useGameStore.getState();
      const pick = store.takePending(sel, idx);
      if (!pick) return;   // 이미 `game:matched`로 확정된 픽
      if (ack.reason === 'gone' || pick.superseded) {
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
        store.setNotice(REASON_NOTICE[ack.reason] ?? '지울 수 없어요');
      }
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

  /**
   * 보드 컨테이너에서도 좌표로 타일을 찍어 준다(폴백).
   * 타일 버튼이 어떤 이유로든(disabled·pointer-events·오버레이·4px 간격) 클릭을 못 받아도
   * 컨테이너가 같은 `handleTile`을 호출하므로 `?` 엿보기가 막히지 않는다.
   */
  const handleBoardClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest?.('[data-idx]')) return;   // 타일이 이미 처리했다
    const rect = e.currentTarget.getBoundingClientRect();
    const c = box.c0 + Math.floor((e.clientX - rect.left) / step);
    const r = box.r0 + Math.floor((e.clientY - rect.top) / step);
    if (r < box.r0 || r > box.r1 || c < box.c0 || c > box.c1) return;
    const idx = r * board.cols + c;
    if (idx < 0 || idx >= board.cells.length || board.cells[idx] === EMPTY) return;
    void handleTile(idx);
  }, [interactive, box, step, board, handleTile]);

  // 렌더되는 타일 수 = 0이 아닌 셀 수 여야 한다(크롭·필터 버그 감시용). E2E 봇도 이 값을 읽는다.
  const tileCount = board.cells.reduce((n, v) => (v === EMPTY ? n : n + 1), 0);

  return (
    <div
      data-ghc-tiles={tileCount}
      data-ghc-interactive={interactive ? '1' : '0'}
      onClick={handleBoardClick}
      className="relative shrink-0 rounded-xl"
      // perspective는 회전하는 타일의 **부모**에 있어야 호버 틸트가 입체로 보인다.
      style={{
        width, height, perspective: 900,
        boxShadow: comboGlow ? `0 0 24px ${comboGlow}55` : undefined,
      }}
    >
      {board.cells.map((raw, idx) => {
        if (raw === EMPTY) return null;
        // 엿보는 동안에는 그 타일만 진짜 심볼로 보인다(선택이 풀리면 즉시 `?`로 되돌아간다).
        const value = peek && peek.idx === idx && raw === MYSTERY ? peek.symbol : raw;
        const r = Math.floor(idx / board.cols);
        const c = idx % board.cols;
        const flip = peekAnim?.idx === idx ? { key: peekAnim.nonce, delay: 0 } : flips[idx];
        return (
          <ShisenTile
            key={idx}
            idx={idx}
            value={value}
            x={xOf(c)}
            y={yOf(r)}
            size={cellPx}
            selected={interactive && selectedIdx === idx}
            peerColor={peerMarks[idx]}
            hint={interactive && !!hintPair && (hintPair[0] === idx || hintPair[1] === idx)}
            masked={masked.has(idx)}
            isNext={kindOf(value) === 'number' && board.nextNumber > 0
              && value - NUMBER_BASE === board.nextNumber}
            shake={shakeCells.has(idx)}
            flashColor={flashCells[idx]}
            focused={interactive && cursorIdx === idx && selectedIdx !== idx}
            tumble={tumbling}
            tumbleDelay={tumbling ? (idx * 37) % 200 : 0}
            flipKey={flip?.key}
            flipDelay={flip?.delay}
            reduced={reduced}
            boardId={board.id}
            /* 얼어 있어도 클릭은 받는다 — handleTile이 흔들림 피드백을 준다 */
            interactive={interactive}
            onClick={handleTile}
          />
        );
      })}

      {/* 제거 고스트 + 파티클 (+점수 텍스트는 최신 4개까지만) */}
      {fx.filter((f) => f.type === 'pop').slice(-4).map((f) => (
        <PopGhosts key={f.id} fx={f} cols={board.cols} box={box} step={step} size={cellPx} reduced={reduced} />
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
        {fx.filter((f) => f.type === 'path' && (f.path?.length ?? 0) >= 2).map((f) => (
          <PathLine
            key={f.id} fx={f} box={box} step={step} size={cellPx} reduced={reduced} glowId={glowId}
          />
        ))}
      </svg>

      <BoardEffectOverlay board={board} now={now} width={width} height={height} />
    </div>
  );
}

function pointToXY(p: Point, box: BoardBox, step: number, size: number) {
  return { x: (p.c - box.c0) * step + size / 2, y: (p.r - box.r0) * step + size / 2 };
}

/** 경로선: 색 글로우 + 흰 코어 5px + 끝 스파클 3개. */
function PathLine({
  fx, box, step, size, reduced, glowId,
}: { fx: FxEvent; box: BoardBox; step: number; size: number; reduced: boolean; glowId: string }) {
  const consumeFx = useGameStore((s) => s.consumeFx);
  const total = reduced ? 0.2 : 0.42;
  useEffect(() => {
    const t = setTimeout(() => consumeFx(fx.id), total * 1000);
    return () => clearTimeout(t);
  }, [fx.id, consumeFx, total]);
  const pts = (fx.path ?? []).map((p) => pointToXY(p, box, step, size));
  const d = pts.map((p) => `${p.x},${p.y}`).join(' ');
  const color = fx.color ?? '#25F4EE';
  const end = pts[pts.length - 1];
  const common = {
    points: d,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    initial: { pathLength: 0, opacity: 1 },
    animate: { pathLength: 1, opacity: [1, 1, 0] },
    transition: {
      pathLength: { duration: reduced ? 0.05 : 0.12 },
      opacity: { duration: total, times: [0, 0.5, 1] },
    },
  };
  return (
    <>
      <motion.polyline {...common} stroke={color} strokeWidth={9} filter={`url(#${glowId})`} opacity={0.9} />
      <motion.polyline {...common} stroke="#FFFFFF" strokeWidth={5} />
      {!reduced && end && [0, 1, 2].map((i) => (
        <motion.circle
          key={i}
          cx={end.x}
          cy={end.y}
          r={2.5}
          fill="#FFFFFF"
          initial={{ opacity: 0, scale: 0.4, cx: end.x, cy: end.y }}
          animate={{
            opacity: [0, 1, 0],
            cx: end.x + Math.cos((i / 3) * Math.PI * 2) * size * 0.5,
            cy: end.y + Math.sin((i / 3) * Math.PI * 2) * size * 0.5,
          }}
          transition={{ duration: 0.34, delay: 0.1 + i * 0.03 }}
        />
      ))}
    </>
  );
}

/** 제거된 두 타일: 서로를 향해 8px 튕긴 뒤 팝 + 파티클(콤보 4+면 12개). */
function PopGhosts({
  fx, cols, box, step, size, reduced,
}: { fx: FxEvent; cols: number; box: BoardBox; step: number; size: number; reduced: boolean }) {
  const consumeFx = useGameStore((s) => s.consumeFx);
  useEffect(() => {
    const t = setTimeout(() => consumeFx(fx.id), reduced ? 180 : 620);
    return () => clearTimeout(t);
  }, [fx.id, consumeFx, reduced]);

  const sym = fx.symbol && fx.symbol <= 28 ? symbolOf(fx.symbol) : null;
  const color = fx.color ?? '#25F4EE';
  const cells = fx.cells ?? [];
  const combo = fx.combo ?? 0;
  const count = combo >= 8 ? 24 : combo >= 4 ? 12 : 8;

  // "+점수" 플로팅 텍스트는 두 타일의 중점에서 위로 떠오른다.
  const mid = cells.length === 2 ? (() => {
    const p0 = { r: Math.floor(cells[0] / cols), c: cells[0] % cols };
    const p1 = { r: Math.floor(cells[1] / cols), c: cells[1] % cols };
    return {
      x: ((p0.c + p1.c) / 2 - box.c0) * step + size / 2,
      y: ((p0.r + p1.r) / 2 - box.r0) * step + size / 2,
    };
  })() : null;

  return (
    <>
      {mid && !!fx.points && (
        <motion.span
          className="pointer-events-none absolute z-20 font-display text-sm font-black tabular-nums"
          style={{
            left: mid.x, top: mid.y, color: color,
            textShadow: '0 1px 3px rgba(0,0,0,0.8)', transform: 'translate(-50%, -50%)',
          }}
          initial={{ opacity: 0, y: 0, scale: 0.8 }}
          animate={{ opacity: [0, 1, 1, 0], y: reduced ? -12 : -40, scale: 1 }}
          transition={{ duration: reduced ? 0.25 : 0.6, times: [0, 0.15, 0.7, 1] }}
        >
          +{fx.points}
        </motion.span>
      )}
      {cells.map((idx, k) => {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        const other = cells[1 - k] ?? idx;
        const or = Math.floor(other / cols);
        const oc = other % cols;
        const len = Math.hypot(oc - c, or - r) || 1;
        const nudgeX = reduced ? 0 : ((oc - c) / len) * 8;
        const nudgeY = reduced ? 0 : ((or - r) / len) * 8;
        const left = (c - box.c0) * step;
        const top = (r - box.r0) * step;
        const cx = left + size / 2;
        const cy = top + size / 2;
        const Icon = sym?.icon;
        return (
          <div key={idx}>
            <motion.div
              className="absolute flex items-center justify-center rounded-[10px] pointer-events-none"
              style={{
                left,
                top,
                width: size,
                height: size,
                background: `radial-gradient(circle, ${color}55, transparent 70%)`,
              }}
              initial={{ scale: 1, opacity: 1, x: 0, y: 0 }}
              animate={{
                x: [0, nudgeX, nudgeX],
                y: [0, nudgeY, nudgeY],
                scale: [1, 1.12, 0],
                opacity: [1, 1, 0],
              }}
              transition={{ duration: reduced ? 0.12 : 0.24, times: [0, 0.35, 1] }}
            >
              {Icon && <Icon size={Math.round(size * 0.58)} color={sym?.color} />}
            </motion.div>

            {!reduced && Array.from({ length: count }).map((_, i) => {
              const angle = (i / count) * Math.PI * 2;
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
                  transition={{ duration: 0.38, ease: 'easeOut', delay: 0.08 }}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
}
