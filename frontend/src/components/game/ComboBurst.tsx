import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Heart, Star } from 'lucide-react';
import { useGameStore } from '../../stores/gameStore';
import { prefersReducedMotion } from '../../games/motion';

/** 콤보 티어 — 크기/색/콜아웃이 여기서 갈린다. */
function tierOf(combo: number): 0 | 1 | 2 | 3 {
  if (combo >= 10) return 3;
  if (combo >= 7) return 2;
  if (combo >= 4) return 1;
  return 0;
}

const TIER_SIZE = [40, 56, 72, 88];
const TIER_FILL = [
  'linear-gradient(180deg,#7DD3FC 0%,#25F4EE 55%,#0EA5E9 100%)',
  'linear-gradient(180deg,#FDE68A 0%,#FACC15 55%,#F59E0B 100%)',
  'linear-gradient(180deg,#FDA4AF 0%,#FE2C55 55%,#BE123C 100%)',
  'linear-gradient(90deg,#FE2C55 0%,#FACC15 35%,#4ADE80 65%,#25F4EE 100%)',
];
const PARTICLE_COLORS = ['#FE2C55', '#25F4EE', '#FACC15', '#A78BFA', '#4ADE80', '#FB923C'];

function calloutFor(combo: number): string {
  if (combo >= 10) return '완벽!!';
  if (combo >= 6) return '대단해요!';
  if (combo >= 3) return '콤보!';
  return '매치!';
}

interface Burst { id: number; combo: number; tier: 0 | 1 | 2 | 3; tierUp: boolean }

/**
 * 리듬게임식 콤보 연출 (v3 §W3).
 * 3중 레이어 텍스트(그라디언트 채움 + 흰 스트로크 + 진한 그림자) + 별·하트·다각형 파티클 +
 * 보조 콜아웃 + 티어 상승 시 빛 줄기. 전부 실제 `fxQueue`의 pop 이벤트에서만 트리거된다.
 */
