import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Lock, Play } from 'lucide-react';
import {
  TETRIS_LIMITS, TETRIS_MODES, TETRIS_MODE_LABEL,
  type TetrisMode, type TetrisOptions,
} from '../../games/tetris/types';
import { TETRIS_MODE_DESC } from '../../games/tetris/ui';

const TIME_CHOICES = [0, 180, 300, 600];

interface TetrisSettingsProps {
  options: TetrisOptions;
  canEdit: boolean;
  busy?: boolean;
  canStart: boolean;
  onOptions: (patch: Partial<TetrisOptions>) => void;
  onStart: () => void;
}

/** 테트리스 상세 설정 (설계서 §T7) — 사천성 `ShisenSettings` 의 칩/스테퍼 톤을 그대로 쓴다. */
export function TetrisSettings({
  options, canEdit, busy, canStart, onOptions, onStart,
}: TetrisSettingsProps) {
  const locked = !canEdit || !!busy;

  // Space 로 시작 (사천성과 동일한 넷마블식 힌트)
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
      <span className="mt-1 w-[76px] shrink-0 text-xs text-white/50">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {children}
        {hint && <span className="text-[11px] text-white/30">{hint}</span>}
      </div>
    </div>
  );

  const stepper = (
    value: number, min: number, max: number, onChange: (v: number) => void, suffix?: string,
  ) => (
    <span className="flex items-center gap-1 rounded-full bg-dark-700 px-2 py-1">
      <button
        disabled={locked}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={`px-1 text-xs ${locked ? 'opacity-40' : 'text-white/60 hover:text-white'}`}
      >
        −
      </button>
      <span className="w-5 text-center font-display text-xs tabular-nums text-white">{value}</span>
      <button
        disabled={locked}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={`px-1 text-xs ${locked ? 'opacity-40' : 'text-white/60 hover:text-white'}`}
      >
        +
      </button>
      {suffix && <span className="text-[10px] text-white/40">{suffix}</span>}
    </span>
  );

  return (
    <div className="glass relative space-y-3 rounded-feed p-3">
      {!canEdit && (
        <p className="flex items-center gap-1 text-[11px] text-white/35">
          <Lock size={11} /> 방장만 설정을 바꿀 수 있어요
        </p>
      )}

      {/* 대전 방식 — 큰 카드 3개 */}
      <div className="flex gap-2">
        {TETRIS_MODES.map((m: TetrisMode) => (
          <button
            key={m}
            disabled={locked}
            onClick={() => onOptions({ mode: m })}
            className={`flex-1 rounded-feed border p-2.5 text-left transition-colors ${
              options.mode === m ? 'border-primary bg-primary/15' : 'border-white/10 bg-white/5'
            } ${locked ? 'opacity-60' : 'hover:border-white/25'}`}
          >
            <p className="text-sm font-bold">{TETRIS_MODE_LABEL[m]}</p>
            <p className="mt-0.5 text-[11px] leading-tight text-white/45">{TETRIS_MODE_DESC[m]}</p>
          </button>
        ))}
      </div>

      {options.mode === 'sprint' && row('목표 줄 수', TETRIS_LIMITS.sprintLines.map((n) => (
        <button key={n} disabled={locked} onClick={() => onOptions({ sprintLines: n })} className={chip(options.sprintLines === n)}>
          {n}줄
        </button>
      )))}

      {row('시작 레벨', (
        <>
          <input
            type="range"
            disabled={locked}
            min={TETRIS_LIMITS.startLevel.min}
            max={TETRIS_LIMITS.startLevel.max}
            value={options.startLevel}
            onChange={(e) => onOptions({ startLevel: Number(e.target.value) })}
            className={`h-1 w-[120px] cursor-pointer appearance-none rounded-full bg-dark-700 accent-primary ${locked ? 'pointer-events-none opacity-50' : ''}`}
          />
          <span className="font-display text-sm tabular-nums text-white">{options.startLevel}</span>
        </>
      ), '숫자가 클수록 빨리 떨어져요')}

      {row('레벨업', TETRIS_LIMITS.levelUpLines.map((n) => (
        <button key={n} disabled={locked} onClick={() => onOptions({ levelUpLines: n })} className={chip(options.levelUpLines === n)}>
          {n === 0 ? '고정' : `${n}줄마다`}
        </button>
      )))}

      {/* 레이스는 서버가 공격을 아예 막는다(manager.onClear) → 버튼도 같이 잠가야 설명과 동작이 일치한다. */}
      {row('공격량', TETRIS_LIMITS.garbageMul.map((v) => (
        <button key={v} disabled={locked || options.mode === 'sprint'} onClick={() => onOptions({ garbageMul: v })} className={chip(options.garbageMul === v)}>
          ×{v}
        </button>
      )), options.mode === 'sprint' ? '레이스에서는 공격이 없어요' : undefined)}

      {options.mode === 'survival' && row('바닥 상승', TETRIS_LIMITS.riseSec.map((s) => (
        <button key={s} disabled={locked} onClick={() => onOptions({ riseSec: s })} className={chip(options.riseSec === s)}>
          {s === 0 ? '없음' : `${s}초`}
        </button>
      )))}

      {row('홀드', [true, false].map((v) => (
        <button key={String(v)} disabled={locked} onClick={() => onOptions({ hold: v })} className={chip(options.hold === v)}>
          {v ? '켜짐' : '꺼짐'}
        </button>
      )))}

      {row('그림자', [true, false].map((v) => (
        <button key={String(v)} disabled={locked} onClick={() => onOptions({ ghost: v })} className={chip(options.ghost === v)}>
          {v ? '켜짐' : '꺼짐'}
        </button>
      )), '떨어질 위치 미리보기')}

      {row('다음 개수', stepper(
        options.nextCount, TETRIS_LIMITS.nextCount.min, TETRIS_LIMITS.nextCount.max,
        (v) => onOptions({ nextCount: v }), '개',
      ))}

      {row('제한 시간', TIME_CHOICES.map((t) => (
        <button key={t} disabled={locked} onClick={() => onOptions({ timeLimitSec: t })} className={chip(options.timeLimitSec === t)}>
          {t === 0 ? '무제한' : `${t / 60}분`}
        </button>
      )))}

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
