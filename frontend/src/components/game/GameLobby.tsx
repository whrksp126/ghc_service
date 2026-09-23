import { useState } from 'react';
import { Crown, Eye, LogOut, UserPlus, Volume2, VolumeX, X } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { Button } from '../common/Button';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { ShisenSettings } from './ShisenSettings';
import { MapGuide } from './MapGuide';
import { RoomLog } from './RoomLog';
import { Scoreboard } from './Scoreboard';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import { MAX_PLAYERS, type GameMode, type GameOptions, type GameSnapshot } from '../../games/types';

/**
 * 사천성 방(로비) — 넷마블식 3컬럼 (v3 §W3).
 * 좌: 플레이어 / 중: 설정 + 게임시작 / 우: 맵 가이드. 하단: 방 로그 + 나가기·방 닫기.
 * 모바일에서는 같은 순서로 세로 스택.
 */
export function GameLobby({ snapshot, feeds = [] }: { snapshot: GameSnapshot; feeds?: GameFeed[] }) {
  const myUserId = useAuthStore((s) => s.userId);
  const soundOn = useUIStore((s) => s.gameSoundOn);
  const toggleSound = useUIStore((s) => s.toggleGameSound);
  const [busy, setBusy] = useState(false);

  const isHost = snapshot.hostUserId === myUserId;
  const amPlayer = snapshot.players.some((p) => p.userId === myUserId);
  const full = snapshot.players.length >= MAX_PLAYERS;

  const call = async (event: string, payload: unknown = {}) => {
    setBusy(true);
    try {
      await emitWithAck(event, payload);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '요청에 실패했어요', 'error');
    } finally {
      setBusy(false);
    }
  };

  // options는 서버에서 부분 병합된다.
  const patchOptions = (patch: Partial<GameOptions>) => call('game:updateOptions', { options: patch });
  const winsOf = (userId: string) => snapshot.scoreboard.find((r) => r.userId === userId);
  /** 아레나 프로필 카드와 **같은 규칙**으로 그 사람의 첫 카메라 피드를 고른다(attach 1회 보장). */
  const feedFor = (userId: string) => feeds.find((f) => f.userId === userId && !f.isScreen);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-3">
      <div className="flex shrink-0 flex-col gap-2 lg:flex-row">
        {/* 좌: 플레이어 컬럼 */}
        <div className="flex shrink-0 flex-col gap-2 lg:w-[240px]">
          <div className="flex items-center gap-2 px-1">
            <span className="text-xs text-white/50">플레이어 {snapshot.players.length}/{MAX_PLAYERS}</span>
            <button
              onClick={toggleSound}
              className="ml-auto text-white/40 transition-colors hover:text-white"
              title={soundOn ? '효과음 끄기' : '효과음 켜기'}
            >
              {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
          </div>

          {/* 슬롯 4개 — 카드마다 그 사람 카메라(없으면 색 이니셜). 모바일은 가로 스트립. */}
          <div className="flex gap-2 overflow-x-auto scrollbar-none lg:grid lg:grid-cols-2 lg:overflow-visible">
            {Array.from({ length: MAX_PLAYERS }).map((_, i) => {
              const p = snapshot.players[i];
              const record = p ? winsOf(p.userId) : undefined;
              return (
                <div
                  key={i}
                  className={`w-[150px] shrink-0 rounded-feed p-1.5 lg:w-auto ${
                    p ? 'bg-white/5' : 'border border-dashed border-white/10'
                  }`}
                  style={p ? { boxShadow: `inset 0 0 0 1px ${p.color}44` } : undefined}
                >
                  {p ? (
                    <>
                      <div className="relative mb-1 aspect-video w-full overflow-hidden rounded-lg bg-black/40">
                        <ProfileVideo
                          feed={feedFor(p.userId)}
                          color={p.color}
                          label={p.nickname}
                          className="h-full w-full"
                        />
                        <span
                          className="absolute right-1 top-1 h-2 w-2 rounded-full bg-success"
                          title="대기 중"
                        />
                      </div>
                      <div className="flex items-center gap-1 px-0.5">
                        <span className="min-w-0 truncate text-[11px] text-white/90">{p.nickname}</span>
                        {p.userId === snapshot.hostUserId && <Crown size={11} className="shrink-0 text-warning" />}
                        {p.userId === myUserId && <span className="shrink-0 text-[10px] text-white/35">나</span>}
                      </div>
                      <p className="px-0.5 text-[10px] text-white/35">
                        오늘 {record?.wins ?? 0}승 / {record?.games ?? 0}판
                      </p>
                    </>
                  ) : (
                    <div className="flex aspect-video w-full items-center justify-center text-[11px] text-white/25">
                      빈 자리
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 관전자 — 작은 카메라 타일 스트립 */}
          {snapshot.spectators.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none px-0.5">
              <Eye size={12} className="shrink-0 text-white/35" />
              {snapshot.spectators.map((sp) => (
                <div key={sp.userId} className="w-[96px] shrink-0">
                  <div className="aspect-video w-full overflow-hidden rounded-lg bg-black/40">
                    <ProfileVideo
                      feed={feedFor(sp.userId)}
                      color="#9CA3AF"
                      label={sp.nickname}
                      className="h-full w-full"
                    />
                  </div>
                  <p className="truncate text-center text-[10px] text-white/50">{sp.nickname}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 중: 설정 */}
        <div className="min-w-0 flex-1">
          <ShisenSettings
            mode={snapshot.mode}
            options={snapshot.options}
            seed={snapshot.seed}
            canEdit={isHost}
            busy={busy}
            canStart={isHost && snapshot.players.length >= 1}
            onMode={(mode: GameMode) => call('game:updateOptions', { mode })}
            onOptions={patchOptions}
            onStart={() => call('game:start')}
          />
        </div>

        {/* 우: 맵 가이드 */}
        <div className="shrink-0 lg:w-[220px]">
          <MapGuide options={snapshot.options} seed={snapshot.seed} />
        </div>
      </div>

      {/* 하단: 로그 + 액션 + 전적 */}
      <RoomLog />
      <div className="flex flex-wrap items-center gap-2">
        {amPlayer ? (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => call('game:spectate')}>
            <LogOut size={14} /> 나가기
          </Button>
        ) : (
          <Button size="sm" variant="secondary" loading={busy} disabled={full} onClick={() => call('game:join')}>
            <UserPlus size={14} /> {full ? '자리가 없어요' : '입장'}
          </Button>
        )}
        {isHost && (
          <Button size="sm" variant="ghost" loading={busy} onClick={() => call('game:close')}>
            <X size={14} /> 방 닫기
          </Button>
        )}
      </div>
      <Scoreboard rows={snapshot.scoreboard} />
    </div>
  );
}
