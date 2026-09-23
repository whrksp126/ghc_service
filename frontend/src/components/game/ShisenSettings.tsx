import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Lock, Play } from 'lucide-react';
import { MapPreview } from './MapPreview';
import { DIFFICULTIES, DIFFICULTY_LABEL, MAP_GUIDE, difficultyOf, type Difficulty } from '../../games/v3';
import { BOARD_DIMS, type BoardSize, type GameMode, type GameOptions, type MapShape, type SpecialToggles } from '../../games/types';

const MODE_LABEL: Record<GameMode, string> = { race: '개인전 (레이스)', coop: '쟁탈전' };
export const MODE_DESC: Record<GameMode, string> = {
  race: '각자 독립된 판, 먼저 다 지우면 승리',
  coop: '한 판을 나눠 먹기 — 누가 더 많이, 빨리 지우나',
};
const SIZE_LABEL: Record<BoardSize, string> = { s: '작게', m: '보통', l: '크게' };
const SHAPES: MapShape[] = ['random', 'rect', 'diamond', 'frame', 'towers', 'pyramid', 'cross', 'blob'];
const SPECIAL_LABEL: Record<keyof SpecialToggles, string> = {
  mystery: '물음표', numbers: '숫자 순서', keys: '자물쇠·열쇠', walls: '벽',
};
const TIME_CHOICES = [0, 180, 300, 600];
const TOOL_LABEL: Record<'hint' | 'shuffle' | 'wand', string> = { hint: '힌트', shuffle: '재배치', wand: '여의봉' };
const TOOL_MAX: Record<'hint' | 'shuffle' | 'wand', number> = { hint: 9, shuffle: 9, wand: 3 };

interface ShisenSettingsProps {
  mode: GameMode;
  options: GameOptions;
  seed: number;
  canEdit: boolean;
  busy?: boolean;
  canStart: boolean;
  onMode: (mode: GameMode) => void;
  onOptions: (patch: Partial<GameOptions>) => void;
  onStart: () => void;
}

