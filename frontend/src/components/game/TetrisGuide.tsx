import { Keyboard, Swords } from 'lucide-react';
import { ATTACK_BONUS, ATTACK_TABLE, KEY_GUIDE, TETRIS_MODE_DESC } from '../../games/tetris/ui';
import { TETRIS_MODE_LABEL, type TetrisOptions } from '../../games/tetris/types';

/** 로비 우측 가이드 패널 (설계서 §T7) — 사천성 `MapGuide` 자리. 조작법 + 공격량 표. */
export function TetrisGuide({ options }: { options: TetrisOptions }) {
  const mul = options.garbageMul;
  return (
    <div className="glass flex flex-col gap-3 rounded-feed p-3">
      <div>
        <p className="text-xs text-white/40">대전 방식</p>
        <p className="font-display text-base font-bold">{TETRIS_MODE_LABEL[options.mode]}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-white/50">{TETRIS_MODE_DESC[options.mode]}</p>
      </div>

      <div>
        <p className="mb-1 flex items-center gap-1 text-xs text-white/40">
          <Keyboard size={12} /> 조작법 (PC 키보드)
        </p>
        <ul className="space-y-0.5">
          {KEY_GUIDE.map((k) => (
            <li key={k.keys} className="flex items-center gap-1.5 text-[11px] text-white/60">
              <span className="min-w-[62px] rounded bg-white/10 px-1 py-0.5 text-center font-display text-[10px] text-white/85">
                {k.keys}
              </span>
              {k.label}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[10px] text-white/30">모바일은 관전만 돼요</p>
      </div>

      <div>
        <p className="mb-1 flex items-center gap-1 text-xs text-white/40">
          <Swords size={12} /> 보내는 줄 수
          {mul !== 1 && <span className="text-white/55">· 배수 ×{mul}</span>}
        </p>
        <ul className="space-y-0.5">
          {ATTACK_TABLE.map((r) => (
            <li key={r.label} className="flex items-baseline gap-1.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-white/60">{r.label}</span>
              <span className="font-display tabular-nums text-secondary">{r.lines}줄</span>
            </li>
          ))}
        </ul>
        <ul className="mt-1.5 space-y-0.5 border-t border-white/5 pt-1.5">
          {ATTACK_BONUS.map((r) => (
            <li key={r.label} className="flex items-baseline gap-1.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-white/45">{r.label}</span>
              <span className="font-display tabular-nums text-warning">{r.value}</span>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-[10px] leading-snug text-white/30">
          내가 받을 줄이 남아 있으면 먼저 상쇄되고, 남는 만큼만 상대에게 날아가요
        </p>
      </div>
    </div>
  );
}
