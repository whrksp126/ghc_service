import { useEffect, useRef } from 'react';
import { getSocket, emitWithAck } from '../lib/socket';
import { useGameStore } from '../stores/gameStore';
import { useAuthStore } from '../stores/authStore';
import { showToast } from '../components/common/Toast';
import { playGameSound } from '../games/sounds';
import { keyTypeOfEvent } from '../games/v3';
import type { GameSnapshot } from '../games/types';
import type {
  AttackEvent, MatchedEvent, PeerSelectEvent, ShuffledEvent, TilesEvent,
} from '../games/events';

/**
 * 스냅샷 적용 + 패널 자동 오픈 규칙.
 * 새로고침 복구(`game:sync`)와 브로드캐스트(`game:state`)가 **같은 규칙**을 써야
 * "진행 중인 판인데 패널이 안 열림" 같은 차이가 생기지 않는다.
 */
/** 스냅샷 차이로 방 로그를 만든다 (v3 §W3 — 서버 이벤트 없이 클라가 생성). */
function logDiff(prev: GameSnapshot | null, next: GameSnapshot): void {
  const push = useGameStore.getState().pushLog;
  if (!prev) return;
  const prevIds = new Set(prev.players.map((p) => p.userId));
  const nextIds = new Set(next.players.map((p) => p.userId));
  for (const p of next.players) if (!prevIds.has(p.userId)) push(`${p.nickname}님이 입장했어요`);
  for (const p of prev.players) if (!nextIds.has(p.userId)) push(`${p.nickname}님이 나갔어요`);
  const prevSpec = new Set(prev.spectators.map((p) => p.userId));
  for (const s of next.spectators) if (!prevSpec.has(s.userId)) push(`${s.nickname}님이 관전으로 전환했어요`);
  if (prev.hostUserId !== next.hostUserId) {
    const host = next.players.find((p) => p.userId === next.hostUserId);
    push(`${host?.nickname ?? '새 방장'}님이 방장이 되었어요`);
  }
  if (prev.mode !== next.mode) push(`대전 방식이 ${next.mode === 'coop' ? '쟁탈전' : '레이스'}(으)로 바뀌었어요`);
  const a = prev.options; const b = next.options;
  if (a.boardSize !== b.boardSize || a.mapShape !== b.mapShape) push('맵 설정이 바뀌었어요');
  if (a.difficulty !== b.difficulty) push(`난이도가 ${b.difficulty}로 바뀌었어요`);
  if (JSON.stringify(a.specials) !== JSON.stringify(b.specials)) push('특수 타일 설정이 바뀌었어요');
  if (a.timeLimitSec !== b.timeLimitSec || a.items !== b.items) push('경기 옵션이 바뀌었어요');
  if (prev.phase !== next.phase && next.phase === 'countdown') push('게임을 시작합니다!');
  if (prev.phase !== next.phase && next.phase === 'finished') push('게임이 끝났어요');
}

function applyState(state: GameSnapshot | null): void {
  const store = useGameStore.getState();
  const prev = store.snapshot;
  store.applySnapshot(state);
  if (state) logDiff(prev, state);
  if (!state) return;
  const myId = useAuthStore.getState().userId;
  const amPlayer = state.players.some((p) => p.userId === myId);
  if (amPlayer && (state.phase === 'countdown' || state.phase === 'playing')) {
    store.openPanel();
  }
}

/** 다른 곳(컴포넌트)에서도 쓰는 재동기화 헬퍼. 서버 스냅샷이 언제나 권위다. */
export async function syncGame(): Promise<void> {
  try {
    const res = await emitWithAck<{ state: GameSnapshot | null }>('game:sync', {});
    applyState(res.state ?? null);
  } catch {
    /* 방 밖이거나 서버가 잠깐 끊긴 것 — 다음 기회에 다시 맞춘다. */
  }
}

/**
 * 방 안(`phase === 'inRoom'`)에서만 마운트되는 게임 소켓 구독.
 * `socket.off(ev).on(ev, …)` 관례 — 중복 구독이 생기지 않는다.
 */
