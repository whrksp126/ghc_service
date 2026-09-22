import { MapPreview } from './MapPreview';
import { MAP_GUIDE, SPECIAL_GUIDE } from '../../games/v3';
import type { GameOptions, SpecialToggles } from '../../games/types';

/** 우측 맵 가이드 (v3 §W3) — 맵 설명 + 켜져 있는 특수 타일 규칙 + 실루엣. */
export function MapGuide({ options, seed }: { options: GameOptions; seed: number }) {
  const guide = MAP_GUIDE[options.mapShape] ?? MAP_GUIDE.rect;
  const on = SPECIAL_GUIDE.filter((g) => options.specials[g.key as keyof SpecialToggles]);
  return (
    <div className="glass flex flex-col gap-3 rounded-feed p-3">
      <div>
        <p className="text-xs text-white/40">맵</p>
        <p className="font-display text-base font-bold">{guide.name}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-white/50">{guide.desc}</p>
      </div>
      <div className="self-center rounded-xl bg-black/25 p-2">
        <MapPreview options={options} seed={seed} width={150} />
      </div>
      <div>
        <p className="mb-1 text-xs text-white/40">특수 타일</p>
        {on.length === 0 ? (
          <p className="text-[11px] text-white/30">켜진 특수 타일이 없어요</p>
        ) : (
          <ul className="space-y-1.5">
            {on.map((g) => (
              <li key={g.key} className="text-[11px] leading-snug text-white/60">
                <span className="font-semibold text-white/80">{g.title}</span> — {g.desc}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
