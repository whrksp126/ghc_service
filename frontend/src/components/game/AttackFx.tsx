import { useEffect, useRef, useState, type RefObject } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Snowflake, CloudFog, Shuffle } from 'lucide-react';
import { useGameStore } from '../../stores/gameStore';
import { playGameSound } from '../../games/sounds';
import { prefersReducedMotion } from '../../games/motion';
import type { AttackType, Board } from '../../games/types';

export const ATTACK_ICON: Record<AttackType, typeof Snowflake> = {
  freeze: Snowflake,
  fog: CloudFog,
  shuffle: Shuffle,
};

export const ATTACK_LABEL: Record<AttackType, string> = {
  freeze: '얼리기',
  fog: '안개',
  shuffle: '뒤섞기',
};

const FLIGHT_MS = 450;

interface BoardEffectOverlayProps {
  board: Board;
  now: number;
  width: number;
  height: number;
}

/** 서리 균열 — 보드 크기에 맞춰 대충 흩뿌린 정적 선(연출용, 난수 없음). */
function crackPath(width: number, height: number): string {
  const w = width; const h = height;
  return [
    `M0 ${h * 0.3} L${w * 0.25} ${h * 0.42} L${w * 0.2} ${h * 0.7} L${w * 0.45} ${h}`,
    `M${w * 0.25} ${h * 0.42} L${w * 0.6} ${h * 0.25} L${w} ${h * 0.35}`,
    `M${w * 0.6} ${h * 0.25} L${w * 0.72} ${h * 0.6} L${w} ${h * 0.8}`,
  ].join(' ');
}

/** 판 위에 걸린 효과 오버레이 — freeze 서리(+남은 시간 원형 프로그레스), fog 뿌연 막. */
export function BoardEffectOverlay({ board, now, width, height }: BoardEffectOverlayProps) {
  const freeze = board.effects.find((e) => e.type === 'freeze' && e.until > now);
  const fog = board.effects.find((e) => e.type === 'fog' && e.until > now);
  if (!freeze && !fog) return null;

  const until = freeze?.until ?? fog?.until ?? now;
  const leftMs = Math.max(0, until - now);
  const totalMs = freeze ? 3000 : 4000;
  const ratio = Math.max(0, Math.min(1, leftMs / totalMs));
  const R = 13;
  const C = 2 * Math.PI * R;

  return (
    <div
      className="absolute left-0 top-0 pointer-events-none overflow-hidden rounded-xl"
      style={{ width, height }}
    >
      {freeze && (
        <>
          <div className="absolute inset-0 bg-sky-300/20" style={{ boxShadow: 'inset 0 0 0 2px rgba(186,230,253,0.5)' }} />
          <svg className="absolute inset-0" width={width} height={height}>
            <path d={crackPath(width, height)} fill="none" stroke="rgba(224,247,255,0.55)" strokeWidth={1.5} />
          </svg>
        </>
      )}
      {fog && <div className="absolute inset-0 bg-white/10 backdrop-blur-[2px]" />}

      {/* 남은 시간 원형 프로그레스 */}
      <div className="absolute left-1 top-1 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5">
        <svg width={32} height={32} viewBox="0 0 32 32" className="-rotate-90">
          <circle cx="16" cy="16" r={R} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
          <circle
            cx="16" cy="16" r={R} fill="none"
            stroke={freeze ? '#BAE6FD' : '#E9D5FF'}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - ratio)}
          />
        </svg>
        <span className="font-display text-[10px] tabular-nums text-white/80">
          {(leftMs / 1000).toFixed(1)}s
        </span>
      </div>
    </div>
  );
}

interface Flight {
  id: number;
  type: AttackType;
  from: { x: number; y: number };
  to: { x: number; y: number };
  mine: boolean;
}

/**
 * 공격 투사체 레이어(아레나 전역). 발사자 헤더(`data-ghc-player`) →
 * 대상 보드(`data-ghc-board`) 중심으로 450ms 곡선 비행 + 도착 링 파동.
 * 좌표는 실제 DOM 위치를 측정해서 쓴다(하드코딩/타이머 페이크 없음).
 */
