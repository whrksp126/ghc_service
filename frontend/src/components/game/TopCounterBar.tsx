import { Lightbulb, Shuffle, Wand2 } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { useGameStore } from '../../stores/gameStore';
import { playGameSound } from '../../games/sounds';
import { itemsOf } from '../../games/v3';
import type { HintAck } from '../../games/events';
import type { Board, PlayerState } from '../../games/types';

export type ItemKind = 'hint' | 'shuffle' | 'wand';

const ITEM_META: Record<ItemKind, { key: string; label: string; icon: typeof Lightbulb; event: string }> = {
  hint: { key: 'F1', label: '힌트', icon: Lightbulb, event: 'game:hint' },
  shuffle: { key: 'F2', label: '재배치', icon: Shuffle, event: 'game:shuffle' },
  wand: { key: 'F3', label: '여의봉', icon: Wand2, event: 'game:wand' },
};

/** 아이템 사용(버튼·F키 공용). 힌트만 ack의 pair를 하이라이트한다. */
export async function runItem(kind: ItemKind): Promise<void> {
  const store = useGameStore.getState();
  try {
    const ack = await emitWithAck<HintAck | { ok: boolean; reason?: string }>(ITEM_META[kind].event, {});
    if (!ack.ok) {
      store.setNotice(kind === 'hint' ? '연결 가능한 쌍이 없어요' : '남은 개수가 없어요');
      return;
    }
    if (kind === 'hint' && 'pair' in ack) {
      store.setHintPair(ack.pair);
      playGameSound('hint');
      setTimeout(() => useGameStore.getState().setHintPair(null), 1800);
      return;
    }
    playGameSound(kind === 'shuffle' ? 'shuffle' : 'match', { combo: 1 });
  } catch (err) {
    store.setNotice(err instanceof Error ? err.message : '지금은 쓸 수 없어요');
  }
}

/** 넷마블식 카운터 칸 — 작은 라벨(위) + 큰 숫자(아래). */
function Cell({
  label, value, tone, onClick, disabled, hotkey,
}: {
  label: string; value: number | string; tone?: string;
  onClick?: () => void; disabled?: boolean; hotkey?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1 text-[10px] leading-none text-white/45">
        {hotkey && <span className="rounded bg-white/10 px-1 font-display text-[9px] text-white/60">{hotkey}</span>}
        {label}
      </span>
      <span className={`font-display text-2xl font-black leading-none tabular-nums ${tone ?? 'text-white'}`}>
        {value}
      </span>
    </>
  );
  const cls = 'flex min-w-[74px] flex-col items-start gap-1 rounded-lg px-2.5 py-1.5';
  if (!onClick) return <div className={`${cls} bg-black/40`}>{body}</div>;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${cls} transition-colors ${
        disabled ? 'bg-black/25 opacity-40' : 'bg-dark-700 hover:bg-dark-600'
      }`}
    >
      {body}
    </button>
  );
}

interface TopCounterBarProps {
  board?: Board;
  me?: PlayerState;
  /** 내가 조작 가능한 상태(관전·기권이면 false) */
  active: boolean;
  rank: number;
  spectating?: boolean;
}

/** 상단 와이드 카운터 바 (v4 §X3) — 남은 패 / 소거 가능 패 / F1·F2·F3 + 우측 큰 N등. */
export function TopCounterBar({ board, me, active, rank, spectating }: TopCounterBarProps) {
  const items = itemsOf(me);
  const remaining = board?.remaining ?? 0;
  const danger = remaining > 0 && remaining <= 8;
  const moves = board?.movesLeft ?? 0;

  return (
    <div className="relative flex shrink-0 items-stretch gap-1.5 overflow-x-auto scrollbar-none px-1">
      <Cell label="남은 패" value={String(remaining).padStart(3, '0')} tone={danger ? 'text-primary' : undefined} />
      <Cell label="소거 가능 패" value={moves} tone={moves === 0 ? 'text-primary' : 'text-secondary'} />

      {!spectating && (Object.keys(ITEM_META) as ItemKind[]).map((k) => (
        <Cell
          key={k}
          hotkey={ITEM_META[k].key}
          label={ITEM_META[k].label}
          value={items[k]}
          tone={items[k] > 0 ? 'text-warning' : 'text-white/30'}
          disabled={!active || items[k] <= 0}
          onClick={() => { void runItem(k); }}
        />
      ))}

      <div className="ml-auto flex shrink-0 items-baseline gap-0.5 self-center pl-2">
        {spectating ? (
          <span className="rounded-lg bg-black/35 px-2 py-1 text-[10px] text-white/45">관전 중</span>
        ) : (
          <>
            <span className="font-display text-4xl font-black leading-none tabular-nums text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.7)]">
              {rank}
            </span>
            <span className="text-sm text-white/60">등</span>
          </>
        )}
      </div>
    </div>
  );
}
