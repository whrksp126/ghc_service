import { Trophy } from 'lucide-react';
import type { ScoreboardRow } from '../../games/types';

/** mm:ss.s */
export function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const d = Math.floor((total % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

/** 오늘 밤 전적 — 방이 살아 있는 동안 메모리에만 남는 누적 기록. */
export function Scoreboard({ rows }: { rows: ScoreboardRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="glass rounded-feed p-4 text-center text-xs text-white/40">
        아직 기록이 없어요. 한 판 해볼까요?
      </div>
    );
  }
  const sorted = [...rows].sort((a, b) => b.wins - a.wins || b.games - a.games);
  return (
    <div className="glass rounded-feed p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-white/70">
        <Trophy size={13} className="text-warning" /> 오늘 밤 전적
      </div>
      <div className="space-y-1">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-1 text-[10px] text-white/35">
          <span>닉네임</span><span>승</span><span>판</span><span>최고 기록</span>
        </div>
        {sorted.map((r) => (
          <div
            key={r.userId}
            className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 rounded-lg px-1 py-1 text-xs text-white/80"
          >
            <span className="truncate">{r.nickname}</span>
            <span className="font-display tabular-nums text-primary">{r.wins}</span>
            <span className="font-display tabular-nums text-white/50">{r.games}</span>
            <span className="font-display tabular-nums text-white/50">{formatMs(r.bestTimeMs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