/** 사천성 상세 설정 — 넷마블식 중앙 패널 (v3 §W3). */
export function ShisenSettings({
  mode, options, seed, canEdit, busy, canStart, onMode, onOptions, onStart,
}: ShisenSettingsProps) {
  const locked = !canEdit || !!busy;
  const difficulty = difficultyOf(options);
  const tools = options.tools ?? { hint: 3, shuffle: 2, wand: 1 };

  // Space 로 시작 (넷마블 SPACE BAR 힌트)
  useEffect(() => {
    if (!canStart) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.code !== 'Space') return;
      e.preventDefault();
      onStart();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canStart, onStart]);

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


  return (
    <div className="glass relative space-y-3 rounded-feed p-3">
      {!canEdit && (
        <p className="flex items-center gap-1 text-[11px] text-white/35">
          <Lock size={11} /> 방장만 설정을 바꿀 수 있어요
        </p>
      )}

      {/* 맵 선택 — 8종 카드 격자(각 카드가 실제 실루엣) */}
      <div>
        <p className="mb-1 px-0.5 text-xs text-white/50">맵 선택</p>
        <div className="grid grid-cols-4 gap-1.5">
          {SHAPES.map((sh) => {
            const active = options.mapShape === sh;
            return (
              <button
                key={sh}
                disabled={locked}
                onClick={() => onOptions({ mapShape: sh })}
                className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 transition-colors ${
                  active ? 'border-primary bg-primary/15' : 'border-white/10 bg-black/25 hover:border-white/25'
                } ${locked ? 'pointer-events-none opacity-60' : ''}`}
              >
                <MapPreview options={{ ...options, mapShape: sh }} seed={seed} width={74} compact />
                <span className={`text-[10px] ${active ? 'text-white' : 'text-white/50'}`}>
                  {(MAP_GUIDE[sh] ?? MAP_GUIDE.rect).name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 대전 방식 큰 토글 */}
      <div className="flex gap-2">
        {(['race', 'coop'] as GameMode[]).map((m) => (
          <button
            key={m}
            disabled={locked}
            onClick={() => onMode(m)}
            className={`flex-1 rounded-feed border p-2.5 text-left transition-colors ${
              mode === m ? 'border-primary bg-primary/15' : 'border-white/10 bg-white/5'
            } ${locked ? 'opacity-60' : 'hover:border-white/25'}`}
          >
            <p className="text-sm font-bold">{MODE_LABEL[m]}</p>
            <p className="mt-0.5 text-[11px] leading-tight text-white/45">{MODE_DESC[m]}</p>
          </button>
        ))}
      </div>

      {/* 난이도 ? 1 2 3 4 5 */}
      {row('난이도', (
        <>
          <button
            disabled={locked}
            onClick={() => {
              const rand = (1 + Math.floor(Math.random() * 5)) as Difficulty;
              onOptions({ difficulty: rand });
            }}
            className={chip(false)}
            title="무작위 난이도"
          >
            ?
          </button>
          {DIFFICULTIES.map((d) => (
            <button key={d} disabled={locked} onClick={() => onOptions({ difficulty: d })} className={chip(difficulty === d)}>
              {d}
            </button>
          ))}
        </>
      ), DIFFICULTY_LABEL[difficulty])}

      {row('판 크기', (['s', 'm', 'l'] as BoardSize[]).map((s) => (
        <button key={s} disabled={locked} onClick={() => onOptions({ boardSize: s })} className={chip(options.boardSize === s)}>
          {SIZE_LABEL[s]}
        </button>
      )), `${BOARD_DIMS[options.boardSize].cols}×${BOARD_DIMS[options.boardSize].rows}`)}

      {row('특수 타일', (Object.keys(SPECIAL_LABEL) as Array<keyof SpecialToggles>).map((k) => (
        <button
          key={k}
          disabled={locked}
          onClick={() => onOptions({ specials: { ...options.specials, [k]: !options.specials[k] } })}
          className={chip(options.specials[k])}
        >
          {SPECIAL_LABEL[k]}
        </button>
      )), '여러 개 켤 수 있어요')}

      {row('제한 시간', TIME_CHOICES.map((t) => (
        <button key={t} disabled={locked} onClick={() => onOptions({ timeLimitSec: t })} className={chip(options.timeLimitSec === t)}>
          {t === 0 ? '무제한' : `${t / 60}분`}
        </button>
      )))}

      {row('방해 아이템', [false, true].map((v) => (
        <button
          key={String(v)}
          disabled={locked || mode === 'coop'}
          onClick={() => onOptions({ items: v })}
          className={chip(options.items === v, locked || mode === 'coop')}
        >
          {v ? '켜짐' : '꺼짐'}
        </button>
      )), mode === 'coop' ? '쟁탈전에서는 사용 불가' : undefined)}

      {/* 아이템 개수 (방장만) */}
      {row('아이템', (['hint', 'shuffle', 'wand'] as const).map((k) => (
        <span key={k} className="flex items-center gap-1 rounded-full bg-dark-700 px-2 py-1">
          <span className="text-[10px] text-white/50">{TOOL_LABEL[k]}</span>
          <button
            disabled={locked}
            onClick={() => onOptions({ tools: { ...tools, [k]: Math.max(0, tools[k] - 1) } })}
            className={`px-1 text-xs ${locked ? 'opacity-40' : 'text-white/60 hover:text-white'}`}
          >
            −
          </button>
          <span className="w-3 text-center font-display text-xs tabular-nums text-white">{tools[k]}</span>
          <button
            disabled={locked}
            onClick={() => onOptions({ tools: { ...tools, [k]: Math.min(TOOL_MAX[k], tools[k] + 1) } })}
            className={`px-1 text-xs ${locked ? 'opacity-40' : 'text-white/60 hover:text-white'}`}
          >
            +
          </button>
        </span>
      )))}

      {/* 게임시작! */}
      {canEdit && (
        <motion.button
          whileTap={{ scale: 0.98 }}
          disabled={!canStart}
          onClick={onStart}
          className={`mt-1 flex w-full flex-col items-center gap-0.5 rounded-feed py-3 transition-colors ${
            canStart ? 'bg-primary hover:bg-primary-hover' : 'bg-dark-700 opacity-50'
          }`}
        >
          <span className="flex items-center gap-2 font-display text-xl font-black text-white">
            <Play size={20} /> 게임시작!
          </span>
          <span className="rounded bg-black/25 px-2 py-0.5 text-[10px] tracking-widest text-white/70">SPACE BAR</span>
        </motion.button>
      )}
    </div>
  );
}