export function ComboBurst({ boardId, myUserId }: { boardId?: string; myUserId: string | null }) {
  const fxQueue = useGameStore((s) => s.fxQueue);
  const myCombo = useGameStore((s) => s.snapshot?.players.find((p) => p.userId === myUserId)?.combo ?? 0);
  const [burst, setBurst] = useState<Burst | null>(null);
  const [broken, setBroken] = useState<number | null>(null);
  const lastId = useRef(0);
  const lastTier = useRef(0);
  const prevCombo = useRef(0);
  /** 화면에 떠 있는 콤보는 **항상 1개**. 새 콤보가 오면 이전 타이머를 즉시 정리하고 교체한다. */
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const breakTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = prefersReducedMotion();

  // 언마운트 시 타이머 정리(남아서 상태를 되살리는 일이 없도록).
  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (breakTimer.current) clearTimeout(breakTimer.current);
  }, []);

  // 콤보 성립 — pop 연출 이벤트에서만.
  useEffect(() => {
    if (!boardId) return;
    const hot = fxQueue.find(
      (f) => f.type === 'pop' && f.boardId === boardId && f.fromUserId === myUserId && f.id > lastId.current,
    );
    if (!hot) return;
    lastId.current = hot.id;
    const combo = hot.combo ?? 1;
    const tier = tierOf(combo);
    const tierUp = tier > lastTier.current;
    lastTier.current = tier;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setBurst({ id: hot.id, combo, tier, tierUp });
    // 총 수명 700ms(등장 180 → 유지 220 → 퇴장 300) — 절대 쌓이지 않는다.
    hideTimer.current = setTimeout(() => setBurst(null), reduced ? 300 : 400);
  }, [fxQueue, boardId, myUserId, reduced]);

  // 콤보가 끊기면 텍스트가 흔들리며 떨어진다(역시 1개만, 타이머 정리 포함).
  useEffect(() => {
    const was = prevCombo.current;
    prevCombo.current = myCombo;
    if (myCombo > 1 || was <= 1) {
      if (myCombo <= 1) lastTier.current = 0;
      return;
    }
    lastTier.current = 0;
    if (reduced) return;
    if (breakTimer.current) clearTimeout(breakTimer.current);
    setBroken(was);
    breakTimer.current = setTimeout(() => setBroken(null), 600);
  }, [myCombo, reduced]);

  const combo = burst?.combo ?? 0;
  const tier = burst?.tier ?? 0;
  const size = TIER_SIZE[tier];
  const particles = reduced ? 0 : 12 + tier * 4;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {/* 티어 상승 빛 줄기 */}
      <AnimatePresence>
        {burst?.tierUp && !reduced && (
          <motion.div
            key={`ray-${burst.id}`}
            className="absolute inset-y-0 w-1/3 -skew-x-12"
            style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.22),transparent)' }}
            initial={{ x: '-40%', opacity: 0 }}
            animate={{ x: '160%', opacity: [0, 1, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: 'easeOut' }}
          />
        )}
      </AnimatePresence>

      <div className="absolute left-1/2 top-[14%] -translate-x-1/2 text-center">
        <AnimatePresence>
          {burst && combo >= 2 && (
            <motion.div
              key={burst.id}
              className="relative"
              initial={reduced ? { opacity: 0 } : { scale: 0.6, opacity: 0, rotate: -8 }}
              animate={reduced
                ? { opacity: 1 }
                : { scale: [0.6, 1.15, 1], opacity: 1, rotate: -6 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.3 } }}
              transition={{ duration: reduced ? 0.12 : 0.18, times: reduced ? undefined : [0, 0.55, 1] }}
            >
              {/* 1) 진한 그림자 2) 두꺼운 흰 스트로크 3) 그라디언트 채움 */}
              <span
                className="absolute inset-0 font-display font-black italic"
                style={{ fontSize: size, color: 'rgba(0,0,0,0.65)', transform: 'translate(3px, 4px)' }}
              >
                {combo} COMBO
              </span>
              <span
                className="absolute inset-0 font-display font-black italic text-white"
                style={{ fontSize: size, WebkitTextStroke: `${Math.round(size / 9)}px #FFFFFF` }}
              >
                {combo} COMBO
              </span>
              <span
                className="relative font-display font-black italic text-transparent"
                style={{
                  fontSize: size,
                  backgroundImage: TIER_FILL[tier],
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  filter: reduced ? undefined : 'drop-shadow(0 0 14px rgba(255,255,255,0.55))',
                }}
              >
                {combo} COMBO
              </span>

              {/* 글로우 펄스 */}
              {!reduced && (
                <motion.span
                  className="absolute inset-0 -z-10 rounded-full"
                  style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.35), transparent 70%)' }}
                  initial={{ scale: 0.6, opacity: 0.8 }}
                  animate={{ scale: 1.8, opacity: 0 }}
                  transition={{ duration: 0.6 }}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* 보조 콜아웃 — 다른 각도로 튀어나온다 */}
        <AnimatePresence>
          {burst && (
            <motion.span
              key={`call-${burst.id}`}
              className="mt-1 block font-display text-lg font-black text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.85)]"
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: 10, y: 6 }}
              animate={{ opacity: 1, scale: 1, rotate: combo % 2 ? 7 : -7, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ type: 'spring', stiffness: 520, damping: 14 }}
            >
              {calloutFor(burst.combo)}
            </motion.span>
          )}
        </AnimatePresence>

        {/* 파티클(별·하트·다각형) */}
        {burst && particles > 0 && (
          <div className="absolute left-1/2 top-1/2">
            {Array.from({ length: particles }).map((_, i) => {
              const angle = (i / particles) * Math.PI * 2;
              const dist = 70 + (i % 3) * 26;
              const color = PARTICLE_COLORS[(i + burst.id) % PARTICLE_COLORS.length];
              const shape = i % 3;
              return (
                <motion.span
                  key={`${burst.id}-${i}`}
                  className="absolute"
                  initial={{ x: 0, y: 0, opacity: 1, scale: 0.6, rotate: 0 }}
                  animate={{
                    x: Math.cos(angle) * dist,
                    y: Math.sin(angle) * dist,
                    opacity: 0,
                    scale: 1.1,
                    rotate: 180,
                  }}
                  transition={{ duration: 0.75, ease: 'easeOut' }}
                >
                  {shape === 0 ? (
                    <Star size={12} color={color} fill={color} />
                  ) : shape === 1 ? (
                    <Heart size={11} color={color} fill={color} />
                  ) : (
                    <span
                      className="block"
                      style={{
                        width: 9, height: 9, background: color,
                        clipPath: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)',
                      }}
                    />
                  )}
                </motion.span>
              );
            })}
          </div>
        )}

        {/* 콤보 끊김 — 흔들리며 떨어짐 */}
        <AnimatePresence>
          {broken !== null && (
            <motion.span
              key={`broken-${broken}`}
              className="absolute left-1/2 top-0 block -translate-x-1/2 font-display text-2xl font-black italic text-white/50"
              initial={{ y: 0, opacity: 1, rotate: 0 }}
              animate={{ y: 60, opacity: 0, rotate: 24, x: [0, -6, 6, -4, 0] }}
              transition={{ duration: 0.6 }}
            >
              {broken} COMBO
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
