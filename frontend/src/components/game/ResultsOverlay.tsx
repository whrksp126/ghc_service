import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Crown, RotateCcw, Users, X } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { Button } from '../common/Button';
import { useGameStore } from '../../stores/gameStore';
import { useAuthStore } from '../../stores/authStore';
import { formatMs } from './Scoreboard';
import { Confetti } from './Confetti';
import { playGameSound } from '../../games/sounds';
import { prefersReducedMotion } from '../../games/motion';
import type { GameSnapshot } from '../../games/types';

/**
 * 결과 오버레이. race=순위 카드, coop=팀 기록 + 기여도.
 * B2에서 4위→1위 순차 슬라이드업 + 컨페티가 들어온다.
 */
export function ResultsOverlay({ snapshot }: { snapshot: GameSnapshot }) {
  const myUserId = useAuthStore((s) => s.userId);
  const closePanel = useGameStore((s) => s.closePanel);
  const [busy, setBusy] = useState(false);
  const isHost = snapshot.hostUserId === myUserId;
  const results = snapshot.results ?? [];
  const isCoop = snapshot.mode === 'coop';
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
            <p className="text-xs text-white/50">팀 클리어</p>
            <p className="font-display text-4xl font-black tabular-nums text-secondary">
              {formatMs(teamMs)}
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
                r.rank === 1 && !isCoop ? 'bg-white/10' : 'bg-white/5'
              } ${r.userId === myUserId ? 'ring-1 ring-white/30' : ''}`}
            >
              {!isCoop && (
                <span className="w-6 shrink-0 text-center font-display font-bold tabular-nums">
                  {r.rank === 1 ? <Crown size={16} className="mx-auto text-warning" /> : r.rank}
                </span>
              )}
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="min-w-0 flex-1 truncate text-sm">{r.nickname}</span>
              <span className="shrink-0 font-display text-xs tabular-nums text-white/60">
                {isCoop
                  ? `${r.pairsCleared}쌍 · ${r.score}점`
                  : r.timeMs !== null
                    ? formatMs(r.timeMs)
                    : snapshot.players.find((p) => p.userId === r.userId)?.forfeited
                      ? '기권'
                      : `${r.remaining}개 남음`}
              </span>
              {!isCoop && <span className="shrink-0 font-display text-xs tabular-nums text-white/40">{r.score}점</span>}
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

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {isHost ? (
            <>
              <Button
                size="sm"
                loading={busy}
                onClick={() => run('game:rematch', '다시 하기', () => { void emitWithAck('game:start', {}).catch(() => {}); })}
              >
                <RotateCcw size={14} /> 다시 하기
              </Button>
              <Button size="sm" variant="secondary" loading={busy} onClick={() => run('game:rematch', '로비로')}>
                <Users size={14} /> 로비로
              </Button>
              <Button size="sm" variant="ghost" loading={busy} onClick={() => run('game:close', '게임 닫기')}>
                <X size={14} /> 게임 닫기
              </Button>
            </>
          ) : (
            <>
              <p className="w-full text-center text-xs text-white/40">호스트가 다시 시작하길 기다리는 중…</p>
              <Button size="sm" variant="secondary" onClick={closePanel}>닫기</Button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
