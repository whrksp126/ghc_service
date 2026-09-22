import { memo } from 'react';
import { motion } from 'framer-motion';
import { symbolOf } from '../../games/symbols';

interface ShisenTileProps {
  idx: number;
  /** 심볼 id (1..28) */
  symbol: number;
  /** 보드 좌상단 기준 픽셀 위치 */
  x: number;
  y: number;
  size: number;
  selected?: boolean;
  /** 내 선택 테두리 색(= 내 플레이어 색) */
  selectColor?: string;
  /** 상대 선택 점선 테두리 색 */
  peerColor?: string;
  /** 힌트 점멸 */
  hint?: boolean;
  /** fog 공격으로 가려짐 → `?` (뒤집힘 애니) */
  masked?: boolean;
  /** 잘못된 선택 흔들림 + 붉은 플래시 */
  shake?: boolean;
  /** 협동에서 남에게 선점당했을 때의 번쩍임 색 */
  flashColor?: string;
  /** 키보드 커서 (선택 스타일과 구분되는 흰 1px) */
  focused?: boolean;
  /** 셔플 텀블 연출 중 */
  tumble?: boolean;
  /** 텀블 시작 지연(ms) — 타일마다 0~200ms 흩어진다 */
  tumbleDelay?: number;
  reduced?: boolean;
  interactive?: boolean;
  onClick?: (idx: number) => void;
}

/**
 * 타일 1개. 좌표는 부모(ShisenBoard)가 계산한 픽셀로 절대 배치한다 —
 * 경로 SVG 오버레이와 좌표계를 정확히 맞추기 위해서.
 * inline style은 계산된 픽셀/색만 쓰고, `border` 단축 속성은 쓰지 않는다
 * (단축+개별 속성을 섞으면 React가 "Updating border/borderStyle" 경고를 낸다).
 */
export const ShisenTile = memo(function ShisenTile({
  idx, symbol, x, y, size, selected, selectColor = '#FE2C55', peerColor,
  hint, masked, shake, flashColor, focused, tumble, tumbleDelay = 0, reduced,
  interactive, onClick,
}: ShisenTileProps) {
  const sym = symbolOf(symbol);
  const Icon = sym.icon;
  const iconSize = Math.max(10, Math.round(size * 0.55));
  const borderColor = selected ? selectColor
    : focused ? '#FFFFFF'
      : peerColor ?? 'rgba(255,255,255,0.06)';

  return (
    <motion.button
      type="button"
      data-idx={idx}
      data-sym={symbol}
      disabled={!interactive}
      onClick={() => onClick?.(idx)}
      whileHover={interactive && !reduced ? { y: -2 } : undefined}
      // 흔들림/스케일/뒤집기는 framer가 inline transform을 잡으므로 Tailwind scale 대신 여기서 준다.
      animate={{
        x: shake && !reduced ? [0, -4, 4, -3, 3, 0] : 0,
        scale: tumble ? [1, 0.7, 1] : selected ? 1.06 : 1,
        rotate: tumble && !reduced ? [0, idx % 2 ? 15 : -15, 0] : 0,
        rotateY: masked ? 180 : 0,
      }}
      transition={{
        duration: reduced ? 0.1 : 0.2,
        rotateY: { duration: reduced ? 0 : 0.15 },
        scale: tumble
          ? { duration: 0.25, delay: tumbleDelay / 1000 }
          : { type: 'spring', stiffness: 500, damping: 22 },
        rotate: { duration: 0.25, delay: tumbleDelay / 1000 },
      }}
      className={`absolute rounded-[10px] flex items-center justify-center overflow-hidden
        bg-gradient-to-br from-dark-700 to-dark-600 outline-none
        ${interactive ? 'cursor-pointer' : 'pointer-events-none cursor-default'}
        ${selected || focused ? 'z-10' : ''}
        ${hint ? 'animate-pulse' : ''}`}
      style={{
        left: x,
        top: y,
        width: size,
        height: size,
        borderWidth: selected || peerColor ? 2 : 1,
        borderStyle: !selected && peerColor ? 'dashed' : 'solid',
        borderColor,
        boxShadow: selected
          ? `0 0 12px ${selectColor}, inset 0 1px 0 rgba(255,255,255,0.12)`
          : hint
            ? '0 0 10px #FBBF24, inset 0 1px 0 rgba(255,255,255,0.1)'
            : flashColor
              ? `0 0 14px ${flashColor}, inset 0 1px 0 rgba(255,255,255,0.1)`
              : 'inset 0 1px 0 rgba(255,255,255,0.08)',
      }}
    >
      {/* 아이콘 색 radial glow */}
      <span
        className="absolute inset-0 pointer-events-none"
        style={{ background: `radial-gradient(circle at 50% 50%, ${sym.color}26, transparent 70%)` }}
      />
      {masked ? (
        <span
          className="relative font-display font-bold text-white/70"
          style={{ fontSize: iconSize, transform: 'rotateY(180deg)' }}
        >
          ?
        </span>
      ) : (
        <motion.span
          className="relative"
          animate={selected && !reduced ? { scale: [1, 1.12, 1] } : { scale: 1 }}
          transition={{ duration: 0.6, repeat: selected && !reduced ? Infinity : 0 }}
        >
          <Icon size={iconSize} color={sym.color} strokeWidth={2} />
        </motion.span>
      )}
      {hint && <span className="absolute inset-0 bg-warning/20" />}
      {shake && <span className="absolute inset-0 bg-danger/30" />}
      {flashColor && (
        <span className="absolute inset-0 opacity-60" style={{ background: flashColor }} />
      )}
    </motion.button>
  );
});
