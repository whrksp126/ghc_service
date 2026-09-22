import { useGameStore } from '../../stores/gameStore';

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 방 로그 스트립 (v3 §W3) — 입장/퇴장/설정 변경/방장 이양을 클라가 스냅샷 차이로 만든다. */
export function RoomLog() {
  const log = useGameStore((s) => s.roomLog);
  const recent = log.slice(-6).reverse();
  return (
    <div className="glass rounded-feed px-3 py-2">
      <p className="mb-1 text-[10px] text-white/35">방 기록</p>
      {recent.length === 0 ? (
        <p className="text-[11px] text-white/25">아직 기록이 없어요</p>
      ) : (
        <ul className="max-h-24 space-y-0.5 overflow-y-auto">
          {recent.map((l) => (
            <li key={l.id} className="flex gap-2 text-[11px] text-white/55">
              <span className="shrink-0 font-display tabular-nums text-white/25">{hhmm(l.at)}</span>
              <span className="min-w-0 truncate">{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
