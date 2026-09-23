import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useAnimationControls } from 'framer-motion';
import { Eye, Keyboard, LogOut, Volume2, VolumeX } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { useAuthStore } from '../../stores/authStore';
import { useGameStore } from '../../stores/gameStore';
import { useUIStore } from '../../stores/uiStore';
import { useTetrisStore } from '../../stores/tetrisStore';
import { useTetrisGame, useTetrisSpectate } from '../../hooks/useTetrisGame';
import { prefersReducedMotion } from '../../games/motion';
import { ThemeBackdrop, themeOf } from './ArenaTheme';
import { Countdown } from './Countdown';
import { ResultsOverlay } from './ResultsOverlay';
import { ComboBurst } from './ComboBurst';
import { AttackFxLayer } from './AttackFx';
import { TetrisCanvas, PiecePreview } from './TetrisCanvas';
import { TetrisMiniBoard } from './TetrisMiniBoard';
import { TetrisHud } from './TetrisHud';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import { DEFAULT_TETRIS_OPTIONS, TETRIS_MODE_LABEL, type TetrisOptions } from '../../games/tetris/types';
import { KEY_GUIDE, TETRIS_MODE_DESC } from '../../games/tetris/ui';
import type { GameSnapshot, PlayerState } from '../../games/types';

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 제한 시간이 있으면 카운트다운, 없으면 카운트업. */
function ArenaClock({ snapshot, opts }: { snapshot: GameSnapshot; opts: TetrisOptions }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  if (!snapshot.startAt) return null;
  const end = snapshot.endedAt ?? now;
  const value = opts.timeLimitSec > 0
    ? snapshot.startAt + opts.timeLimitSec * 1000 - end
    : end - snapshot.startAt;
  const urgent = opts.timeLimitSec > 0 && value < 30000;
  return (
    <span className={`font-display tabular-nums ${urgent ? 'text-primary' : 'text-white/70'}`}>
      {fmtClock(value)}
    </span>
  );
}

/** 상단 카운터 칸 — 사천성 TopCounterBar 와 같은 톤(작은 라벨 + 큰 숫자). */
function Cell({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex min-w-[64px] flex-col items-start gap-0.5 rounded-lg bg-black/40 px-2.5 py-1.5">
      <span className="text-[10px] leading-none text-white/45">{label}</span>
      <span className={`font-display text-xl font-black leading-none tabular-nums ${tone ?? 'text-white'}`}>
        {value}
      </span>
    </div>
  );
}

/** 우측 세로 위험도 게이지 — 위험선(16행)을 넘으면 빨갛게 차오르고 맥박한다. */
function DangerGauge({ value }: { value: number }) {
  const hot = value >= 0.8;
  return (
    <div className="relative hidden w-[18px] shrink-0 lg:block">
      <div className="absolute inset-y-0 right-0 w-[14px] overflow-hidden rounded-full bg-black/70 ring-1 ring-white/10">
        {/* 위험선 눈금 */}
        <span className="absolute inset-x-0 h-px bg-danger/60" style={{ bottom: '80%' }} />
        <motion.div
          className="absolute inset-x-0 bottom-0 rounded-full"
          style={{ background: hot ? 'linear-gradient(0deg,#EF4444,#FE2C55)' : 'linear-gradient(0deg,#25F4EE,#4ADE80)' }}
          animate={{
            height: `${Math.max(2, value * 100)}%`,
            opacity: hot ? [1, 0.55, 1] : 1,
          }}
          transition={{ height: { duration: 0.25 }, opacity: { duration: 0.6, repeat: hot ? Infinity : 0 } }}
        />
      </div>
    </div>
  );
}

