import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Crown, Users, X } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { Button } from '../common/Button';
import { useAuthStore } from '../../stores/authStore';
import { formatMs } from './Scoreboard';
import { isForfeited } from '../../games/events';
import { Confetti } from './Confetti';
import { playGameSound } from '../../games/sounds';
import { prefersReducedMotion } from '../../games/motion';
import type { GameSnapshot } from '../../games/types';

/**
 * 종료 후 서버가 자동으로 로비로 되돌리기까지의 시간(§Z3).
 * **서버 값의 거울**이다 — 서버가 바뀌면 여기도 같이 고친다.
 */
const LOBBY_RETURN_MS = 12000;

/**
 * 결과 오버레이. race=순위 카드, coop=팀 기록 + 기여도.
 * B2에서 4위→1위 순차 슬라이드업 + 컨페티가 들어온다.
 */
export function ResultsOverlay({ snapshot }: { snapshot: GameSnapshot }) {
  const myUserId = useAuthStore((s) => s.userId);
  const [busy, setBusy] = useState(false);
  const isHost = snapshot.hostUserId === myUserId;
  const isCoop = snapshot.gameId !== 'tetris' && snapshot.mode === 'coop';
  // 테트리스는 ResultRow.remaining 자리에 **지운 줄 수**가 들어온다(설계서 §T3.2) —
  // 사천성 문구('N개 남음')를 그대로 쓰면 정반대 의미로 읽힌다.
  const isTetris = snapshot.gameId === 'tetris';
  // 쟁탈전 순위 = 지운 쌍 → 점수 (v2.1). 서버 rank가 같은 규칙이어도 표시를 확정적으로 맞춘다.
  const results = isCoop
    ? [...(snapshot.results ?? [])].sort((a, b) => b.pairsCleared - a.pairsCleared || b.score - a.score)
    : (snapshot.results ?? []);
  const teamMs = snapshot.startAt && snapshot.endedAt ? snapshot.endedAt - snapshot.startAt : null;

  const run = async (event: string, label: string, after?: () => void) => {
    setBusy(true);
    try {
      await emitWithAck(event, {});
      after?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : `${label} 실패`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const maxPairs = Math.max(1, ...results.map((r) => r.pairsCleared));
  const myRank = results.find((r) => r.userId === myUserId)?.rank ?? 0;
  const reduced = prefersReducedMotion();
  // 카드는 꼴찌부터 1위까지 200ms 간격으로 올라온다 → 1등 공개 시점에 소리 + 컨페티.
  const revealMs = reduced ? 0 : Math.max(0, results.length - 1) * 200;

  const [burst, setBurst] = useState(false);
  // 서버가 자동으로 로비로 되돌리기까지 남은 초 — 사용자가 "왜 안 넘어가지?" 하지 않도록 보여 준다.
  const [autoSec, setAutoSec] = useState<number | null>(null);

  useEffect(() => {
    if (!snapshot.endedAt) { setAutoSec(null); return; }
    const deadline = snapshot.endedAt + LOBBY_RETURN_MS;
    const tick = () => setAutoSec(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [snapshot.endedAt]);

  useEffect(() => {
    const t = setTimeout(() => {
      setBurst(true);
      if (isCoop) playGameSound('finish');
      else playGameSound(myRank === 1 ? 'win' : 'lose');
    }, revealMs + 120);
    return () => clearTimeout(t);
  }, [isCoop, myRank, revealMs]);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-dark-900/85 backdrop-blur-sm p-4">
      {burst && <Confetti colors={results.map((r) => r.color)} />}
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="glass-strong relative w-full max-w-md rounded-modal p-5 max-h-full overflow-y-auto"
      >
        {isCoop ? (
          <div className="mb-4 text-center">
            <h3 className="font-display text-xl font-bold">쟁탈전 결과</h3>
            <p className="mt-0.5 text-xs text-white/45">
              판 클리어 <span className="font-display tabular-nums text-secondary">{formatMs(teamMs)}</span>
            </p>
          </div>
        ) : (
          <h3 className="mb-4 text-center font-display text-xl font-bold">게임 끝!</h3>
        )}

        <div className="space-y-2">
          {results.map((r, i) => (
            <motion.div
              key={r.userId}
              initial={reduced ? false : { opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              // 4위 → 1위 순서로 등장
              transition={{ delay: reduced ? 0 : (results.length - 1 - i) * 0.2, duration: 0.25 }}
              className={`flex items-center gap-3 rounded-btn px-3 py-2 ${
                (isCoop ? i === 0 : r.rank === 1) ? 'bg-white/10' : 'bg-white/5'
              } ${r.userId === myUserId ? 'ring-1 ring-white/30' : ''}`}
            >
              <span className="w-6 shrink-0 text-center font-display font-bold tabular-nums">
                {(isCoop ? i === 0 : r.rank === 1)
                  ? <Crown size={16} className="mx-auto text-warning" />
                  : isCoop ? i + 1 : r.rank}
              </span>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="min-w-0 flex-1 truncate text-sm">{r.nickname}</span>
              {isCoop ? (
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="font-display text-lg font-black tabular-nums text-white">
                    {r.pairsCleared}<span className="ml-0.5 text-[10px] font-medium text-white/40">쌍</span>
                  </span>
                  <span className="font-display text-sm tabular-nums text-white/60">{r.score}점</span>
                </span>
              ) : (
                <>
                  <span className="shrink-0 font-display text-xs tabular-nums text-white/60">
                    {isForfeited(snapshot.players.find((p) => p.userId === r.userId))
                      ? '기권'
                      : isTetris
                        ? `${r.remaining}줄${r.timeMs !== null ? ` · ${formatMs(r.timeMs)}` : ''}`
                        : r.timeMs !== null
                          ? formatMs(r.timeMs)
                          : `${r.remaining}개 남음`}
                  </span>
                  <span className="shrink-0 font-display text-xs tabular-nums text-white/40">{r.score}점</span>
                </>
              )}
            </motion.div>
          ))}
          {isCoop && results.map((r) => (
            <div key={`bar-${r.userId}`} className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full"
                style={{ width: `${(r.pairsCleared / maxPairs) * 100}%`, background: r.color }}
              />
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-col items-center gap-2">
          {/* 즉시 재시작은 없앴다(§Z3) — 끝나면 무조건 대기방으로 돌아가 전원이 다시 준비해야 한다 */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" variant="secondary" loading={busy} data-ghc-lobby="" onClick={() => run('game:rematch', '로비로')}>
              <Users size={14} /> 로비로
            </Button>
            {isHost && (
              <Button size="sm" variant="ghost" loading={busy} data-ghc-close-room="" onClick={() => run('game:close', '게임 닫기')}>
                <X size={14} /> 게임 닫기
              </Button>
            )}
          </div>
          {autoSec !== null && (
            <p className="text-[11px] text-white/35">
              {autoSec > 0
                ? <><span className="font-display tabular-nums text-white/60">{autoSec}</span>초 뒤 대기방으로</>
                : '곧 대기방으로 돌아가요'}
            </p>
          )}
        </div>
      </motion.div>
    </div>
  );
}
