import { Key, Lightbulb, Shuffle, Wand2 } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { useGameStore } from '../../stores/gameStore';
import { playGameSound } from '../../games/sounds';
import { itemsOf, rankOf } from '../../games/v3';
import type { HintAck } from '../../games/events';
import { KEY_COLORS, MAX_KEY_TYPES, type Board, type GameSnapshot, type PlayerState } from '../../games/types';

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

interface GameHudProps {
  snapshot: GameSnapshot;
  board?: Board;
  me?: PlayerState;
  /** 내가 조작 가능한 상태(기권·관전이면 false) */
  active: boolean;
  myUserId: string | null;
  /** 관전(기권 포함) — 아이템·N등을 숨기고 보고 있는 판의 수치만 보여 준다 */
  spectating?: boolean;
}

/** 인게임 상단 카운터 바 (v3 §W3) — 남은 패 · 소거 가능 패 · 아이템 3종 · 우측 큰 N등. */
export function GameHud({ snapshot, board, me, active, myUserId, spectating }: GameHudProps) {
  const items = itemsOf(me);
  const remainingOf = (p: PlayerState) => snapshot.boards[p.boardId]?.remaining ?? 0;
  const rank = rankOf(snapshot.players, snapshot.mode, remainingOf, myUserId);
  const danger = (board?.remaining ?? 0) > 0 && (board?.remaining ?? 0) <= 8;

  const counter = (label: string, value: number, tone?: string) => (
    <span className="flex items-baseline gap-1 rounded-lg bg-black/35 px-2.5 py-1">
      <span className="text-[10px] text-white/45">{label}</span>
      <span className={`font-display text-sm font-bold tabular-nums ${tone ?? 'text-white'}`}>{value}</span>
    </span>
  );

  return (
    <div className="relative flex shrink-0 items-center gap-1.5 px-1">
      {counter('남은 패', board?.remaining ?? 0, danger ? 'text-primary animate-pulse' : undefined)}
      {counter('소거 가능', board?.movesLeft ?? 0, (board?.movesLeft ?? 0) === 0 ? 'text-primary' : 'text-secondary')}

      {!spectating && (Object.keys(ITEM_META) as ItemKind[]).map((k) => {
        const meta = ITEM_META[k];
        const Icon = meta.icon;
        const n = items[k];
        const off = !active || n <= 0;
        return (
          <button
            key={k}
            disabled={off}
            onClick={() => { void runItem(k); }}
            title={`${meta.key} ${meta.label}`}
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors ${
              off ? 'bg-black/25 text-white/25' : 'bg-dark-700 text-white/85 hover:bg-dark-600'
            }`}
          >
            <span className="font-display text-[9px] text-white/40">{meta.key}</span>
            <Icon size={13} className={off ? '' : 'text-warning'} />
            <span className="font-display tabular-nums">{n}</span>
          </button>
        );
      })}

      {/* 남은 열쇠 쌍 — 색 점으로 종류를 보여 준다(v3 색 자물쇠) */}
      {(board?.keysLeft ?? 0) > 0 && (
        <span className="flex items-center gap-1 rounded-lg bg-black/35 px-2 py-1 text-[10px] text-white/60">
          <Key size={11} className="text-white/70" />
          {Array.from({ length: Math.min(MAX_KEY_TYPES, board?.keysLeft ?? 0) }).map((_, i) => (
            <span key={i} className="h-2 w-2 rounded-full" style={{ background: KEY_COLORS[i] }} />
          ))}
          <span className="font-display tabular-nums">{board?.keysLeft}</span>
        </span>
      )}
      {(board?.nextNumber ?? 0) > 0 && (
        <span className="rounded-lg bg-black/35 px-2 py-1 text-[10px] text-warning">
          다음 숫자 <span className="font-display tabular-nums">{board?.nextNumber}</span>
        </span>
      )}

      {spectating ? (
        <span className="ml-auto rounded-lg bg-black/35 px-2 py-1 text-[10px] text-white/45">관전 중</span>
      ) : (
        <span className="ml-auto flex items-baseline gap-0.5 rounded-lg bg-black/40 px-2.5 py-0.5">
          <span className="font-display text-2xl font-black tabular-nums text-white">{rank}</span>
          <span className="text-xs text-white/60">등</span>
        </span>
      )}
    </div>
  );
}