export function AttackFxLayer({
  myBoardId, arenaRef,
}: { myBoardId?: string; arenaRef: RefObject<HTMLElement> }) {
  const fxQueue = useGameStore((s) => s.fxQueue);
  const consumeFx = useGameStore((s) => s.consumeFx);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [hit, setHit] = useState(false);
  const reduced = prefersReducedMotion();
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const attacks = fxQueue.filter((f) => f.type === 'attack' && f.attack);

  useEffect(() => {
    if (attacks.length === 0) return;
    const root = arenaRef.current;
    const rootRect = root?.getBoundingClientRect();
    const added: Flight[] = [];

    for (const f of attacks) {
      const a = f.attack!;
      const mine = !!myBoardId && a.boardId === myBoardId;
      let from = { x: (rootRect?.width ?? 0) / 2, y: 0 };
      let to = { x: (rootRect?.width ?? 0) / 2, y: (rootRect?.height ?? 0) / 2 };
      if (root && rootRect) {
        const fromEl = root.querySelector(`[data-ghc-player="${a.from}"]`);
        const toEl = root.querySelector(`[data-ghc-board="${a.boardId}"]`);
        if (fromEl) {
          const r = fromEl.getBoundingClientRect();
          from = { x: r.left - rootRect.left + r.width / 2, y: r.top - rootRect.top + r.height / 2 };
        }
        if (toEl) {
          const r = toEl.getBoundingClientRect();
          to = { x: r.left - rootRect.left + r.width / 2, y: r.top - rootRect.top + r.height / 2 };
        }
      }
      added.push({ id: f.id, type: a.type, from, to, mine });
      consumeFx(f.id);
    }

    if (added.length > 0) {
      setFlights((prev) => [...prev, ...added]);
      playGameSound('attackSend');
      const landing = setTimeout(() => {
        playGameSound('attackHit');
        if (added.some((f) => f.mine)) {
          setHit(true);
          timers.current.push(setTimeout(() => setHit(false), 220));
        }
      }, reduced ? 0 : FLIGHT_MS);
      const cleanup = setTimeout(() => {
        const ids = new Set(added.map((f) => f.id));
        setFlights((prev) => prev.filter((f) => !ids.has(f.id)));
      }, (reduced ? 0 : FLIGHT_MS) + 400);
      timers.current.push(landing, cleanup);
    }
  }, [attacks, myBoardId, consumeFx, arenaRef, reduced]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  return (
    <>
      <AnimatePresence>
        {hit && (
          <motion.div
            key="hit"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-40 pointer-events-none"
            style={{ boxShadow: 'inset 0 0 80px 20px rgba(254,44,85,0.45)' }}
          />
        )}
      </AnimatePresence>

      {flights.map((f) => {
        const Icon = ATTACK_ICON[f.type];
        const midX = (f.from.x + f.to.x) / 2;
        const midY = Math.min(f.from.y, f.to.y) - 60;   // 위로 솟는 곡선
        return (
          <div key={f.id} className="absolute inset-0 z-40 pointer-events-none">
            {!reduced && (
              <motion.div
                className="absolute flex h-8 w-8 items-center justify-center rounded-full bg-dark-900/80"
                style={{ left: -16, top: -16, boxShadow: '0 0 16px rgba(37,244,238,0.8)' }}
                initial={{ x: f.from.x, y: f.from.y, scale: 0.6, opacity: 0 }}
                animate={{
                  x: [f.from.x, midX, f.to.x],
                  y: [f.from.y, midY, f.to.y],
                  scale: [0.6, 1.1, 0.9],
                  opacity: [0, 1, 1],
                  rotate: [0, 180, 360],
                }}
                transition={{ duration: FLIGHT_MS / 1000, ease: 'easeInOut' }}
              >
                <Icon size={18} className="text-secondary" />
              </motion.div>
            )}
            {/* 도착 링 파동 */}
            <motion.span
              className="absolute rounded-full border-2 border-secondary"
              style={{ left: f.to.x - 20, top: f.to.y - 20, width: 40, height: 40 }}
              initial={{ scale: 0.2, opacity: 0 }}
              animate={{ scale: [0.2, 3], opacity: [0.9, 0] }}
              transition={{ duration: 0.35, delay: reduced ? 0 : FLIGHT_MS / 1000 }}
            />
          </div>
        );
      })}
    </>
  );
}
