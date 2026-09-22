import type { LucideIcon } from 'lucide-react';
import {
  Heart, Zap, Star, Moon, Sun, Cloud, Flame, Droplet, Leaf, Music,
  Ghost, Rocket, Diamond, Crown, Anchor, Bug, Cherry, Bell, Umbrella, Fish,
  Pizza, Gamepad2, Cat, Snowflake, Flower2, Orbit, Key, Skull,
} from 'lucide-react';

export interface GameSymbol { icon: LucideIcon; color: string; }

/**
 * 심볼 28개 (설계서 §6.3). 인덱스 0은 빈칸이므로 심볼 id `1..28` → `SYMBOLS[id - 1]`.
 * 판 크기 `l`(14×8)이 28심볼을 모두 쓰고, `s`/`m`은 앞에서부터 잘라 쓴다.
 * 아이콘 이름은 lucide-react 1.16 실제 export를 확인한 것.
 */
export const SYMBOLS: GameSymbol[] = [
  { icon: Heart, color: '#FE2C55' },
  { icon: Zap, color: '#FACC15' },
  { icon: Star, color: '#FDE68A' },
  { icon: Moon, color: '#A78BFA' },
  { icon: Sun, color: '#FB923C' },
  { icon: Cloud, color: '#93C5FD' },
  { icon: Flame, color: '#F97316' },
  { icon: Droplet, color: '#38BDF8' },
  { icon: Leaf, color: '#4ADE80' },
  { icon: Music, color: '#F472B6' },
  { icon: Ghost, color: '#E9D5FF' },
  { icon: Rocket, color: '#25F4EE' },
  { icon: Diamond, color: '#67E8F9' },
  { icon: Crown, color: '#FBBF24' },
  { icon: Anchor, color: '#60A5FA' },
  { icon: Bug, color: '#86EFAC' },
  { icon: Cherry, color: '#FB7185' },
  { icon: Bell, color: '#FCD34D' },
  { icon: Umbrella, color: '#C084FC' },
  { icon: Fish, color: '#7DD3FC' },
  { icon: Pizza, color: '#FDBA74' },
  { icon: Gamepad2, color: '#F9A8D4' },
  { icon: Cat, color: '#FDE047' },
  { icon: Snowflake, color: '#BAE6FD' },
  { icon: Flower2, color: '#F0ABFC' },
  { icon: Orbit, color: '#A5B4FC' },
  { icon: Key, color: '#FCD34D' },
  { icon: Skull, color: '#D4D4D8' },
];

/** 심볼 id(1..28) → 아이콘/색. 범위를 벗어나면 순환시켜 안전하게 돌려준다. */
export function symbolOf(id: number): GameSymbol {
  return SYMBOLS[(id - 1 + SYMBOLS.length) % SYMBOLS.length] ?? SYMBOLS[0];
}

/**
 * v2 타일은 상아색이라 팔레트의 밝은 색(#FDE68A 등)이 그대로면 아이콘이 안 보인다.
 * 밝기가 높은 색만 어둡게 눌러서 "잉크 색"을 만든다(글로우·파티클은 원색 그대로 쓴다).
 */
export function inkOf(id: number): string {
  const hex = symbolOf(id).color;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum <= 0.55) return hex;
  const k = 0.52 / lum;           // 목표 밝기까지 눌러준다
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `#${[to(r), to(g), to(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
