import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Crown, Eye, Keyboard, LogOut, Volume2, VolumeX } from 'lucide-react';
import { emitWithAck } from '../../lib/socket';
import { showToast } from '../common/Toast';
import { useAuthStore } from '../../stores/authStore';
import { useGameStore } from '../../stores/gameStore';
import { useUIStore } from '../../stores/uiStore';
import { useTetrisStore } from '../../stores/tetrisStore';
import { useTetrisGame, useTetrisSpectate } from '../../hooks/useTetrisGame';
import { ThemeBackdrop, themeOf } from './ArenaTheme';
import { Countdown } from './Countdown';
import { ResultsOverlay } from './ResultsOverlay';
import { ComboBurst } from './ComboBurst';
import { AttackFxLayer } from './AttackFx';
import { TetrisCanvas, PiecePreview } from './TetrisCanvas';
import { TetrisMiniBoard } from './TetrisMiniBoard';
import { TetrisHud } from './TetrisHud';
import { ProfileVideo, type GameFeed } from './ProfileVideo';
import { PROFILE_CARD_CLASS, PROFILE_COL_CLASS, PROFILE_LIST_CLASS, useProfileFit } from './ProfileColumn';
import { setArenaShaker } from '../../games/tetris/fx';
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

/**
 * 우측 세로 위험도 게이지 (설계서 §T6).
 * 예전에는 14px 짜리 실선이라 **거의 보이지 않았다** — 굵은 튜브 + 눈금 + 현재 높이 마커 +
 * 숫자로 "지금 얼마나 위험한지"가 한눈에 읽히게 한다.
 */
function DangerGauge({ value, compact }: { value: number; compact?: boolean }) {
  const hot = value >= 0.8;
  const pct = Math.round(value * 100);
  return (
    // 좁은 창에서도 **절대 사라지지 않는다**(§Z1) — 폭만 줄인다.
    <div
      data-ghc-danger={pct}
      className={`relative flex shrink-0 flex-col items-center gap-1 ${compact ? 'w-[30px]' : 'w-[46px]'}`}
    >
      <span className={`font-display text-[10px] font-black leading-none tabular-nums ${hot ? 'text-danger' : 'text-white/45'}`}>
        {pct}%
      </span>
      <div className={`relative min-h-0 flex-1 overflow-hidden rounded-full bg-black/70 shadow-[inset_0_2px_10px_rgba(0,0,0,0.85)] ring-1 ring-white/15 ${compact ? 'w-[16px]' : 'w-[26px]'}`}>
        {/* 눈금 — 25% 마다. 절반/끝은 더 진하게 */}
        {[25, 50, 75].map((t) => (
          <span key={t} className={`absolute inset-x-1 h-px ${t === 50 ? 'bg-white/25' : 'bg-white/12'}`} style={{ bottom: `${t}%` }} />
        ))}
        {/* 위험선(16행 = 80%) — 이 위로 차오르면 곧 탑아웃 */}
        <span className="absolute inset-x-0 h-[2px] bg-danger/80" style={{ bottom: '80%' }} />
        <motion.div
          className="absolute inset-x-0 bottom-0 rounded-full"
          style={{
            background: hot
              ? 'linear-gradient(0deg,#B91C1C,#EF4444 55%,#FE2C55)'
              : 'linear-gradient(0deg,#0891B2,#25F4EE 55%,#4ADE80)',
          }}
          animate={{
            height: `${Math.max(3, value * 100)}%`,
            opacity: hot ? [1, 0.6, 1] : 1,
          }}
          transition={{ height: { duration: 0.2 }, opacity: { duration: 0.55, repeat: hot ? Infinity : 0 } }}
        />
        {/* 현재 높이 표시 — 게이지 끝에 밝은 선을 얹어 "지금 여기"를 또렷하게 */}
        <motion.span
          className="absolute inset-x-0 h-[3px] bg-white/90"
          animate={{ bottom: `calc(${Math.max(3, value * 100)}% - 2px)` }}
          transition={{ duration: 0.2 }}
        />
      </div>
      <span className="text-[9px] leading-none text-white/35">위험</span>
    </div>
  );
}

