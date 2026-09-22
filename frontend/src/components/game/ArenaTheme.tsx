import { useMemo } from 'react';

export type ArenaThemeName = 'night' | 'wood' | 'stone';

const THEMES: ArenaThemeName[] = ['night', 'wood', 'stone'];

/** 판마다 테마 1개 — 서버 시드로 결정되니 모두가 같은 배경을 본다(§V5). */
export function themeOf(seed: number): ArenaThemeName {
  return THEMES[Math.abs(Math.floor(seed)) % THEMES.length];
}

/** 보드를 올려 두는 트레이(반투명 판 + 안쪽 그림자). 테마마다 색만 다르다. */
export const TRAY_CLASS: Record<ArenaThemeName, string> = {
  night: 'rounded-2xl bg-[#0B1020]/70 shadow-[inset_0_2px_12px_rgba(0,0,0,0.6)] ring-1 ring-white/5',
  wood: 'rounded-2xl bg-[#2A1B12]/70 shadow-[inset_0_2px_12px_rgba(0,0,0,0.55)] ring-1 ring-amber-200/10',
  stone: 'rounded-2xl bg-[#1B2026]/75 shadow-[inset_0_2px_12px_rgba(0,0,0,0.55)] ring-1 ring-white/5',
};

/** 별 점묘 좌표 — 시드로 고정해서 리렌더마다 튀지 않게. */
function stars(seed: number, n: number) {
  let a = (seed >>> 0) || 1;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
  return Array.from({ length: n }, () => ({
    x: rnd() * 100, y: rnd() * 100, r: 0.4 + rnd() * 1.1, o: 0.25 + rnd() * 0.5,
  }));
}

/**
 * 아레나 배경. 이미지 자산 없이 CSS/SVG만 쓴다.
 *
 * **`-z-10` 필수**: absolute(positioned) 요소는 CSS 페인트 순서상 형제인 정적 콘텐츠보다 **위에**
 * 그려진다. 그래서 z-index 없이 두면 보드 위 PlayerHeader 카드(정적 흐름)가 이 배경에 가려
 * 콤보 배지(framer transform = 스태킹 컨텍스트)만 떠 있는 것처럼 보였다.
 * 아레나 루트에 `isolate`가 있어 음수 z-index가 패널 밖으로 새지 않는다.
 */
export function ThemeBackdrop({ theme, seed }: { theme: ArenaThemeName; seed: number }) {
  const pts = useMemo(() => (theme === 'night' ? stars(seed, 70) : []), [theme, seed]);

  if (theme === 'wood') {
    return (
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-feed">
        <div className="absolute inset-0 bg-gradient-to-br from-[#4A2F1E] via-[#382416] to-[#22150D]" />
        <div
          className="absolute inset-0 opacity-30"
          style={{
            background:
              'repeating-linear-gradient(97deg, rgba(255,214,170,0.10) 0px, rgba(255,214,170,0.10) 2px, transparent 2px, transparent 9px)',
          }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(255,196,120,0.18),transparent_60%)]" />
      </div>
    );
  }

  if (theme === 'stone') {
    return (
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-feed">
        <div className="absolute inset-0 bg-gradient-to-br from-[#2A3037] via-[#20262C] to-[#14181D]" />
        <svg className="absolute inset-0 h-full w-full opacity-[0.22]">
          <filter id="arena-noise">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#arena-noise)" />
        </svg>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_100%,rgba(140,170,200,0.12),transparent_55%)]" />
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-feed">
      <div className="absolute inset-0 bg-gradient-to-b from-[#101A33] via-[#0B1020] to-[#070A14]" />
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={p.r / 6} fill="#DCE9FF" opacity={p.o} />
        ))}
      </svg>
      <div className="absolute -left-10 top-6 h-40 w-40 rounded-full bg-secondary/10 blur-3xl" />
      <div className="absolute -right-8 bottom-4 h-44 w-44 rounded-full bg-primary/10 blur-3xl" />
    </div>
  );
}
