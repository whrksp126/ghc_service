import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Lightbulb, WifiOff, Crown } from 'lucide-react';
import type { Board, PlayerState } from '../../games/types';
import { isForfeited } from '../../games/events';
import { itemsOf } from '../../games/v3';
import { ATTACK_ICON } from './AttackFx';
import { prefersReducedMotion } from '../../games/motion';

interface PlayerHeaderProps {
  player: PlayerState;
  board?: Board;
  /** 미니보드용 축소 표시 */
  compact?: boolean;
  isMe?: boolean;
  isHost?: boolean;
  /** 아이템 모드에서 공격 게이지 표시 (내 헤더에만) */
  showMeter?: boolean;
}

/** 콤보 티어 색: 2~3 secondary / 4~5 primary / 6+ 그라디언트 (§6.3) */
function comboClass(combo: number): string {
  if (combo >= 6) return 'bg-gradient-to-r from-primary to-secondary text-dark-900';
  if (combo >= 4) return 'bg-primary text-white';
  return 'bg-secondary text-dark-900';
}

/**
 * 자기 보드 바로 위에 붙는 작은 카드. 부모(FittedBoard)가 보드 폭과 똑같은 너비를 준다 —
 * 예전처럼 통계가 패널 가운데/오른쪽 끝에 붕 떠 있지 않도록.
 */
export function PlayerHeader({ player, board, compact, isMe, isHost, showMeter }: PlayerHeaderProps) {
  const remaining = board?.remaining ?? 0;
  const danger = remaining > 0 && remaining <= 8;
  const meter = Math.min(3, Math.floor(player.combo / 3));
  const AttackIcon = ATTACK_ICON.freeze;
  const reduced = prefersReducedMotion();

  // 콤보가 끊기면 배지가 툭 떨어진다(v2.1).
  const [dropped, setDropped] = useState<number | null>(null);
  const prevCombo = useRef(player.combo);
  useEffect(() => {
    const was = prevCombo.current;
    prevCombo.current = player.combo;
    if (was <= 1 || player.combo > 1 || reduced) return;
    setDropped(was);
    const t = setTimeout(() => setDropped(null), 450);
    return () => clearTimeout(t);
  }, [player.combo, reduced]);

  return (
    <div
      className={`flex w-full items-center gap-1.5 rounded-lg bg-white/5 px-2 py-1 ${
        compact ? 'text-[11px]' : 'text-xs'
      } ${isForfeited(player) ? 'opacity-50' : ''}`}
      style={{ boxShadow: `inset 0 0 0 1px ${player.color}33` }}
    >
      <span
        className="shrink-0 rounded-full"
        style={{
          width: compact ? 7 : 9,
          height: compact ? 7 : 9,
          background: player.color,
          boxShadow: `0 0 8px ${player.color}`,
        }}
      />
      <span className="min-w-0 truncate font-medium text-white/90">{player.nickname}</span>
      {isMe && <span className="shrink-0 text-white/35">나</span>}
      {isHost && <Crown size={compact ? 10 : 12} className="shrink-0 text-warning" />}
      {!player.connected && <WifiOff size={compact ? 10 : 12} className="shrink-0 text-danger" />}
      {isForfeited(player) ? (
        <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-px text-[10px] text-white/50">기권</span>
      ) : player.finishedAt !== null ? (
        <span className="shrink-0 rounded-full bg-success/20 px-1.5 py-px text-[10px] text-success">완주 ✓</span>
      ) : null}

      <span className="ml-auto flex shrink-0 items-center gap-1.5 font-display tabular-nums">
        {player.combo > 1 ? (
          <motion.span
            key={player.combo}
            initial={reduced ? false : { scale: 0.6 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 600, damping: 12 }}
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${comboClass(player.combo)}`}
          >
            x{player.combo}
          </motion.span>
        ) : dropped ? (
          <motion.span
            key={`drop-${dropped}`}
            initial={{ y: 0, opacity: 1, rotate: 0 }}
            animate={{ y: 18, opacity: 0, rotate: -22 }}
            transition={{ duration: 0.45, ease: 'easeIn' }}
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${comboClass(dropped)}`}
          >
            x{dropped}
          </motion.span>
        ) : null}
        {showMeter && isMe && (
          <span className="flex items-center gap-0.5" title="공격 게이지">
            <AttackIcon size={compact ? 9 : 11} className="text-secondary" />
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`rounded-full ${i < meter ? 'bg-secondary' : 'bg-white/15'}`}
                style={{ width: 4, height: 4 }}
              />
            ))}
          </span>
        )}
        {isMe && !compact && (
          <span className="flex items-center gap-0.5 text-white/45" title="남은 힌트">
            <Lightbulb size={11} />{itemsOf(player).hint}
          </span>
        )}
        <span className="text-white/55">{player.score}</span>
        <motion.span
          animate={danger && !reduced ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
          transition={{ duration: 0.8, repeat: danger && !reduced ? Infinity : 0 }}
          className={danger ? 'font-bold text-primary' : 'text-white/80'}
        >
          {remaining}
        </motion.span>
      </span>
    </div>
  );
}
