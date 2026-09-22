import type { BoardSize, GameMode, GameOptions, MapShape, SpecialToggles } from '../../games/types';
import { BOARD_DIMS } from '../../games/types';
import { MapPreview } from './MapPreview';

const MODE_LABEL: Record<GameMode, string> = { race: '레이스', coop: '쟁탈전' };
export const MODE_DESC: Record<GameMode, string> = {
  race: '각자 독립된 판, 먼저 다 지우면 승리',
  coop: '한 판을 나눠 먹기 — 누가 더 많이, 빨리 지우나',
};
const SIZE_LABEL: Record<BoardSize, string> = { s: '작게', m: '보통', l: '크게' };
const SHAPE_LABEL: Record<MapShape, string> = {
  random: '랜덤', rect: '직사각형', diamond: '다이아몬드', frame: '액자',
  towers: '쌍둥이 탑', pyramid: '피라미드', cross: '십자', blob: '얼룩',
};
const SPECIAL_LABEL: Record<keyof SpecialToggles, string> = {
  mystery: '물음표', numbers: '숫자 순서', keys: '열쇠·자물쇠', walls: '벽',
};
const TIME_CHOICES = [0, 180, 300, 600];

interface ShisenSettingsProps {
  mode: GameMode;
  options: GameOptions;
  seed: number;
  /** 방장만 편집 가능 — 나머지는 현재값만 강조된 읽기 전용 */
  canEdit: boolean;
  busy?: boolean;
  onMode: (mode: GameMode) => void;
  onOptions: (patch: Partial<GameOptions>) => void;
}

/** 사천성 상세 설정 (v2 §V1-2). 다른 게임이 붙으면 같은 자리에 그 게임 컴포넌트가 들어간다. */
export function ShisenSettings({
  mode, options, seed, canEdit, busy, onMode, onOptions,
}: ShisenSettingsProps) {
  const locked = !canEdit || !!busy;
  const chip = (active: boolean, disabled = locked) =>
    `rounded-full px-2.5 py-1 text-xs transition-colors ${
      active ? 'bg-primary text-white' : 'bg-dark-700 text-white/60 hover:bg-dark-600'
    } ${disabled ? 'pointer-events-none opacity-50' : ''}`;

  const row = (label: string, children: React.ReactNode, hint?: string) => (
    <div className="flex items-start gap-2">
      <span className="mt-1 w-[68px] shrink-0 text-xs text-white/50">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {children}
        {hint && <span className="text-[11px] text-white/30">{hint}</span>}
      </div>
    </div>
  );

  const dims = BOARD_DIMS[options.boardSize];

  return (
    <div className="glass space-y-2.5 rounded-feed p-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="min-w-0 flex-1 space-y-2.5">
          {row('대전 방식', (['race', 'coop'] as GameMode[]).map((m) => (
            <button key={m} onClick={() => onMode(m)} className={chip(mode === m)}>
              {MODE_LABEL[m]}
            </button>
          )), MODE_DESC[mode])}

          {row('판 크기', (['s', 'm', 'l'] as BoardSize[]).map((s) => (
            <button key={s} onClick={() => onOptions({ boardSize: s })} className={chip(options.boardSize === s)}>
              {SIZE_LABEL[s]}
            </button>
          )), `${dims.cols}×${dims.rows}`)}

          {row('맵 모양', (Object.keys(SHAPE_LABEL) as MapShape[]).map((s) => (
            <button key={s} onClick={() => onOptions({ mapShape: s })} className={chip(options.mapShape === s)}>
              {SHAPE_LABEL[s]}
            </button>
          )))}

          {row('특수 타일', (Object.keys(SPECIAL_LABEL) as Array<keyof SpecialToggles>).map((k) => (
            <button
              key={k}
              onClick={() => onOptions({ specials: { ...options.specials, [k]: !options.specials[k] } })}
              className={chip(options.specials[k])}
            >
              {SPECIAL_LABEL[k]}
            </button>
          )), '여러 개 켤 수 있어요')}

          {row('제한 시간', TIME_CHOICES.map((t) => (
            <button key={t} onClick={() => onOptions({ timeLimitSec: t })} className={chip(options.timeLimitSec === t)}>
              {t === 0 ? '무제한' : `${t / 60}분`}
            </button>
          )))}

          {row('방해 아이템', [false, true].map((v) => (
            <button
              key={String(v)}
              onClick={() => onOptions({ items: v })}
              className={chip(options.items === v, locked || mode === 'coop')}
            >
              {v ? '켜짐' : '꺼짐'}
            </button>
          )), mode === 'coop' ? '쟁탈전에서는 사용 불가' : undefined)}
        </div>

        <div className="shrink-0 self-center rounded-xl bg-black/25 p-2">
          <MapPreview options={options} seed={seed} width={150} />
        </div>
      </div>

      {!canEdit && <p className="text-[11px] text-white/30">방장만 설정을 바꿀 수 있어요</p>}
    </div>
  );
}