/** 사천성 카드에서 카메라를 뺀 나머지(닉네임 줄 + 줄/KO 줄 + 여백)의 대략 높이. */
const TETRIS_CHROME = 54;

/**
 * 아레나 반응형 치수 (설계서 §Z1).
 *
 * **폭으로 "플레이 가능 여부"를 판단하지 않는다.** 창을 좁힌 데스크탑 사용자가 관전
 * 레이아웃으로 떨어져 보드가 79px 로 눌리는 버그(§Z0)의 원인이 그것이었다.
 * 판단 기준은 입력 장치(`hover: none` + `pointer: coarse`)이고, 폭은 **크기만** 정한다.
 */
interface ArenaMetrics {
  /** 좌우 2단 배치를 쓸 만큼 넓은가(1024px~) — 프로필이 좌측 세로 컬럼이 된다 */
  wide: boolean;
  /**
   * 프로필은 가로 스트립이지만 **미니보드는 판 옆**에 세울 만큼은 넓은가(560px~).
   * 미니 스트립을 판 아래에 깔면 세로를 130px 먹어 판이 그만큼 작아지는데,
   * 이 폭대에서는 좌우가 300px 넘게 남아돈다 — 옆으로 옮기면 같은 창에서 판이 1.7배가 된다.
   */
  side: boolean;
  /** 아주 좁은 창(480px 미만) — 같은 구성으로 한 단계 더 작게 */
  tight: boolean;
  /** 터치 전용 기기 = 키보드가 없다 → 이때만 관전 안내를 띄운다 */
  touchOnly: boolean;
}

const WIDE_MQ = '(min-width: 1024px)';
const SIDE_MQ = '(min-width: 560px)';
const TIGHT_MQ = '(max-width: 479px)';
/** 설계서 §Z1 — **폭이 아니라 입력 장치**로 플레이 가능 여부를 판단한다 */
const TOUCH_MQ = '(hover: none) and (pointer: coarse)';

function useArenaMetrics(): ArenaMetrics {
  const [m, setM] = useState<ArenaMetrics>(() => readMetrics());
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mqs = [WIDE_MQ, SIDE_MQ, TIGHT_MQ, TOUCH_MQ].map((q) => window.matchMedia(q));
    // 리사이즈뿐 아니라 **기기 변경**(도킹/외장 키보드 연결)에도 반응해야 한다.
    const onChange = () => setM((prev) => {
      const next = readMetrics();
      return prev.wide === next.wide && prev.side === next.side
        && prev.tight === next.tight && prev.touchOnly === next.touchOnly ? prev : next;
    });
    for (const mq of mqs) mq.addEventListener('change', onChange);
    onChange();
    return () => { for (const mq of mqs) mq.removeEventListener('change', onChange); };
  }, []);
  return m;
}

function readMetrics(): ArenaMetrics {
  const has = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const hit = (q: string) => (has ? window.matchMedia(q).matches : false);
  return {
    wide: has ? hit(WIDE_MQ) : true,
    side: has ? hit(SIDE_MQ) : true,
    tight: hit(TIGHT_MQ),
    touchOnly: hit(TOUCH_MQ),
  };
}

/**
 * 좌측 프로필 카드 — 카메라 + 닉네임 + 왕관/나 + 지운 줄 + KO (사천성 ProfileVideo 재사용).
 * 폭은 항상 컬럼을 꽉 채우고, 세로만 인원수에 맞춰 줄어든다(`useProfileFit`).
 */
