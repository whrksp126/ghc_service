import { useRef, useState } from 'react';
import { Check, Crown, Eye, LogOut, UserPlus, Volume2, VolumeX, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { Button } from '../common/Button';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { ShisenSettings } from './ShisenSettings';
import { TetrisSettings } from './TetrisSettings';
import { MapGuide } from './MapGuide';
import { TetrisGuide } from './TetrisGuide';
import { RoomLog } from './RoomLog';
import { Scoreboard } from './Scoreboard';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import { PROFILE_CARD_CLASS, PROFILE_COL_CLASS, PROFILE_LIST_CLASS, useProfileFit } from './ProfileColumn';
import { MAX_PLAYERS, type GameMode, type GameOptions, type GameSnapshot, type PlayerState } from '../../games/types';
import { DEFAULT_TETRIS_OPTIONS, type TetrisOptions } from '../../games/tetris/types';

/**
 * 로비 카드에서 카메라를 뺀 나머지(닉네임 줄 + 전적 줄 + 패딩)의 대략 높이.
 * `useProfileFit` 이 이 값을 빼고 카메라 높이를 정한다 — 아레나와 같은 방식.
 */
const LOBBY_CHROME = 48;

/** 빈 슬롯 카메라 자리 높이(px) — 사람 자리보다 낮게 둬서 공간을 덜 먹는다. */
const EMPTY_CAM = 56;

/**
 * 사천성/테트리스 방(로비) — 넷마블식 3컬럼 (v3 §W3, v6 §Z2·Z3·Z5).
 * 좌: 플레이어(한 줄에 한 사람, 카메라 크게) / 중: 설정 + 게임시작·준비 / 우: 가이드 + 방 기록 + 전적.
 * **하단 바(나가기·방 닫기)는 패널 바닥에 고정**한다 — 창이 짧아도 화면 밖으로 밀려나면 안 된다(§Z2).
 * 모바일에서는 같은 순서로 세로 스택(본문 전체가 스크롤).
 */
export function GameLobby({ snapshot, feeds = [] }: { snapshot: GameSnapshot; feeds?: GameFeed[] }) {
  const myUserId = useAuthStore((s) => s.userId);
  const soundOn = useUIStore((s) => s.gameSoundOn);
  const toggleSound = useUIStore((s) => s.toggleGameSound);
  const [busy, setBusy] = useState(false);
  // 프로필 컬럼 높이를 재서 카메라 크기를 정한다(아레나와 같은 규칙 재사용).
  // **빈 슬롯까지 4등분하면 카메라가 쪼그라든다** → 실제 인원 기준(최소 2)으로 크기를 잡고,
  // 남는 빈 자리는 컬럼 스크롤로 밀어 둔다. 사람이 늘면 자동으로 줄어든다.
  const profileRef = useRef<HTMLDivElement>(null);
  const fit = useProfileFit(profileRef, Math.max(2, snapshot.players.length), LOBBY_CHROME);

  const isHost = snapshot.hostUserId === myUserId;
  const me = snapshot.players.find((p) => p.userId === myUserId);
  const amPlayer = !!me;
  const full = snapshot.players.length >= MAX_PLAYERS;

  // 준비 규칙(§Z3): 방장을 뺀 **모든 플레이어**가 준비해야 시작할 수 있다.
  // 방장이 시작 버튼을 누르는 것 자체가 방장의 동의이므로 방장은 준비 대상이 아니다.
  const others = snapshot.players.filter((p) => p.userId !== snapshot.hostUserId);
  const readyCount = others.filter((p) => p.ready).length;
  const allReady = readyCount === others.length;
  const canStart = isHost && snapshot.players.length >= 1 && allReady;
  // 버튼이 왜 잠겼는지 방장이 바로 알 수 있게 한 줄로 알려 준다.
  const startHint = allReady ? undefined : `준비 대기 중 (${readyCount}/${others.length})`;

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
  // 테트리스 설정은 별도 키로 올라간다(설계서 §T3 — `{ gameId:'tetris', tetris: patch }`).
  const patchTetris = (patch: Partial<TetrisOptions>) =>
    call('game:updateOptions', { gameId: 'tetris', tetris: patch });
  const isTetris = snapshot.gameId === 'tetris';
  const tetrisOptions = snapshot.tetris ?? DEFAULT_TETRIS_OPTIONS.versus;
  const winsOf = (userId: string) => snapshot.scoreboard.find((r) => r.userId === userId);
  /** 아레나 프로필 카드와 **같은 규칙**으로 그 사람의 첫 카메라 피드를 고른다(attach 1회 보장). */
  const feedFor = (userId: string) => feeds.find((f) => f.userId === userId && !f.isScreen);

  /** 카드 우상단 상태 배지 — 방장은 준비 대상이 아니라 `방장`, 나머지는 READY/대기 중. */
  const statusBadge = (p: PlayerState) => {
    if (p.userId === snapshot.hostUserId) {
      return (
        <span className="absolute right-1 top-1 rounded bg-warning/85 px-1 py-0.5 text-[9px] font-bold text-dark-900">
          방장
        </span>
      );
    }
    return p.ready ? (
      <span
        data-ghc-ready-badge={p.userId}
        className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-success px-1 py-0.5 text-[9px] font-black text-dark-900"
      >
        <Check size={9} strokeWidth={3} /> READY
      </span>
    ) : (
      <span
        data-ghc-ready-badge={p.userId}
        className="absolute right-1 top-1 rounded bg-black/55 px-1 py-0.5 text-[9px] font-medium text-white/45"
      >
        대기 중
      </span>
    );
  };

  return (
    // 바깥은 스크롤하지 않는다. 본문만 스크롤하고 하단 바는 항상 바닥에 붙어 있는다(§Z2).
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 lg:overflow-hidden">
        <div className="flex min-h-0 flex-col gap-2 lg:h-full lg:flex-row">
          {/* 좌: 플레이어 컬럼 — 한 줄에 한 사람, 카드가 컬럼 폭을 꽉 채운다(§Z5) */}
          <div className={`flex min-h-0 shrink-0 flex-col gap-2 ${PROFILE_COL_CLASS}`}>
            <div className="flex shrink-0 items-center gap-2 px-1">
              <span className="text-xs text-white/50">플레이어 {snapshot.players.length}/{MAX_PLAYERS}</span>
              <button
                onClick={toggleSound}
                className="ml-auto text-white/40 transition-colors hover:text-white"
                title={soundOn ? '효과음 끄기' : '효과음 켜기'}
              >
                {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
              </button>
            </div>

            {/* 슬롯 4개 — 카드마다 그 사람 카메라(없으면 색 이니셜). 모바일은 가로 스트립.
                이 래퍼가 **확정된 높이**를 주어야 `useProfileFit` 이 카메라 높이를 계산할 수 있다. */}
            <div className="min-h-0 lg:flex-1">
              <div ref={profileRef} data-ghc-profiles="" className={PROFILE_LIST_CLASS}>
                {Array.from({ length: MAX_PLAYERS }).map((_, i) => {
                  const p = snapshot.players[i];
                  const record = p ? winsOf(p.userId) : undefined;
                  return (
                    <div
                      key={i}
                      data-ghc-player={p?.userId}
                      className={`${PROFILE_CARD_CLASS} ${
                        p ? 'bg-white/5' : 'border border-dashed border-white/10'
                      }`}
                      style={p ? { boxShadow: `inset 0 0 0 ${p.userId === myUserId ? 2 : 1}px ${p.userId === myUserId ? p.color : `${p.color}44`}` } : undefined}
                    >
                      <div
                        className={`relative mb-1 w-full overflow-hidden rounded-lg ${
                          p ? 'bg-black/40' : 'bg-white/[0.02]'
                        } ${fit.cam == null ? 'aspect-video' : ''}`}
                        /* 빈 자리는 폭만 같게 두고 높이는 줄인다 — 사람 카메라가 더 커진다 */
                        style={fit.cam == null ? undefined : { height: p ? fit.cam : Math.min(fit.cam, EMPTY_CAM) }}
                      >
                        {p ? (
                          <>
                            <ProfileVideo
                              feed={feedFor(p.userId)}
                              color={p.color}
                              label={p.nickname}
                              className="h-full w-full"
                            />
                            {statusBadge(p)}
                          </>
                        ) : null}
                      </div>
                      {p ? (
                        <>
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
                        /* 빈 슬롯도 **같은 폭·같은 줄 수**를 유지해야 카드 높이 계산이 어긋나지 않는다 */
                        <>
                          <p className="px-0.5 text-[11px] text-white/30">빈 자리</p>
                          <p className="px-0.5 text-[10px] text-white/15">입장을 기다려요</p>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 관전자 — 작은 카메라 타일 스트립(§Z5에서 유지) */}
            {snapshot.spectators.length > 0 && (
              <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto scrollbar-none px-0.5">
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

          {/* 중: 설정 + 시작/준비 — 팩에 따라 패널만 갈아 끼운다(좌측 카메라/관전자는 공용) */}
          <div className="flex min-w-0 flex-1 flex-col gap-2 lg:h-full lg:min-h-0 lg:overflow-y-auto">
            {isTetris ? (
              <TetrisSettings
                options={tetrisOptions}
                canEdit={isHost}
                busy={busy}
                canStart={canStart}
                startHint={startHint}
                onOptions={patchTetris}
                onStart={() => call('game:start')}
              />
            ) : (
              <ShisenSettings
                mode={snapshot.mode}
                options={snapshot.options}
                seed={snapshot.seed}
                canEdit={isHost}
                busy={busy}
                canStart={canStart}
                startHint={startHint}
                onMode={(mode: GameMode) => call('game:updateOptions', { mode })}
                onOptions={patchOptions}
                onStart={() => call('game:start')}
              />
            )}

            {/* 준비 토글 — 방장이 아닌 **플레이어**에게만 보인다(관전자는 준비 대상이 아니다) */}
            {amPlayer && !isHost && (
              <motion.button
                type="button"
                data-ghc-ready=""
                whileTap={{ scale: 0.98 }}
                disabled={busy}
                onClick={() => call('game:ready', { ready: !me?.ready })}
                /* 설정이 길어 가운데 컬럼이 스크롤돼도 준비 버튼은 바닥에 붙어 항상 보인다 */
                className={`sticky bottom-0 z-10 flex w-full shrink-0 flex-col items-center gap-0.5 rounded-feed py-3 transition-colors shadow-[0_-10px_18px_-10px_rgba(0,0,0,0.75)] ${
                  me?.ready
                    ? 'bg-success text-dark-900 hover:bg-success/90'
                    : 'bg-primary text-white hover:bg-primary-hover'
                } ${busy ? 'opacity-50' : ''}`}
              >
                <span className="flex items-center gap-2 font-display text-xl font-black">
                  {me?.ready ? <><Check size={20} strokeWidth={3} /> 준비 완료</> : '준비'}
                </span>
                <span className={`text-[10px] ${me?.ready ? 'text-dark-900/60' : 'text-white/60'}`}>
                  {me?.ready ? '다시 누르면 준비를 취소해요' : '준비를 눌러야 방장이 시작할 수 있어요'}
                </span>
              </motion.button>
            )}

            {/* 방장도 내 상태가 궁금하다 — 누가 안 눌렀는지 한 줄로 */}
            {isHost && others.length > 0 && (
              <p className={`shrink-0 px-1 text-[11px] ${allReady ? 'text-success' : 'text-white/45'}`}>
                {allReady
                  ? '모두 준비됐어요. 시작할 수 있습니다.'
                  : `준비 대기 중 (${readyCount}/${others.length}) — ${others.filter((p) => !p.ready).map((p) => p.nickname).join(', ')}`}
              </p>
            )}
          </div>

          {/* 우: 가이드 + 방 기록 + 전적 */}
          <div className="flex shrink-0 flex-col gap-2 lg:h-full lg:min-h-0 lg:w-[220px] lg:overflow-y-auto">
            {isTetris
              ? <TetrisGuide options={tetrisOptions} />
              : <MapGuide options={snapshot.options} seed={snapshot.seed} />}
            <RoomLog />
            <Scoreboard rows={snapshot.scoreboard} />
          </div>
        </div>
      </div>

      {/* 하단 바 — 패널 바닥 고정. 본문이 아무리 길어도, 창이 아무리 짧아도 항상 보인다(§Z2). */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/5 bg-dark-900/80 px-3 py-2">
        {amPlayer ? (
          <Button size="sm" variant="secondary" loading={busy} data-ghc-exit="" onClick={() => call('game:spectate')}>
            <LogOut size={14} /> 나가기
          </Button>
        ) : (
          <Button size="sm" variant="secondary" loading={busy} disabled={full} data-ghc-join="" onClick={() => call('game:join')}>
            <UserPlus size={14} /> {full ? '자리가 없어요' : '입장'}
          </Button>
        )}
        {isHost && (
          <Button size="sm" variant="ghost" loading={busy} data-ghc-close-room="" onClick={() => call('game:close')}>
            <X size={14} /> 방 닫기
          </Button>
        )}
      </div>
    </div>
  );
}
