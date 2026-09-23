import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
import { useAuthStore } from '../stores/authStore';
import { useGameStore } from '../stores/gameStore';
import { tetrisDebug, useTetrisStore } from '../stores/tetrisStore';
import { playGameSound } from '../games/sounds';
import * as engine from '../games/tetris/engine';
import type { LockResult, TetrisState } from '../games/tetris/engine';
import {
  CELL_ACTIVE_BASE, COLS, DEFAULT_TETRIS_OPTIONS, FIELD_ROWS,
  type ClearKind, type TetrisDownEvent, type TetrisFinishEvent, type TetrisFramesEvent,
  type TetrisGarbageEvent, type TetrisOptions, type TetrisRiseEvent, type TetrisSentEvent,
} from '../games/tetris/types';
import { CLEAR_BADGE, FX_MS, toneOfClear } from '../games/tetris/ui';
import type { GameSnapshot } from '../games/types';

/** 설계서 §T5. DAS/ARR 은 브라우저 키 리피트를 쓰지 않고 직접 센다(리피트 지연이 기기마다 다름). */
const DAS_MS = 133;
const ARR_MS = 20;
/** 탭이 백그라운드로 갔다 오면 dt 가 수십 초로 튄다 → 한 프레임 최대 100ms 로 자른다. */
const MAX_DT = 100;
/** 프레임 업로드 8Hz (설계서 §T3, 서버 상한은 15Hz) */
const FRAME_MS = 125;

/** 캔버스가 이번 프레임에 같이 그려야 할 연출. 전부 시각(ms)만 담는다(타이머 없음). */
export interface BoardFx {
  now: number;
  /** 줄 섬광 — 지운 **보이는 행** 인덱스 */
  clear: { rows: number[]; start: number } | null;
  /** 하드드롭 잔상 */
  trail: { cols: number[]; fromRow: number; toRow: number; color: string; start: number } | null;
  /** 락 화이트 플래시 */
  lock: { start: number } | null;
  /** 쓰레기 줄이 밀고 올라온 직후(아래→위 슬라이드) */
  rise: { start: number } | null;
  /** 하드드롭 화면 진동 */
  shake: { start: number } | null;
  alive: boolean;
}

export type TetrisPainter = (cells: number[], fx: BoardFx) => void;

/**
 * 캔버스 ↔ 게임 루프 연결점.
 * 내 보드는 화면에 **딱 하나**라서 싱글턴 하나로 충분하고, 이렇게 해야 60fps 그리기가
 * React 렌더를 한 번도 타지 않는다.
 */
let painter: TetrisPainter | null = null;
export function setTetrisPainter(p: TetrisPainter | null): void {
  painter = p;
}

/** 스택 최고 높이(칸). 위험도 게이지와 위험선 판정에 쓴다. */
function stackHeight(s: TetrisState): number {
  const f = s.field;
  for (let r = 0; r < FIELD_ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (f[r * COLS + c]) return FIELD_ROWS - r;
    }
  }
  return 0;
}

/** 줄 수만으로 종류를 유추(엔진이 kind 를 안 줬을 때의 안전망). */
const PLAIN_KIND: ClearKind[] = ['single', 'double', 'triple', 'tetris'];

type Action = 'left' | 'right' | 'softDrop' | 'hardDrop' | 'cw' | 'ccw' | 'flip' | 'hold' | 'help';

/**
 * `e.code` 로 매핑한다. `e.key` 는 한글 입력 상태에서 'ㅋ'/'ㅌ' 로 들어와 Z/X 회전이 죽는다.
 * 디버그 `press()` 가 넘기는 액션 이름도 그대로 받는다.
 */
function actionOfCode(code: string): Action | null {
  switch (code) {
    case 'ArrowLeft': case 'left': return 'left';
    case 'ArrowRight': case 'right': return 'right';
    case 'ArrowDown': case 'down': case 'softDrop': return 'softDrop';
    case 'Space': case ' ': case 'space': case 'hardDrop': return 'hardDrop';
    case 'ArrowUp': case 'KeyX': case 'up': case 'cw': return 'cw';
    case 'KeyZ': case 'ControlLeft': case 'ControlRight': case 'ccw': return 'ccw';
    case 'KeyA': case 'flip': return 'flip';
    case 'ShiftLeft': case 'ShiftRight': case 'KeyC': case 'hold': return 'hold';
    case 'Escape': case 'help': return 'help';
    default: return null;
  }
}
/** 페이지 스크롤·버튼 재클릭을 막아야 하는 키 */
const PREVENT = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);