function TetrisProfile({
  player, feed, isMe, isHost, lines, ko, alive, camH, width,
}: {
  player: PlayerState; feed?: GameFeed; isMe: boolean; isHost: boolean;
  lines: number; ko: number; alive: boolean; camH: number | null;
  /** 좁은 창 가로 스트립에서의 카드 폭(px). null 이면 컬럼 폭을 꽉 채운다 */
  width: number | null;
}) {
  return (
    <div
      data-ghc-player={player.userId}
      data-ghc-profile={player.userId}
      className={`${PROFILE_CARD_CLASS} ${isMe ? 'bg-white/10' : 'bg-white/5'} ${alive ? '' : 'opacity-50'}`}
      style={{
        boxShadow: `inset 0 0 0 ${isMe ? 2 : 1}px ${isMe ? player.color : `${player.color}44`}`,
        ...(width == null ? null : { width }),
      }}
    >
      <div
        className={`relative w-full overflow-hidden rounded-lg bg-black/40 ${camH == null ? 'aspect-video' : ''}`}
        style={camH == null ? undefined : { height: camH }}
      >
        <ProfileVideo feed={feed} color={player.color} label={player.nickname} className="h-full w-full" />
        {!alive && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/55 font-display text-sm font-black italic text-white/90">
            K.O.
          </span>
        )}
        {ko > 0 && (
          <span className="absolute right-1 top-1 rounded bg-primary/85 px-1 text-[10px] font-bold text-white">
            K.O. {ko}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1 px-0.5">
        <span className="min-w-0 flex-1 truncate text-xs text-white/90">{player.nickname}</span>
        {isHost && <Crown size={12} className="shrink-0 text-warning" />}
        {isMe && <span className="shrink-0 text-[10px] text-white/35">나</span>}
      </div>
      <div className="flex items-end gap-1.5 px-0.5">
        <span className="text-[9px] leading-none text-white/40">지운 줄</span>
        <span className="font-display text-lg font-black leading-none tabular-nums text-white">{lines}</span>
        <span className="ml-auto text-[9px] leading-none text-white/40">KO</span>
        <span className={`font-display text-sm font-black leading-none tabular-nums ${ko > 0 ? 'text-primary' : 'text-white/30'}`}>
          {ko}
        </span>
      </div>
    </div>
  );
}

/**
 * 테트리스 인게임 화면 (설계서 §T6/§Z1).
 * 넓은 창: 좌 프로필 · 가운데 내 보드(HOLD/NEXT) · 우 미니보드+위험도 · 하단 바.
 * 좁은 창: [상단 바] [프로필 가로 스트립] [HOLD│보드│NEXT] [미니 스트립] [하단 바]
 *   — **작아질 뿐 아무것도 사라지지 않는다.** 키보드만 있으면 폭과 무관하게 플레이할 수 있다.
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
  const setHelpOpen = useTetrisStore((s) => s.setHelpOpen);
  const arenaRef = useRef<HTMLDivElement>(null);
  /** 흔들리는 영역 — 캔버스뿐 아니라 HOLD/NEXT/미니보드/위험도 게이지까지 함께 움직인다. */
  const playRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  const fit = useProfileFit(profileRef, snapshot.players.length, TETRIS_CHROME);
  const { wide, side, tight, touchOnly } = useArenaMetrics();
  /** 미니보드가 판 **옆**에 서는가(=세로 컬럼). 아니면 판 **아래** 가로 스트립. */
  const miniColumn = wide || side;

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

  /**
   * 화면 흔들림 — 게임 루프(rAF)가 사건별 세기를 계산해 **DOM transform 으로 직접** 쓴다.
   * 스토어/framer-motion 을 거치면 흔들릴 때마다 아레나가 통째로 리렌더돼 60fps 가 깨진다.
   * `data-ghc-shake-power` 는 Playwright 검증용(0 이면 흔들림 없음).
   */
  useEffect(() => {
    const el = playRef.current;
    if (!el) return;
    let lastPower = -1;
    setArenaShaker((o) => {
      const p = Math.round(o.power * 10) / 10;
      if (p <= 0) {
        if (lastPower !== 0) {
          el.style.transform = '';
          el.dataset.ghcShakePower = '0';
          lastPower = 0;
        }
        return;
      }
      el.style.transform =
        `translate3d(${o.x.toFixed(2)}px,${o.y.toFixed(2)}px,0) rotate(${o.rot.toFixed(3)}deg)`;
      // 속성 쓰기는 값이 실제로 바뀔 때만 — 매 프레임 dataset 을 만지면 공짜가 아니다.
      if (p !== lastPower) {
        el.dataset.ghcShakePower = String(p);
        lastPower = p;
      }
    });
    return () => {
      setArenaShaker(null);
      el.style.transform = '';
      el.dataset.ghcShakePower = '0';
    };
  }, []);

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

  /**
   * 좁은 창 치수 (§Z1) — **불변식: 내 보드 ≥ 상대 미니보드.**
   * 좁을수록 미니보드를 먼저 줄인다. 미니 40px(=칸 4px, 판 40×80)이면 내 보드의 하한
   * (칸 6px, 판 60×120)이 어떤 경우에도 그보다 크다.
   */
  // 미니가 판 **아래**로 내려가는 배치에서는 세로가 유일한 병목이다 → 그때는 폭이 넉넉해도
  // 미니/프로필을 가장 작게 유지한다(미니를 크게 키워 봐야 판만 납작해진다).
  const miniW = wide ? (others.length > 2 ? 70 : 90)
    : side ? (others.length > 2 ? 52 : 66)
      : 40;
  /** HOLD/NEXT 곁기둥 폭 — 좁으면 얇아질 뿐 사라지지 않는다 */
  const sideW = wide ? 64 : (tight ? 38 : 46);
  /** 좁은 창 프로필 카드 폭/카메라 높이(16:9) — 가로 스트립이 세로를 다 먹지 않게 고정한다 */
  const cardW = miniColumn ? 108 : 92;
  const cardCam = Math.round((cardW - 12) * 9 / 16);
  /** 미리보기 칸 크기 */
  const previewBox = sideW - 8;
  /** 좁은 창에서는 NEXT 를 3개까지만 — 판 높이를 미리보기가 잡아먹으면 안 된다 */
  const nextList = hud.next.slice(0, Math.max(1, wide ? opts.nextCount : Math.min(3, opts.nextCount)));
  const goalText = opts.mode === 'sprint' ? `${hud.lines} / ${opts.sprintLines}` : `${hud.lines}`;

  const minis = others.map((p) => (
    <TetrisMiniBoard
      key={p.userId}
      userId={p.userId}
      nickname={p.nickname}
      color={p.color}
      frame={frames[p.userId]}
      dead={deadIds.has(p.userId)}
      width={miniW}
    />
  ));

  return (
    <motion.div
      ref={arenaRef}
      // overflow-hidden: 좁은 창에서 내용이 넘치더라도 **하단 바를 밀어내지 않고** 판 쪽이 잘린다.
      className="relative isolate flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2"
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
          좁은 창은 가로 스트립, lg 부터 좌측 세로 컬럼으로 **같은 노드**가 재배치된다. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row">
        {/* 좌(좁은 창=상단): 프로필 — 한 줄에 한 사람, 카드가 컬럼 폭을 꽉 채운다.
            카메라는 컬럼 폭 16:9, 인원이 많으면 세로만 줄어든다(사천성과 같은 규칙).
            좁은 창에서는 **고정 높이 가로 스트립**이라 판이 쓸 세로를 잠식하지 않는다. */}
        <div className={`min-h-0 shrink-0 ${PROFILE_COL_CLASS}`}>
          <div ref={profileRef} className={PROFILE_LIST_CLASS}>
            {snapshot.players.map((p) => (
              <TetrisProfile
                key={p.userId}
                player={p}
                feed={feedFor(p.userId)}
                isMe={p.userId === myUserId}
                isHost={p.userId === snapshot.hostUserId}
                lines={linesOf(p)}
                ko={koOf(p)}
                alive={aliveOf(p)}
                camH={wide ? fit.cam : cardCam}
                width={wide ? null : cardW}
              />
            ))}
          </div>
        </div>

        {/* 흔들리는 플레이 영역 — 보드만이 아니라 HOLD/NEXT/미니보드/위험도 게이지까지 함께.
            `will-change: transform` 으로 합성 레이어를 미리 잡아 흔들 때 리페인트를 피한다. */}
        <div
          ref={playRef}
          data-ghc-shake="1"
          data-ghc-shake-power="0"
          className={`flex min-h-0 min-w-0 flex-1 gap-2 will-change-transform ${
            miniColumn ? 'flex-row' : 'flex-col'
          }`}
        >
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
          {/* HOLD 기둥 — 좁아지면 얇아질 뿐, **어떤 폭에서도 사라지지 않는다**(§Z1) */}
          <div className="flex shrink-0 flex-col gap-1" style={{ width: sideW }}>
            <p className="text-center text-[10px] tracking-widest text-white/40">HOLD</p>
            <div
              className="flex items-center justify-center rounded-lg bg-black/40"
              style={{ height: previewBox / 2 + 6 }}
            >
              {hud.hold ? <PiecePreview id={hud.hold} box={previewBox} dim={!opts.hold} /> : null}
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

          {/* data-ghc-board: AttackFxLayer 가 "나에게 날아오는" 투사체의 착탄점을 여기로 잡는다.
              캔버스는 이 상자 안에서 스스로 1:2 로 맞춘다(§Z1) — 상자가 납작해도 판은 안 눌린다. */}
          <div
            data-ghc-board={myUserId ?? undefined}
            className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden lg:max-w-[min(46vh,320px)]"
          >
            <TetrisCanvas className="h-full w-full" />
          </div>

          {/* NEXT 기둥 — HOLD 와 같은 규칙(작아지되 사라지지 않는다) */}
          <div className="flex min-h-0 shrink-0 flex-col gap-1" style={{ width: sideW }}>
            <p className="shrink-0 text-center text-[10px] tracking-widest text-white/40">NEXT</p>
            <div className="flex min-h-0 flex-col gap-1 overflow-hidden">
              {nextList.map((id, i) => (
                <div
                  key={`${id}-${i}`}
                  className="flex shrink-0 items-center justify-center rounded-lg bg-black/35"
                  style={{ height: previewBox / 2 + 4 }}
                >
                  <PiecePreview id={id} box={previewBox - 4} dim={i > 0} />
                </div>
              ))}
            </div>
          </div>
          </>
          )}
        </div>

        {/* 우(좁은 창=하단): 상대 미니보드 + 위험도 게이지.
            **클릭해도 확대되지 않는다** — 내 판이 항상 가장 크다(사천성 v2.1 결정 계승).
            위험도 게이지는 좁은 창에서도 같은 줄에 남는다(작아질 뿐 사라지지 않는다). */}
        {!spectating && (
          <div
            className={`flex shrink-0 items-stretch gap-1.5 ${
              miniColumn ? 'overflow-visible' : 'overflow-x-auto scrollbar-none'
            }`}
          >
            <div className={`flex gap-1.5 ${miniColumn ? 'flex-col overflow-y-auto scrollbar-none' : ''}`}>
              {minis}
            </div>
            <DangerGauge value={hud.danger} compact={!wide} />
          </div>
        )}
        </div>
      </div>

      {/* 관전 안내는 **터치 전용 기기에서만** 띄운다 (§Z1).
          예전에는 폭(lg 미만)으로 판단해서, 창을 좁힌 PC 사용자가 플레이 가능한데도
          "구경만 할 수 있어요"를 보고 조작 UI까지 잃었다. */}
      {!spectating && touchOnly && (
        <p
          data-ghc-spectate-notice="1"
          className="flex shrink-0 items-center justify-center gap-1 rounded-full bg-black/40 px-2 py-1 text-[11px] text-white/55"
        >
          <Keyboard size={12} /> PC에서 플레이할 수 있어요 — 지금은 구경만 할 수 있어요
        </p>
      )}

      {/* 하단 바 — 관전자 카메라 스트립 + 기권/나가기.
          **어떤 폭·높이에서도 패널 바닥에 붙어 항상 보인다**(§Z2): `mt-auto`(위 내용이 모자라도
          바닥) + `shrink-0`(내용이 넘쳐도 이 줄만은 줄어들지 않는다) + `z-20`(연출 레이어 위).
          관전자 스트립만 좁은 창에서 접힌다 — 나가기 버튼은 마지막까지 남는다. */}
      <div className="relative z-20 mt-auto flex shrink-0 items-center gap-2 px-1 text-[11px] text-white/45">
        <span className="hidden shrink-0 sm:inline">{TETRIS_MODE_DESC[opts.mode]}</span>
        {wide && (
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
        )}
        {!wide && snapshot.spectators.length > 0 && (
          // 좁은 창: 카메라 스트립을 펼치면 판이 쓸 세로를 먹는다 → 인원수만 알린다.
          <span className="flex shrink-0 items-center gap-1">
            <Eye size={12} className="text-white/35" /> {snapshot.spectators.length}
          </span>
        )}
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
            data-ghc-exit="1"
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
