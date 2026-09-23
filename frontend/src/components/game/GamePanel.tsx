import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Eye, Gamepad2, Music, Music2, UserPlus, X } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { Button } from '../common/Button';
import { useGameStore } from '../../stores/gameStore';
import { useAuthStore } from '../../stores/authStore';
import { initGameAudio } from '../../games/sounds';
import { setBgmIntensity, startBgm, stopBgm, type BgmTrack } from '../../games/music';
import { useUIStore } from '../../stores/uiStore';
import { useTetrisStore } from '../../stores/tetrisStore';
import { GameLobby } from './GameLobby';
import { PackSelect } from './PackSelect';
import { ShisenArena } from './ShisenArena';
import { TetrisArena } from './TetrisArena';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import { MAX_PLAYERS, type GameId, type GameSnapshot } from '../../games/types';

/** 팩 이름 — 헤더/안내 카드가 같은 규칙을 쓰도록 한 곳에서만 정의한다. */
const GAME_LABEL: Record<GameId, string> = { shisen: '사천성', tetris: '테트리스' };

/** 게임 방이 없을 때 — 버튼 하나로 만든다(만든 사람이 방장). */
function GameIdle({ snapshot }: { snapshot: GameSnapshot | null }) {
  const myUserId = useAuthStore((s) => s.userId);
  const [busy, setBusy] = useState(false);

  const call = async (event: string) => {
    setBusy(true);
    initGameAudio();
    try {
      await emitWithAck(event, {});
    } catch (err) {
      showToast(err instanceof Error ? err.message : '요청에 실패했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!snapshot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <Gamepad2 size={40} strokeWidth={1.5} className="text-white/25" />
        <div>
          <p className="font-display text-lg font-bold">게임 방</p>
          <p className="mt-1 text-xs text-white/40">카메라는 켠 채로, 방에 남은 사람들과 한 판</p>
        </div>
        <Button className="w-full max-w-xs" loading={busy} onClick={() => call('game:create')}>
          <Gamepad2 size={16} /> 게임 방 만들기
        </Button>
      </div>
    );
  }

  // 이미 게임 방이 있는데 내가 참여하지 않은 상태 — 입장/관전 카드.
  const host = snapshot.players.find((p) => p.userId === snapshot.hostUserId);
  const inLobby = snapshot.phase === 'lobby';
  const full = snapshot.players.length >= MAX_PLAYERS;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="glass w-full max-w-sm rounded-feed p-4">
        <p className="font-display text-base font-bold">
          {host?.nickname ?? '누군가'}님의 게임 방
        </p>
        <p className="mt-1 text-xs text-white/45">
          {GAME_LABEL[snapshot.gameId] ?? '게임'} · 플레이어 {snapshot.players.length}/{MAX_PLAYERS} · {inLobby ? '대기 중' : '진행 중'}
        </p>
        <div className="mt-3 flex gap-2">
          {inLobby && (
            <Button
              size="sm"
              className="flex-1"
              loading={busy}
              disabled={full}
              onClick={() => call('game:join')}
            >
              <UserPlus size={14} /> {full ? '자리가 없어요' : '입장'}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            loading={busy}
            onClick={() => call('game:spectate')}
          >
            <Eye size={14} /> 관전
          </Button>
        </div>
        {myUserId === snapshot.hostUserId && (
          <p className="mt-2 text-[11px] text-white/30">내가 만든 방이에요</p>
        )}
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

/**
 * 지금 화면에 맞는 BGM 트랙. 게임 방이 없으면(null) 무음이고, 결과 화면만 공용 마무리 루프다.
 * BGM 생명주기는 **이 파일 한 곳에서만** 다룬다 — 아레나/로비에 흩으면 중복 재생·정지 누락이 난다.
 */
function trackFor(s: GameSnapshot | null): BgmTrack | null {
  if (!s) return null;
  if (s.phase === 'finished') return 'result';
  return s.gameId === 'tetris' ? 'tetris' : 'shisen';
}

/** 게임 패널 컨테이너 — phase/역할별 분기 + 닫기. */
export function GamePanel({ feeds = [] }: { feeds?: GameFeed[] }) {
  const snapshot = useGameStore((s) => s.snapshot);
  const closePanel = useGameStore((s) => s.closePanel);

  const bgmOn = useUIStore((s) => s.gameBgmOn);
  const toggleBgm = useUIStore((s) => s.toggleGameBgm);

  // 패널을 여는 동작 자체가 유저 제스처 → 여기서 AudioContext를 깨운다.
  useEffect(() => { initGameAudio(); }, []);

  const bgmTrack = trackFor(snapshot);
  // 트랙이 바뀌거나 음악을 껐을 때만 반응. startBgm 은 같은 트랙이면 무시하므로 재시작되지 않는다.
  useEffect(() => {
    if (!bgmOn || !bgmTrack) { stopBgm(); return; }
    startBgm(bgmTrack);
  }, [bgmOn, bgmTrack]);
  // 패널을 닫거나 방을 나가면 반드시 멈춘다. 이 cleanup 이 빠지면 음악이 방 밖까지 따라온다.
  useEffect(() => () => stopBgm(), []);

  // 테트리스 강도(위기/레벨) → 템포·레이어. hud 는 8Hz로 바뀌므로 **구독만** 하고 리렌더는 안 한다
  // (useTetrisStore 를 셀렉터로 읽으면 아레나 전체가 같이 리렌더돼 손맛이 죽는다).
  useEffect(() => {
    if (bgmTrack !== 'tetris') { setBgmIntensity(0); return; }
    const apply = (hud: { danger: number; level: number }) =>
      setBgmIntensity(Math.max(hud.danger, Math.min(1, (hud.level - 1) / 9)));
    apply(useTetrisStore.getState().hud);
    return useTetrisStore.subscribe((cur, prev) => {
      if (cur.hud !== prev.hud) apply(cur.hud);
    });
  }, [bgmTrack]);
  // 아직 입장/관전을 고르지 않았으면 Idle 카드를 보여 준다(스냅샷 구독으로 자동 갱신).
  const myUserId = useAuthStore((s) => s.userId);
  const joined = !!snapshot && (
    snapshot.players.some((p) => p.userId === myUserId)
    || snapshot.spectators.some((p) => p.userId === myUserId)
  );
  const packChosen = useGameStore((s) => s.packChosen);

  // 방장: 팩을 고르기 전까지 선택 화면. 비방장: 방장이 혼자 있는 동안 "고르는 중" 대기.
  const needsPack = !!snapshot && !packChosen && (
    snapshot.hostUserId === myUserId || snapshot.players.length <= 1
  );

  // 패널이 화면에 그리는 피드 = 각 참가자(플레이어+관전자)의 **첫 번째** 카메라 피드.
  // 팩 선택·로비·아레나 모두 같은 규칙으로 그리므로 숨은 싱크는 "그 외 전부"가 된다.
  const attachedIds = new Set<string>();
  if (snapshot && joined) {
    const pickFor = (uid: string) => feeds.find((f) => f.userId === uid && !f.isScreen);
    for (const p of snapshot.players) { const f = pickFor(p.userId); if (f) attachedIds.add(f.id); }
    for (const sp of snapshot.spectators) { const f = pickFor(sp.userId); if (f) attachedIds.add(f.id); }
  }
  const hiddenSinks = feeds.filter((f) => !f.isScreen && !!f.audioTrack && !attachedIds.has(f.id));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass flex h-full min-h-0 w-full flex-col overflow-hidden rounded-feed"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-3 py-2">
        <Gamepad2 size={16} className="text-primary" />
        <span className="text-sm font-semibold">
          {snapshot ? GAME_LABEL[snapshot.gameId] ?? '게임 방' : '게임 방'}
        </span>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-white/50">
          {phaseLabel(snapshot)}
        </span>
        <button
          data-ghc-bgm={bgmOn ? 'on' : 'off'}
          onClick={() => { initGameAudio(); toggleBgm(); }}
          className="ml-auto text-white/40 transition-colors hover:text-white"
          title={bgmOn ? '음악 끄기' : '음악 켜기'}
        >
          {bgmOn ? <Music size={16} /> : <Music2 size={16} className="opacity-50" />}
        </button>
        <button
          onClick={closePanel}
          className="text-white/40 transition-colors hover:text-white"
          title="게임 패널 닫기"
        >
          <X size={18} />
        </button>
      </div>

      {/* 패널 안에서 보이지 않는 카메라 피드의 **소리만** 유지하는 숨은 싱크.
          RoomPage의 비디오 컬럼이 꺼져 있으므로(= 이 트랙들의 유일한 attach 지점) 필요하다.
          보이는 피드는 프로필/관전자 스트립이 이미 attach 하므로 여기서 제외한다(중복 attach 금지). */}
      <div className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0">
        {hiddenSinks.map((f) => (
          <ProfileVideo key={f.id} feed={f} color="#000000" label="" className="h-1 w-1" />
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {!snapshot || !joined ? (
          <GameIdle snapshot={snapshot} />
        ) : snapshot.phase === 'lobby' && needsPack ? (
          /* 팩 선택은 로컬 UI 단계 — 방장이 고르면 모두 그 팩 방으로 들어간다 */
          <PackSelect isHost={snapshot.hostUserId === myUserId} snapshot={snapshot} feeds={feeds} />
        ) : snapshot.phase === 'lobby' ? (
          <GameLobby snapshot={snapshot} feeds={feeds} />
        ) : snapshot.gameId === 'tetris' ? (
          <TetrisArena snapshot={snapshot} feeds={feeds} />
        ) : (
          <ShisenArena snapshot={snapshot} feeds={feeds} />
        )}
      </div>
    </motion.div>
  );
}
