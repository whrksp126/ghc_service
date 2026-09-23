import { useState } from 'react';
import { motion } from 'framer-motion';
import { Blocks, Gamepad2, Grid3x3, Loader2 } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { useGameStore } from '../../stores/gameStore';
import { initGameAudio } from '../../games/sounds';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import type { GameSnapshot } from '../../games/types';

interface Pack {
  id: string;
  name: string;
  desc: string;
  icon: typeof Gamepad2;
  ready: boolean;
}

const PACKS: Pack[] = [
  { id: 'shisen', name: '사천성', desc: '같은 그림 두 개를 이어서 지우기', icon: Grid3x3, ready: true },
  { id: 'tetris', name: '테트리스', desc: '블록을 쌓아 줄을 지우고 상대에게 보내기', icon: Blocks, ready: true },
  { id: 'soon1', name: '곧 추가', desc: '다음 게임을 준비하고 있어요', icon: Gamepad2, ready: false },
];

/**
 * 게임 팩 선택 (v3 §W3). 방장이 고르면 그 팩 방으로 들어간다.
 * 팩 선택은 로컬 UI 단계라 비방장에게는 "방장이 고르는 중" 대기 화면을 보여 준다.
 */
export function PackSelect({
  isHost, snapshot, feeds = [],
}: { isHost: boolean; snapshot?: GameSnapshot | null; feeds?: GameFeed[] }) {
  const setPackChosen = useGameStore((s) => s.setPackChosen);
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (pack: Pack) => {
    if (!pack.ready) return;
    setBusy(pack.id);
    initGameAudio();
    try {
      await emitWithAck('game:updateOptions', { gameId: pack.id });
      setPackChosen(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '게임을 고르지 못했어요', 'error');
    } finally {
      setBusy(null);
    }
  };

  /** 방에 들어와 있는 사람들(플레이어+관전자) 카메라 — 팩을 고르는 동안에도 서로 보이게. */
  const people = [
    ...(snapshot?.players ?? []).map((p) => ({ userId: p.userId, nickname: p.nickname, color: p.color })),
    ...(snapshot?.spectators ?? []).map((s2) => ({ userId: s2.userId, nickname: s2.nickname, color: '#9CA3AF' })),
  ];
  const strip = people.length === 0 ? null : (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto scrollbar-none px-1 pt-2">
      {people.map((person) => (
        <div key={person.userId} className="w-[96px] shrink-0">
          <div className="aspect-video w-full overflow-hidden rounded-lg bg-black/40">
            <ProfileVideo
              feed={feeds.find((f) => f.userId === person.userId && !f.isScreen)}
              color={person.color}
              label={person.nickname}
              className="h-full w-full"
            />
          </div>
          <p className="truncate text-center text-[10px] text-white/50">{person.nickname}</p>
        </div>
      ))}
    </div>
  );

  if (!isHost) {
    return (
      <div className="flex h-full flex-col p-4">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <Loader2 size={28} className="animate-spin text-white/30" />
          <p className="text-sm text-white/60">방장이 게임을 고르는 중…</p>
          <p className="text-xs text-white/30">잠시만 기다려 주세요</p>
        </div>
        {strip}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div>
        <p className="font-display text-lg font-bold">어떤 게임을 할까요?</p>
        <p className="mt-0.5 text-xs text-white/40">방장이 고른 게임으로 모두 함께 이동해요</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {PACKS.map((pack) => {
          const Icon = pack.icon;
          return (
            <motion.button
              key={pack.id}
              whileTap={pack.ready ? { scale: 0.97 } : undefined}
              disabled={!pack.ready || busy !== null}
              onClick={() => { void choose(pack); }}
              className={`flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-feed border p-3 text-center transition-colors ${
                pack.ready
                  ? 'border-primary/40 bg-primary/10 hover:border-primary'
                  : 'border-white/10 bg-white/5 opacity-40'
              }`}
            >
              <Icon size={28} className={pack.ready ? 'text-primary' : 'text-white/40'} />
              <span className="text-sm font-semibold">{pack.name}</span>
              <span className="text-[11px] leading-tight text-white/45">{pack.desc}</span>
            </motion.button>
          );
        })}
      </div>
      {strip}
    </div>
  );
}
