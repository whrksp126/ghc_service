import { memo, useEffect } from 'react';
import { motion, useAnimationControls } from 'framer-motion';
import { Lock, Key } from 'lucide-react';
import { symbolOf, inkOf } from '../../games/symbols';
import { KEY_SYMBOL, LOCKED, MYSTERY, NUMBER_BASE, WALL } from '../../games/types';

export type TileKind = 'normal' | 'number' | 'lock' | 'key' | 'mystery' | 'wall';

export function kindOf(value: number): TileKind {
  if (value === WALL) return 'wall';
  if (value === LOCKED) return 'lock';
  if (value === MYSTERY) return 'mystery';
  if (value === KEY_SYMBOL) return 'key';
  if (value >= NUMBER_BASE) return 'number';
  return 'normal';
}

/** 포인터(마우스) 기기에서만 호버 틸트·리프트를 쓴다. 터치에서는 손가락에 가려 방해만 된다. */
const canHover = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: hover)').matches;

interface ShisenTileProps {
  idx: number;
  /** 셀 원시값: 1..28 일반, 200+n 숫자, 98 자물쇠, 99 물음표, 100 열쇠, -1 벽 */
  value: number;
  /** 보드 좌상단 기준 픽셀 위치 */
  x: number;
  y: number;
  size: number;
  selected?: boolean;
  peerColor?: string;
  hint?: boolean;
  /** fog 공격으로 가려짐 → `?` */
  masked?: boolean;
  /** 숫자 순서에서 지금 지울 차례 */
  isNext?: boolean;
  /** 잘못된 선택 흔들림 + 붉은 링 */
  shake?: boolean;
  /** 선점당했을 때의 번쩍임 색 */
  flashColor?: string;
  /** 키보드 커서 (선택과 구분되는 흰 1px) */
  focused?: boolean;
  tumble?: boolean;
  tumbleDelay?: number;
  /** 값이 바뀔 때(공개·잠금해제) 뒤집기 — 바뀔 때마다 새 값을 주면 다시 돈다 */
  flipKey?: number;
  flipDelay?: number;
  reduced?: boolean;
  interactive?: boolean;
  onClick?: (idx: number) => void;
}

const FACE: Record<TileKind, string> = {
  normal: 'linear-gradient(160deg, #F7F2E8 0%, #F0E9DB 45%, #E3DACA 100%)',
  number: 'linear-gradient(160deg, #989EA8 0%, #868C96 45%, #6B7079 100%)',
  lock: 'linear-gradient(160deg, #464C55 0%, #343A42 50%, #23272D 100%)',
  key: 'linear-gradient(160deg, #D8FBE3 0%, #A7F3C4 45%, #6FE0A0 100%)',
  mystery: 'linear-gradient(160deg, #E4B45A 0%, #D09B33 45%, #A87520 100%)',
  wall: 'linear-gradient(160deg, #6B462B 0%, #543521 50%, #38230F 100%)',
};

/**
 * 타일 1개 (v2: 상아색 마작 타일). 좌표는 부모(ShisenBoard)가 계산한 픽셀로 절대 배치한다.
 * 바깥 버튼 = 위치/스케일/흔들림, 안쪽 면 = 뒤집기(rotateY) 로 역할을 나눠서
 * framer transform이 서로 덮어쓰지 않게 한다.
 */
