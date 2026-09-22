import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { playGameSound } from '../../games/sounds';

interface CountdownProps {
  /** 서버가 준 시작 시각(ms epoch). 로컬 시계로 3-2-1-GO를 그린다. */
  startAt: number;
  modeText: string;
}

/** 카운트다운 오버레이 — 숫자마다 `tick`, 시작 순간 `go`. */
export function Countdown({ startAt, modeText }: CountdownProps) {
  const [now, setNow] = useState(() => Date.now());
  const lastLabel = useRef<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(t);
  }, []);

  const leftMs = startAt - now;
  const label = leftMs > 0 ? String(Math.ceil(leftMs / 1000)) : 'GO!';

  useEffect(() => {
    if (leftMs < -800) return;
    if (lastLabel.current === label) return;
    lastLabel.current = label;
    playGameSound(label === 'GO!' ? 'go' : 'tick');
  }, [label, leftMs]);

  if (leftMs < -800) return null;

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-dark-900/70 backdrop-blur-sm">
      <AnimatePresence mode="popLayout">
        <motion.div
          key={label}
          initial={{ scale: 1.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.8, opacity: 0 }}
          transition={{ duration: 0.25 }}
          className={`font-display font-black tabular-nums ${label === 'GO!' ? 'text-secondary' : 'text-white'}`}
          style={{ fontSize: 88, lineHeight: 1 }}
        >
          {label}
        </motion.div>
      </AnimatePresence>
      <p className="text-sm text-white/60">{modeText}</p>
    </div>
  );
}