export function useGameSocket(active: boolean) {
  // 토스트 중복 방지용: 마지막으로 알림을 띄운 게임(호스트+시작 시각)
  const notifiedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const socket = getSocket();
    const store = useGameStore;

    const onState = (payload: { state: GameSnapshot | null }) => {
      const prev = store.getState().snapshot;
      const next = payload?.state ?? null;
      const myId = useAuthStore.getState().userId;
      applyState(next);

      if (!next) {
        if (prev) {
          store.getState().reset();
          store.getState().closePanel();
          showToast('게임이 종료되었습니다', 'info');
        }
        notifiedRef.current = null;
        return;
      }

      // 누군가 새로 게임을 열었다 → 패널이 닫혀 있는 사람에게 알림
      const key = `${next.hostUserId}:${next.seed}`;
      if (!prev && next.hostUserId !== myId && notifiedRef.current !== key) {
        notifiedRef.current = key;
        if (!store.getState().isPanelOpen) {
          const host = next.players.find((p) => p.userId === next.hostUserId);
          showToast(`🎮 ${host?.nickname ?? '누군가'}님이 사천성 방을 열었어요`, 'info');
        }
      }
    };

    const onMatched = (e: MatchedEvent) => {
      if (!store.getState().applyMatched(e)) void syncGame();
      // 서버가 막힘을 풀려고 한 쌍 정리한 경우(v2 §V3)
      if (e.userId === 'system' && store.getState().myBoard()?.id === e.boardId) {
        showToast('막혀서 한 쌍 정리했어요', 'info');
      }
    };
    const onUnlocked = (e: TilesEvent) => {
      if (!store.getState().applyTiles(e, 'unlock')) void syncGame();
      if (store.getState().myBoard()?.id === e.boardId) {
        playGameSound('unlock');
        const k = keyTypeOfEvent(e);
        store.getState().setBanner(`${['빨강', '파랑', '초록'][k - 1] ?? ''} 자물쇠가 열렸어요`);
      }
    };
    const onShuffled = (e: ShuffledEvent) => {
      if (!store.getState().applyShuffled(e)) void syncGame();
      const mine = store.getState().myBoard()?.id === e.boardId;
      if (mine) playGameSound('shuffle');
      // 공격으로 섞인 건 피격 연출이 따로 있으므로 배너는 '막힘'일 때만(v2.1).
      if (e.cause === 'stuck' && mine) store.getState().setBanner('연결할 수 있는 타일이 없어 재배치했어요');
      if (e.cause === 'item' && mine) store.getState().setBanner('타일을 재배치했어요');
    };
    const onAttack = (e: AttackEvent) => {
      if (!store.getState().applyAttack(e)) void syncGame();
    };
    const onPeerSelect = (e: PeerSelectEvent) => store.getState().applyPeerSelect(e);

    socket.off('game:state').on('game:state', onState);
    socket.off('game:matched').on('game:matched', onMatched);
    socket.off('game:shuffled').on('game:shuffled', onShuffled);
    socket.off('game:attack').on('game:attack', onAttack);
    socket.off('game:peerSelect').on('game:peerSelect', onPeerSelect);
    socket.off('game:unlocked').on('game:unlocked', onUnlocked);

    void syncGame();

    // 재접속 시 RoomPage가 room:join을 다시 보낸다. 그 뒤에 상태를 다시 받아 온다.
    // (RoomPage의 reconnect 리스너를 지우지 않도록 반드시 핸들러 참조로 off 한다.)
    const onReconnect = () => { setTimeout(() => { void syncGame(); }, 1200); };
    socket.io.on('reconnect', onReconnect);

    return () => {
      socket.off('game:state', onState);
      socket.off('game:matched', onMatched);
      socket.off('game:shuffled', onShuffled);
      socket.off('game:attack', onAttack);
      socket.off('game:peerSelect', onPeerSelect);
      socket.off('game:unlocked', onUnlocked);
      socket.io.off('reconnect', onReconnect);
    };
  }, [active]);

  // 방을 나가면 게임 상태도 비운다(다음 방에서 남은 스냅샷이 보이지 않도록).
  useEffect(() => {
    if (active) return;
    useGameStore.getState().reset();
    useGameStore.getState().closePanel();
  }, [active]);
}