/** 좌측 프로필 카드 — 카메라 + 지운 줄 + KO (사천성 v4 ProfileVideo 재사용). */
function TetrisProfile({
  player, feed, isMe, lines, ko, alive, strip,
}: {
  player: PlayerState; feed?: GameFeed; isMe: boolean;
  lines: number; ko: number; alive: boolean; strip?: boolean;
}) {
  return (
    <div
      data-ghc-player={player.userId}
      className={`${strip ? 'w-[118px] shrink-0 lg:w-auto' : 'w-full'} rounded-xl p-1.5 ${
        isMe ? 'bg-white/10' : 'bg-white/5'
      } ${alive ? '' : 'opacity-50'}`}
      style={{ boxShadow: `inset 0 0 0 ${isMe ? 2 : 1}px ${isMe ? player.color : `${player.color}44`}` }}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black/40">
        <ProfileVideo feed={feed} color={player.color} label={player.nickname} className="h-full w-full" />
        {!alive && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/55 font-display text-[11px] font-black italic text-white/90">
            K.O.
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1 px-0.5">
        <span className="min-w-0 flex-1 truncate text-[11px] text-white/90">{player.nickname}</span>
        {isMe && <span className="shrink-0 text-[10px] text-white/35">나</span>}
      </div>
      <div className="flex items-end gap-1.5 px-0.5">
        <span className="text-[9px] leading-none text-white/40">줄</span>
        <span className="font-display text-base font-black leading-none tabular-nums text-white">{lines}</span>
        {ko > 0 && (
          <span className="ml-auto rounded bg-primary/80 px-1 text-[9px] font-bold text-white">K.O. {ko}</span>
        )}
      </div>
    </div>
  );
}

/**
 * 테트리스 인게임 화면 (설계서 §T6).
 * 좌 프로필 · 가운데 내 보드(HOLD/NEXT) · 우 상대 미니보드 + 위험도 게이지 · 하단 관전자 스트립.
 * `lg` 미만(모바일)은 **조작 UI 없이 관전 레이아웃**으로 떨어진다(사용자 결정 사항).
 */
export function TetrisArena({ snapshot, feeds = [] }: { snapshot: GameSnapshot; feeds?: GameFeed[] }) {
  const myUserId = useAuthStore((s) => s.userId);
  const closePanel = useGameStore((s) => s.closePanel);
  const soundOn = useUIStore((s) => s.gameSoundOn);
  const toggleSound = useUIStore((s) => s.toggleGameSound);
  const hud = useTetrisStore((s) => s.hud);
  const frames = useTetrisStore((s) => s.frames);
  const kos = useTetrisStore((s) => s.kos);
  const banner = useTetrisStore((s) => s.banner);
  const helpOpen = useTetrisStore((s) => s.helpOpen);
  const fxQueue = useTetrisStore((s) => s.fxQueue);
  const setHelpOpen = useTetrisStore((s) => s.setHelpOpen);
  const arenaRef = useRef<HTMLDivElement>(null);
  const shake = useAnimationControls();
  const reduced = prefersReducedMotion();

  const opts = snapshot.tetris ?? DEFAULT_TETRIS_OPTIONS.versus;
  const theme = themeOf(snapshot.seed);
  const me = snapshot.players.find((p) => p.userId === myUserId);
  const amPlayer = !!me;
  const playing = snapshot.phase === 'playing';
  const spectating = !amPlayer;
  // 관전자는 내 판이 없다 → 모든 플레이어 판을 가운데에 크게 늘어놓는다.
  const others = (spectating ? snapshot.players : snapshot.players.filter((p) => p.userId !== myUserId))
    .slice(0, spectating ? 4 : 3);
  const deadIds = new Set(kos.map((k) => k.userId));

  // 시뮬·입력·소켓은 전부 훅이 소유한다. 관전자는 프레임만 구독한다.
  useTetrisGame(snapshot);
  useTetrisSpectate(!amPlayer);

  // 배너 2.5초 (사천성과 같은 수명).
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => useTetrisStore.getState().setBanner(null), 2500);
    return () => clearTimeout(t);
  }, [banner]);

  // 테트리스(4줄)·퍼펙트에서 화면을 크게 흔든다 — 같은 fx 를 두 번 흔들지 않도록 id 로 막는다.
  const shookRef = useRef(0);
  useEffect(() => {
    if (reduced) return;
    const hot = fxQueue.find((f) => f.type === 'screen' && f.id > shookRef.current);
    if (!hot) return;
    shookRef.current = hot.id;
    void shake.start({ x: [0, -6, 6, -4, 0], y: [0, 3, -3, 2, 0], transition: { duration: 0.22 } });
  }, [fxQueue, reduced, shake]);

  const linesOf = (p: PlayerState) =>
    p.userId === myUserId ? hud.lines : frames[p.userId]?.lines ?? p.lines ?? 0;
  const koOf = (p: PlayerState) =>
    p.userId === myUserId ? hud.ko : frames[p.userId]?.ko ?? p.ko ?? 0;
  const aliveOf = (p: PlayerState) =>
    p.userId === myUserId ? hud.alive : !deadIds.has(p.userId) && (frames[p.userId]?.alive ?? true);
  const feedFor = (userId: string) => feeds.find((f) => f.userId === userId && !f.isScreen);

  const forfeit = async () => {
    try { await emitWithAck('game:spectate', {}); } catch (err) {
      showToast(err instanceof Error ? err.message : '기권할 수 없어요', 'error');
    }
  };
  const leave = async () => {
    if (amPlayer && playing) await forfeit();
    closePanel();
  };

  const nextList = hud.next.slice(0, Math.max(1, opts.nextCount));
  const goalText = opts.mode === 'sprint' ? `${hud.lines} / ${opts.sprintLines}` : `${hud.lines}`;

  const minis = others.map((p) => (
    <TetrisMiniBoard
      key={p.userId}
      userId={p.userId}
      nickname={p.nickname}
      color={p.color}
      frame={frames[p.userId]}
      dead={deadIds.has(p.userId)}
      width={others.length > 2 ? 70 : 90}
    />
  ));

  return (
    <motion.div
      ref={arenaRef}
      animate={shake}
      className="relative isolate flex h-full min-h-0 flex-col gap-2 p-2"
    >
      <ThemeBackdrop theme={theme} seed={snapshot.seed} />

      {/* 상단 정보 바 */}
      <div className="flex shrink-0 items-stretch gap-1.5 overflow-x-auto scrollbar-none px-0.5">
        <Cell label={opts.mode === 'sprint' ? '목표' : '지운 줄'} value={goalText} tone="text-secondary" />
        <Cell label="레벨" value={hud.level} />
        <Cell label="점수" value={hud.score} />
        <Cell
          label="받을 줄"
          value={hud.pending}
          tone={hud.pending > 0 ? 'text-danger' : 'text-white/30'}
        />
        <div className="flex min-w-[68px] flex-col items-start gap-0.5 rounded-lg bg-black/40 px-2.5 py-1.5">
          <span className="text-[10px] leading-none text-white/45">시간</span>
          <ArenaClock snapshot={snapshot} opts={opts} />
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 self-center">
          {spectating && (
            <span className="rounded-full bg-black/35 px-2 py-1 text-[10px] text-white/45">관전 중</span>
          )}
          <span className="hidden rounded-full bg-black/35 px-2 py-1 text-[10px] text-white/50 sm:inline">
            {TETRIS_MODE_LABEL[opts.mode]}
          </span>
          <button
            onClick={() => setHelpOpen(!helpOpen)}
            className="rounded-full bg-black/35 p-1.5 text-white/50 transition-colors hover:text-white"
            title="조작 안내 (Esc)"
          >
            <Keyboard size={14} />
          </button>
          <button
            onClick={toggleSound}
            className="rounded-full bg-black/35 p-1.5 text-white/50 transition-colors hover:text-white"
            title={soundOn ? '효과음 끄기' : '효과음 켜기'}
          >
            {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>
        </span>
      </div>

      {/* DOM 에 같은 카드를 두 벌 그리지 않는다(= `data-ghc-*` 중복 매칭 방지).
          모바일은 가로 스트립, lg 부터 좌측 세로 컬럼으로 **같은 노드**가 재배치된다. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        {/* 좌(모바일=상단): 프로필 — 카메라 + 지운 줄 + KO */}
        <div className="flex shrink-0 gap-1.5 overflow-x-auto scrollbar-none lg:w-[140px] lg:flex-col lg:overflow-x-visible lg:overflow-y-auto">
          {snapshot.players.map((p) => (
            <TetrisProfile
              key={p.userId}
              player={p}
              feed={feedFor(p.userId)}
              isMe={p.userId === myUserId}
              lines={linesOf(p)}
              ko={koOf(p)}
              alive={aliveOf(p)}
              strip
            />
          ))}
        </div>

        {/* 중앙: HOLD · 내 보드 · NEXT (관전자는 모든 판을 나란히) */}
        <div className="flex min-h-0 min-w-0 flex-1 justify-center gap-2">
          {spectating ? (
            <div className="flex min-h-0 flex-1 flex-wrap items-start justify-center gap-2 overflow-y-auto">
              {snapshot.players.map((p) => (
                <TetrisMiniBoard
                  key={p.userId}
                  userId={p.userId}
                  nickname={p.nickname}
                  color={p.color}
                  frame={frames[p.userId]}
                  dead={deadIds.has(p.userId)}
                  width={snapshot.players.length > 2 ? 110 : 150}
                />
              ))}
              {snapshot.players.length === 0 && (
                <p className="self-center text-xs text-white/30">판을 준비하는 중…</p>
              )}
            </div>
          ) : (
          <>
          <div className="hidden w-[64px] shrink-0 flex-col gap-1 lg:flex">
            <p className="text-center text-[10px] tracking-widest text-white/40">HOLD</p>
            <div className="flex h-[34px] items-center justify-center rounded-lg bg-black/40">
              {hud.hold ? <PiecePreview id={hud.hold} box={56} dim={!opts.hold} /> : null}
            </div>
            {/* 받을 줄 경고 바 — 보드 왼쪽에서 빨갛게 차오른다 */}
            <div className="relative mt-1 min-h-0 flex-1 overflow-hidden rounded-full bg-black/50">
              <motion.div
                data-ghc-pending={hud.pending}
                className="absolute inset-x-0 bottom-0 rounded-full bg-gradient-to-t from-danger to-primary"
                animate={{
                  height: `${Math.min(100, hud.pending * 10)}%`,
                  opacity: hud.pending > 0 ? [1, 0.5, 1] : 0,
                }}
                transition={{ height: { duration: 0.2 }, opacity: { duration: 0.7, repeat: hud.pending > 0 ? Infinity : 0 } }}
              />
              {hud.pending > 0 && (
                <span className="absolute inset-x-0 bottom-1 text-center font-display text-[11px] font-black text-white">
                  +{hud.pending}
                </span>
              )}
            </div>
          </div>

          {/* data-ghc-board: AttackFxLayer 가 "나에게 날아오는" 투사체의 착탄점을 여기로 잡는다 */}
          <div
            data-ghc-board={myUserId ?? undefined}
            className="relative flex min-h-0 min-w-0 flex-1 justify-center lg:max-w-[min(46vh,320px)]"
          >
            <TetrisCanvas className="h-full w-full" />
          </div>

          <div className="hidden w-[64px] shrink-0 flex-col gap-1 lg:flex">
            <p className="text-center text-[10px] tracking-widest text-white/40">NEXT</p>
            <div className="flex flex-col gap-1 overflow-hidden">
              {nextList.map((id, i) => (
                <div key={`${id}-${i}`} className="flex h-[30px] items-center justify-center rounded-lg bg-black/35">
                  <PiecePreview id={id} box={52} dim={i > 0} />
                </div>
              ))}
            </div>
          </div>
          </>
          )}
        </div>

        {/* 우(모바일=하단): 상대 미니보드 + 위험도 게이지.
            **클릭해도 확대되지 않는다** — 내 판이 항상 가장 크다(사천성 v2.1 결정 계승). */}
        {!spectating && (
          <div className="flex shrink-0 items-start gap-1.5 overflow-x-auto scrollbar-none lg:overflow-visible">
            <div className="flex gap-1.5 lg:flex-col lg:overflow-y-auto">{minis}</div>
            <DangerGauge value={hud.danger} />
          </div>
        )}
      </div>

      {/* 모바일: 조작 UI 없이 관전 레이아웃(사용자 결정 사항) */}
      {!spectating && (
        <p className="flex shrink-0 items-center justify-center gap-1 rounded-full bg-black/40 px-2 py-1 text-[11px] text-white/55 lg:hidden">
          <Keyboard size={12} /> PC에서 플레이할 수 있어요 — 지금은 구경만 할 수 있어요
        </p>
      )}

      {/* 하단: 관전자 카메라 스트립 + 우하단 고정 나가기 */}
      <div className="relative flex shrink-0 items-center gap-2 px-1 text-[11px] text-white/45">
        <span className="hidden shrink-0 sm:inline">{TETRIS_MODE_DESC[opts.mode]}</span>
        <div className="mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none">
          {snapshot.spectators.length > 0 && <Eye size={12} className="shrink-0 text-white/35" />}
          {snapshot.spectators.map((s) => (
            <span key={s.userId} className="flex shrink-0 items-center gap-1 rounded-lg bg-white/5 px-1 py-1">
              <ProfileVideo
                feed={feedFor(s.userId)}
                color="#9CA3AF"
                label={s.nickname}
                rounded="rounded"
                className="h-9 w-16"
              />
              <span className="max-w-[70px] truncate text-[10px] text-white/55">{s.nickname}</span>
            </span>
          ))}
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {playing && amPlayer && hud.alive && (
            <button
              onClick={() => { void forfeit(); }}
              className="rounded-full bg-dark-700 px-2 py-1 text-white/55 transition-colors hover:bg-dark-600"
            >
              기권
            </button>
          )}
          <button
            onClick={() => { void leave(); }}
            className="flex items-center gap-1 rounded-full bg-danger/80 px-2.5 py-1 text-white transition-colors hover:bg-danger"
          >
            <LogOut size={12} /> 나가기
          </button>
        </span>
      </div>

      {/* 안내 배너 */}
      <AnimatePresence>
        {banner && (
          <motion.div
            key={banner.at}
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="pointer-events-none absolute left-1/2 top-14 z-30 -translate-x-1/2 rounded-full bg-black/75 px-4 py-1.5 text-xs text-white/90 shadow-lg"
          >
            {banner.text}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Esc 조작 안내 (멀티라 실제 일시정지는 없다 — 설계서 §T5) */}
      <AnimatePresence>
        {helpOpen && (
          <motion.div
            key="help"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setHelpOpen(false)}
            className="absolute inset-0 z-40 flex items-center justify-center bg-dark-900/80 p-4 backdrop-blur-sm"
          >
            <div className="glass-strong w-full max-w-xs rounded-modal p-4">
              <p className="mb-2 font-display text-base font-bold">조작법</p>
              <ul className="space-y-1">
                {KEY_GUIDE.map((k) => (
                  <li key={k.keys} className="flex items-center gap-2 text-xs text-white/70">
                    <span className="min-w-[72px] rounded bg-white/10 px-1.5 py-0.5 text-center font-display text-[11px] text-white/85">
                      {k.keys}
                    </span>
                    {k.label}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-white/35">여러 명이 함께 하는 판이라 실제로 멈추지는 않아요</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <TetrisHud />
      {/* 콤보 숫자는 v4 결정대로 즉시 떴다 사라진다 — 사천성 ComboBurst 를 그대로 재사용 */}
      <ComboBurst boardId={myUserId ?? undefined} myUserId={myUserId} />
      <AttackFxLayer myBoardId={myUserId ?? undefined} arenaRef={arenaRef} />

      {snapshot.phase === 'countdown' && snapshot.startAt && (
        <Countdown startAt={snapshot.startAt} modeText={TETRIS_MODE_DESC[opts.mode]} />
      )}
      {snapshot.phase === 'finished' && <ResultsOverlay snapshot={snapshot} />}
    </motion.div>
  );
}