function isTypingTarget(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable);
}

/**
 * 테트리스 한 판의 클라 시뮬 + 입력 + 소켓 (설계서 §T1/§T3/§T5).
 * 아레나에서만 마운트되며, `phase` 가 countdown/playing 인 동안만 살아 있다.
 */
export function useTetrisGame(snapshot: GameSnapshot): void {
  const myUserId = useAuthStore((s) => s.userId);
  // 루프 안에서 최신 스냅샷을 봐야 하지만, 스냅샷이 바뀔 때마다 판을 새로 만들면 안 된다.
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;

  const amPlayer = snapshot.players.some((p) => p.userId === myUserId);
  const active = amPlayer && (snapshot.phase === 'countdown' || snapshot.phase === 'playing');
  // 같은 판(시드+시작시각)이면 절대 재생성하지 않는다. 재대결하면 값이 바뀌어 새 판이 열린다.
  const gameKey = `${snapshot.seed}:${snapshot.startAt ?? 0}`;

  useEffect(() => {
    if (!active || !myUserId) return;
    const socket = getSocket();
    const store = useTetrisStore;
    const opts: TetrisOptions = snapRef.current.tetris ?? DEFAULT_TETRIS_OPTIONS.versus;

    store.getState().reset();

    // --- 엔진 상태: 시드가 같으므로 모든 참가자가 동일한 조각 순서를 받는다(§T1) ---
    const state = engine.createState(snapRef.current.seed, opts);
    engine.spawn(state);

    let done = false;              // 레이스 완주·탈락 후에는 입력/시뮬을 멈춘다
    let toppedOut = false;

    const fx: BoardFx = {
      now: performance.now(), clear: null, trail: null, lock: null, rise: null, shake: null, alive: true,
    };

    const syncHud = () => {
      store.getState().setHud({
        lines: state.lines, score: state.score, level: state.level,
        combo: state.combo, b2b: state.b2b, pending: engine.pendingCount(state),
        hold: state.hold, next: state.next.slice(0, opts.nextCount),
        alive: state.alive, ko: state.ko,
        danger: Math.min(1, stackHeight(state) / 20),
      });
    };
    syncHud();

    const nickOf = (id: string) =>
      snapRef.current.players.find((p) => p.userId === id)?.nickname ?? '누군가';
    const colorOf = (id: string) =>
      snapRef.current.players.find((p) => p.userId === id)?.color ?? '#FE2C55';

    /** 내가 죽었다 → 서버가 등수를 매긴다. 두 번 보내지 않는다. */
    const reportTopout = () => {
      state.alive = false;
      fx.alive = false;
      if (toppedOut) return;
      toppedOut = true;
      done = true;
      socket.emit('tetris:topout', {});
      playGameSound('ko');
      store.getState().setBanner('탑아웃! 결과를 기다리는 중…');
    };

    // ---------------------------------------------------------------- 락 처리
    const handleLock = (lock: LockResult) => {
      fx.lock = { start: performance.now() };

      if (lock.cleared > 0) {
        // 엔진이 kind/combo/b2b 를 확정해서 준다 — 소켓 페이로드와 배지가 어긋날 여지가 없다.
        const kind: ClearKind = lock.kind ?? PLAIN_KIND[Math.min(3, lock.cleared - 1)];
        const b2b = lock.b2b;
        fx.clear = { rows: lock.rows.filter((r) => r >= 0), start: performance.now() };

        // 서버가 공격량·대상·상쇄를 계산한다(§T3.1). 클라는 "무엇을 지웠는지"만 보고한다.
        socket.emit('tetris:clear', {
          kind, lines: lock.cleared, combo: lock.combo, b2b, perfect: lock.perfect,
        });

        playGameSound(
          kind.startsWith('ts') ? 'tspin'
            : lock.cleared >= 4 ? 'tetris'
              : (`clear${lock.cleared}` as 'clear1' | 'clear2' | 'clear3'),
        );
        if (b2b) playGameSound('b2b');

        // 배지 하나만 띄운다 — B2B 는 뒤에 붙여서 화면에 두 개가 겹치지 않게.
        const base = lock.perfect ? 'PERFECT CLEAR!' : CLEAR_BADGE[kind];
        const badge = base && b2b ? `${base} B2B x${state.b2b}` : base ?? (b2b ? `B2B x${state.b2b}` : null);
        if (badge) store.getState().setBadge(badge, lock.perfect ? 'gold' : toneOfClear(kind));

        store.getState().pushFx({ type: 'clear', lines: lock.cleared, kind });
        if (lock.cleared >= 4 || lock.perfect) store.getState().pushFx({ type: 'screen', lines: lock.cleared });

        // 콤보 연출은 사천성 v4 ComboBurst 를 그대로 재사용한다(즉시 떴다 사라짐).
        if (lock.combo >= 2) {
          useGameStore.getState().pushFx({
            type: 'pop', boardId: myUserId, combo: lock.combo, fromUserId: myUserId,
            color: colorOf(myUserId),
          });
        }

        // 레이스 완주 — 서버가 등수·기록을 확정한다.
        if (opts.mode === 'sprint' && !done && state.lines >= opts.sprintLines) {
          done = true;
          const timeMs = Date.now() - (snapRef.current.startAt ?? Date.now());
          socket.emit('tetris:finish', { timeMs, lines: state.lines });
          store.getState().setHud({ finishedMs: timeMs });
          store.getState().setBanner(`완주! ${(timeMs / 1000).toFixed(1)}초`);
          playGameSound('win');
        }
      } else if (lock.spin !== 'none') {
        // 줄은 못 지웠지만 T-스핀은 인정 — 손맛을 위해 배지/소리는 준다.
        playGameSound('tspin');
        store.getState().setBadge(lock.spin === 'mini' ? 'T-SPIN MINI' : 'T-SPIN', 'purple');
      } else {
        playGameSound('lock');
      }

      if (lock.levelUp) {
        playGameSound('levelUp');
        store.getState().pushFx({ type: 'levelUp' });
      }

      if (lock.toppedOut || !state.alive) reportTopout();
      syncHud();
    };

    // ---------------------------------------------------------------- 입력
    const held = { left: false, right: false, soft: false };
    let dir: -1 | 0 | 1 = 0;
    let das = 0;
    let arr = 0;
    let softAcc = 0;

    // 설계서 §T5: 게임 패널이 열려 있고 · 내가 플레이어이고 · 진행 중일 때만 키가 먹는다.
    const canControl = () =>
      useGameStore.getState().isPanelOpen
      && snapRef.current.phase === 'playing'
      && Date.now() >= (snapRef.current.startAt ?? 0)
      && state.alive && !done;

    const startDir = (d: -1 | 1) => {
      dir = d;
      das = DAS_MS;
      arr = 0;
      if (engine.tryMove(state, d, 0)) playGameSound('move');
    };

    const doAction = (a: Action) => {
      if (a === 'help') {
        const st = useTetrisStore.getState();
        st.setHelpOpen(!st.helpOpen);
        return;
      }
      if (!canControl()) return;
      switch (a) {
        case 'left': held.left = true; startDir(-1); break;
        case 'right': held.right = true; startDir(1); break;
        case 'softDrop': held.soft = true; softAcc = 0; if (engine.softDropStep(state)) playGameSound('move'); break;
        case 'hardDrop': {
          // 잔상을 그리려면 **떨어지기 전에** 조각의 열과 낙하 거리를 재 둬야 한다.
          const before = engine.toCells(state, opts);
          const cols: number[] = [];
          let fromRow = Number.POSITIVE_INFINITY;
          for (let i = 0; i < before.length; i++) {
            if (before[i] >= CELL_ACTIVE_BASE) {
              const c = i % COLS;
              if (!cols.includes(c)) cols.push(c);
              fromRow = Math.min(fromRow, Math.floor(i / COLS));
            }
          }
          const drop = state.piece ? engine.ghostY(state) - state.piece.y : 0;
          const res = engine.hardDrop(state);
          if (Number.isFinite(fromRow)) {
            fx.trail = {
              cols, fromRow, toRow: fromRow + Math.max(0, drop),
              color: colorOf(myUserId), start: performance.now(),
            };
          }
          fx.shake = { start: performance.now() };
          playGameSound('harddrop');
          handleLock(res);
          break;
        }
        case 'cw': if (engine.tryRotate(state, 1)) playGameSound('rotate'); break;
        case 'ccw': if (engine.tryRotate(state, -1)) playGameSound('rotate'); break;
        case 'flip':
          // 엔진 SRS+ 킥 표가 180°(dir 2)를 직접 지원한다.
          if (engine.tryRotate(state, 2)) playGameSound('rotate');
          break;
        case 'hold':
          // 홀드로 꺼낸 조각이 스폰 위치에서 겹치면 그대로 탑아웃이다.
          if (opts.hold) {
            const ok = engine.holdPiece(state);
            if (ok) playGameSound('rotate');
            if (!state.alive) reportTopout();
            syncHud();
          }
          break;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const a = actionOfCode(e.code);
      if (!a) return;
      if (PREVENT.has(e.code)) e.preventDefault();
      // OS 키 리피트는 무시한다 — 반복은 DAS/ARR 로 우리가 만든다.
      if (e.repeat) return;
      doAction(a);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const a = actionOfCode(e.code);
      if (!a) return;
      if (a === 'left' || a === 'right') {
        held[a] = false;
        const other = a === 'left' ? 'right' : 'left';
        if (held[other]) startDir(other === 'left' ? -1 : 1);
        else { dir = 0; das = 0; arr = 0; }
      } else if (a === 'softDrop') {
        held.soft = false;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    // 창이 포커스를 잃으면 키가 눌린 채로 굳는다(키업이 안 온다) → 전부 떼어 준다.
    const onBlur = () => { held.left = held.right = held.soft = false; dir = 0; };
    window.addEventListener('blur', onBlur);

    // ---------------------------------------------------------------- 루프
    let raf = 0;
    let lastT = performance.now();
    const renderCells: number[] = [];
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(MAX_DT, now - lastT);
      lastT = now;

      if (canControl()) {
        if (dir !== 0) {
          das -= dt;
          if (das <= 0) {
            arr += dt;
            while (arr >= ARR_MS) {
              arr -= ARR_MS;
              if (!engine.tryMove(state, dir, 0)) break;
            }
          }
        }
        if (held.soft) {
          const step = Math.max(15, engine.gravityMs(state.level) / 20);
          softAcc += dt;
          while (softAcc >= step) {
            softAcc -= step;
            if (!engine.softDropStep(state)) break;
          }
        }
        const { locked } = engine.tick(state, dt);
        if (locked) handleLock(locked);
      }

      fx.now = now;
      fx.alive = state.alive;
      if (fx.clear && now - fx.clear.start > FX_MS.clear) fx.clear = null;
      if (fx.trail && now - fx.trail.start > FX_MS.trail) fx.trail = null;
      if (fx.lock && now - fx.lock.start > FX_MS.lock) fx.lock = null;
      if (fx.rise && now - fx.rise.start > FX_MS.rise) fx.rise = null;
      if (fx.shake && now - fx.shake.start > FX_MS.shake) fx.shake = null;
      // 매 프레임 200칸 배열을 새로 만들지 않도록 엔진의 out 버퍼 재사용 기능을 쓴다.
      painter?.(engine.toCells(state, opts, renderCells), fx);
    };
    raf = requestAnimationFrame(loop);

    // ---------------------------------------------------------------- 프레임 업로드 (8Hz)
    const frameTimer = setInterval(() => {
      syncHud();
      if (snapRef.current.phase !== 'playing') return;
      socket.emit('tetris:frame', {
        cells: engine.toCells(state, opts),
        lines: state.lines, score: state.score, level: state.level,
        combo: state.combo, b2b: state.b2b,
        hold: state.hold, next: state.next.slice(0, opts.nextCount),
        pending: engine.pendingCount(state), alive: state.alive, ko: state.ko, t: Date.now(),
      });
    }, FRAME_MS);

    // ---------------------------------------------------------------- 소켓 수신
    const onFrames = (e: TetrisFramesEvent) => store.getState().applyFrames(e);

    const onGarbage = (e: TetrisGarbageEvent) => {
      if (e.to !== myUserId) return;
      // 가이드라인대로 **다음 락에서** 올라온다. 엔진이 pending 을 소비한다.
      engine.queueGarbage(state, e.amount, e.holes);
      playGameSound('garbageIn');
      store.getState().pushFx({ type: 'garbage', amount: e.amount, from: e.from });
      syncHud();
    };

    const onSent = (e: TetrisSentEvent) => {
      store.getState().pushFx({ type: 'attack', from: e.from, to: e.to, amount: e.amount, kind: e.kind });
      // 투사체는 사천성 AttackFxLayer 를 그대로 쓴다 — boardId 자리에 대상 userId 를 넣고
      // 미니보드에 `data-ghc-board={userId}` 를 달아 두었다.
      useGameStore.getState().pushFx({
        type: 'attack', boardId: e.to, fromUserId: e.from,
        attack: { seq: e.seq, from: e.from, to: e.to, boardId: e.to, type: 'shuffle', until: Date.now() + 1 },
      });
    };

    const onRise = (e: TetrisRiseEvent) => {
      if (!state.alive) return;
      engine.applyGarbage(state, e.amount, e.holes);
      fx.rise = { start: performance.now() };
      playGameSound('garbageIn');
      store.getState().setBanner('바닥이 올라옵니다!');
      if (!state.alive) reportTopout();
      syncHud();
    };

    const onDown = (e: TetrisDownEvent) => {
      store.getState().pushKo(e);
      store.getState().pushFx({ type: 'ko', from: e.userId, to: e.by ?? undefined });
      if (e.userId !== myUserId) playGameSound('ko');
      store.getState().setBanner(
        e.by ? `${nickOf(e.userId)} K.O. — ${nickOf(e.by)}` : `${nickOf(e.userId)} 탈락`,
      );
    };

    const onFinished = (e: TetrisFinishEvent) => {
      if (e.userId === myUserId) return;
      store.getState().noteFinish(e, nickOf(e.userId));
    };

    socket.on('tetris:frames', onFrames);
    socket.on('tetris:garbage', onGarbage);
    socket.on('tetris:sent', onSent);
    socket.on('tetris:rise', onRise);
    socket.on('tetris:down', onDown);
    socket.on('tetris:finished', onFinished);

    // 디버그 브리지 — Playwright 가 실제 키 핸들러를 태워 플레이한다.
    tetrisDebug.state = () => state;
    tetrisDebug.press = (key: string) => {
      const a = actionOfCode(key);
      if (!a) return;
      doAction(a);
      if (a === 'left' || a === 'right') { held[a] = false; dir = 0; }
      if (a === 'softDrop') held.soft = false;
    };

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(frameTimer);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      socket.off('tetris:frames', onFrames);
      socket.off('tetris:garbage', onGarbage);
      socket.off('tetris:sent', onSent);
      socket.off('tetris:rise', onRise);
      socket.off('tetris:down', onDown);
      socket.off('tetris:finished', onFinished);
      tetrisDebug.state = () => null;
      tetrisDebug.press = () => {};
    };
    // gameKey 가 바뀌면(= 새 판) 통째로 다시 만든다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, gameKey, myUserId]);
}

/**
 * 관전자/모바일용 — 내 엔진 없이 상대 프레임만 받는다.
 * (플레이어가 아니면 `useTetrisGame` 이 아무것도 하지 않으므로 프레임 구독이 필요하다.)
 */
export function useTetrisSpectate(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const socket = getSocket();
    const onFrames = (e: TetrisFramesEvent) => useTetrisStore.getState().applyFrames(e);
    const onDown = (e: TetrisDownEvent) => useTetrisStore.getState().pushKo(e);
    socket.on('tetris:frames', onFrames);
    socket.on('tetris:down', onDown);
    return () => {
      socket.off('tetris:frames', onFrames);
      socket.off('tetris:down', onDown);
    };
  }, [enabled]);
}
