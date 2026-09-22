import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Gamepad2, Users, X, Zap } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { Button } from '../common/Button';
import { useGameStore } from '../../stores/gameStore';
import { initGameAudio } from '../../games/sounds';
import { GameLobby } from './GameLobby';
import { ShisenArena } from './ShisenArena';
import { DEFAULT_OPTIONS, type GameMode, type GameSnapshot } from '../../games/types';

/** 게임이 없을 때 — 모드를 고르고 방을 연다. */
function GameIdle() {
  const [busy, setBusy] = useState(false);
  const create = async (mode: GameMode) => {
    setBusy(true);
    initGameAudio();
    try {
      await emitWithAck('game:create', { gameId: 'shisen', mode, options: DEFAULT_OPTIONS[mode] });
    } catch (err) {
      showToast(err instanceof Error ? err.message : '게임을 열지 못했어요', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <Gamepad2 size={40} strokeWidth={1.5} className="text-white/25" />
      <div>
        <p className="font-display text-lg font-bold">사천성</p>
        <p className="mt-1 text-xs text-white/40">카메라는 켠 채로, 방에 남은 사람들과 한 판</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button loading={busy} onClick={() => create('race')}>
          <Zap size={16} /> 레이스로 열기
        </Button>
        <Button variant="secondary" loading={busy} onClick={() => create('coop')}>
          <Users size={16} /> 협동으로 열기
        </Button>
      </div>
    </div>
  );
}

function phaseLabel(s: GameSnapshot | null): string {
  if (!s) return '대기';
  if (s.phase === 'lobby') return '로비';
  if (s.phase === 'countdown') return '시작!';
  if (s.phase === 'playing') return '진행 중';
  return '결과';
}

/** 게임 패널 컨테이너 — phase/역할별 분기 + 닫기. */
export function GamePanel() {
  const snapshot = useGameStore((s) => s.snapshot);
  const closePanel = useGameStore((s) => s.closePanel);

  // 패널을 여는 동작 자체가 유저 제스처 → 여기서 AudioContext를 깨운다.
  useEffect(() => { initGameAudio(); }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass flex h-full min-h-0 w-full flex-col overflow-hidden rounded-feed"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-3 py-2">
        <Gamepad2 size={16} className="text-primary" />
        <span className="text-sm font-semibold">사천성</span>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/50">
          {phaseLabel(snapshot)}
        </span>
        <button
          onClick={closePanel}
          className="ml-auto text-white/40 transition-colors hover:text-white"
          title="게임 패널 닫기"
        >
          <X size={18} />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {!snapshot ? (
          <GameIdle />
        ) : snapshot.phase === 'lobby' ? (
          <GameLobby snapshot={snapshot} />
        ) : (
          <ShisenArena snapshot={snapshot} />
        )}
      </div>
    </motion.div>
  );
}