export const ShisenTile = memo(function ShisenTile({
  idx, value, x, y, size, selected, peerColor, hint, masked, isNext, shake, flashColor,
  focused, tumble, tumbleDelay = 0, flipKey, flipDelay = 0, reduced, interactive, onClick,
}: ShisenTileProps) {
  const kind = kindOf(value);
  const flip = useAnimationControls();
  const iconSize = Math.max(10, Math.round(size * 0.58));
  const solid = kind === 'wall';

  useEffect(() => {
    if (!flipKey) return;
    void flip.start({
      rotateY: reduced ? [0, 0] : [0, 90, 0],
      transition: { duration: reduced ? 0 : 0.15, delay: flipDelay / 1000 },
    });
  }, [flipKey, flipDelay, flip, reduced]);

  const ink = kind === 'normal' ? inkOf(value) : '#FFFFFF';
  const sym = kind === 'normal' ? symbolOf(value) : null;
  const Icon = sym?.icon;
  const number = kind === 'number' ? value - NUMBER_BASE : 0;

  return (
    <motion.button
      data-idx={idx}
      data-sym={value}
      type="button"
      disabled={!interactive}
      onClick={() => onClick?.(idx)}
      whileTap={interactive && !reduced ? { scale: 0.93 } : undefined}
      whileHover={interactive && canHover && !reduced && !solid ? { y: -2, rotateX: -3, rotateY: 3 } : undefined}
      animate={{
        x: shake && !reduced ? [0, -4, 4, -3, 3, 0] : 0,
        y: selected && !reduced ? -4 : 0,
        scale: tumble ? [1, 0.7, 1] : selected ? 1.04 : 1,
        rotate: tumble && !reduced ? [0, idx % 2 ? 15 : -15, 0] : 0,
      }}
      transition={{
        duration: reduced ? 0.1 : 0.2,
        y: { type: 'spring', stiffness: 520, damping: 20 },
        scale: tumble
          ? { duration: 0.25, delay: tumbleDelay / 1000 }
          : { type: 'spring', stiffness: 520, damping: 20 },
        rotate: { duration: 0.25, delay: tumbleDelay / 1000 },
      }}
      className={`absolute rounded-[10px]
        ${interactive ? 'cursor-pointer' : 'pointer-events-none cursor-default'}
        ${selected || focused ? 'z-10' : ''}`}
      style={{
        left: x,
        top: y,
        width: size,
        height: size,
        // 마작 타일의 두께감: 아래쪽 단단한 그림자 + 바닥 소프트 섀도(벽은 낮게)
        filter: solid
          ? 'drop-shadow(0 1px 1px rgba(0,0,0,0.5))'
          : 'drop-shadow(0 2px 0 rgba(0,0,0,0.38)) drop-shadow(0 4px 7px rgba(0,0,0,0.42))',
      }}
    >
      <motion.span
        animate={flip}
        className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[10px]"
        style={{
          background: FACE[kind],
          // 베벨: 우하단 어두운 2px + 좌상단 하이라이트
          boxShadow: [
            'inset -2px -2px 0 rgba(0,0,0,0.22)',
            'inset 2px 2px 0 rgba(255,255,255,0.55)',
            selected ? '0 0 0 3px #86EFAC, 0 0 18px rgba(134,239,172,0.85)' : '',
            !selected && peerColor ? `0 0 0 2px ${peerColor}` : '',
            !selected && focused ? '0 0 0 1px #FFFFFF' : '',
            hint ? '0 0 0 3px #FBBF24, 0 0 14px rgba(251,191,36,0.8)' : '',
            isNext && !selected ? '0 0 0 2px rgba(250,204,21,0.9)' : '',
            shake ? '0 0 0 3px #EF4444' : '',
            flashColor ? `0 0 0 3px ${flashColor}` : '',
          ].filter(Boolean).join(', '),
        }}
      >
        {masked ? (
          <span className="font-display font-black text-dark-800" style={{ fontSize: iconSize }}>?</span>
        ) : kind === 'normal' && Icon ? (
          <Icon size={iconSize} color={ink} strokeWidth={2.2} absoluteStrokeWidth />
        ) : kind === 'number' ? (
          <span
            className={`font-display font-black text-white ${isNext ? 'animate-pulse' : ''}`}
            style={{ fontSize: Math.round(size * 0.62), textShadow: '0 2px 2px rgba(0,0,0,0.45)' }}
          >
            {number}
          </span>
        ) : kind === 'lock' ? (
          <Lock size={iconSize} color="#C7CDD6" strokeWidth={2.2} />
        ) : kind === 'key' ? (
          <Key size={iconSize} color="#166534" strokeWidth={2.4} />
        ) : kind === 'mystery' ? (
          <span
            className="font-display font-black text-[#4A3208]"
            style={{ fontSize: Math.round(size * 0.62) }}
          >
            ?
          </span>
        ) : (
          /* 벽: 나무 상자 X 무늬 */
          <svg width="100%" height="100%" viewBox="0 0 10 10" preserveAspectRatio="none">
            <path d="M0 0 L10 10 M10 0 L0 10" stroke="rgba(0,0,0,0.45)" strokeWidth="1" />
            <rect x="0.4" y="0.4" width="9.2" height="9.2" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="0.6" />
          </svg>
        )}

        {/* 아이콘 색 글로우(일반 타일만) */}
        {kind === 'normal' && sym && (
          <span
            className="pointer-events-none absolute inset-0"
            style={{ background: `radial-gradient(circle at 50% 50%, ${sym.color}1F, transparent 72%)` }}
          />
        )}
        {flashColor && <span className="absolute inset-0 opacity-40" style={{ background: flashColor }} />}
        {shake && <span className="absolute inset-0 bg-danger/25" />}
      </motion.span>
    </motion.button>
  );
});
