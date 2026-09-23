import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/socket';
import { useAuthStore } from '../stores/authStore';
import { useGameStore } from '../stores/gameStore';
import { tetrisDebug, useTetrisStore } from '../stores/tetrisStore';
import { playGameSound } from '../games/sounds';
import * as engine from '../games/tetris/engine';
import type { LockResult, TetrisState } from '../games/tetris/engine';
import {
  CELL_ACTIVE_BASE, COLS, DEFAULT_TETRIS_OPTIONS, FIELD_ROWS, HIDDEN_ROWS, PIECE_COLORS, ROWS,
  type ClearKind, type TetrisDownEvent, type TetrisFinishEvent, type TetrisFramesEvent,
  type TetrisGarbageEvent, type TetrisOptions, type TetrisRiseEvent, type TetrisSentEvent,
} from '../games/tetris/types';
import {
  CLEAR_BADGE, FX_MS, WIPE_STAGES, WIPE_STAGE_MS, clearMsOf, colorOfCell, toneOfClear,
} from '../games/tetris/ui';
import {
  ParticleField, comboShakePower, emitShakeFrame, shakeAt, shakeEventOfLines, strongerShake,
  type ShakeOut, type ShakeState,
} from '../games/tetris/fx';
import { prefersReducedMotion } from '../games/motion';
import type { GameSnapshot } from '../games/types';

/** 설계서 §T5. DAS/ARR 은 브라우저 키 리피트를 쓰지 않고 직접 센다(리피트 지연이 기기마다 다름). */
const DAS_MS = 133;
const ARR_MS = 20;
/** 탭이 백그라운드로 갔다 오면 dt 가 수십 초로 튄다 → 한 프레임 최대 100ms 로 자른다. */
const MAX_DT = 100;
/** 프레임 업로드 8Hz (설계서 §T3, 서버 상한은 15Hz) */
const FRAME_MS = 125;

/**
 * 캔버스가 이번 프레임에 같이 그려야 할 연출. 전부 시각(ms)만 담는다(타이머 없음).
 * **객체는 루프가 하나만 만들어 계속 재사용한다** — 매 프레임 새로 만들면 GC 가 60fps 를 갉아먹는다.
 */
export interface BoardFx {
  now: number;
  /** 직전 프레임과의 간격(ms) — 파티클 적분용 */
  dt: number;
  /**
   * 줄 지움 (설계서 §Z4 — 가운데→바깥 5단계 와이프 + 파편 + 가로 광선).
   * `shift[r]` = 그 행이 몇 칸 내려앉아야 하는지(= 자기보다 아래에서 지워진 줄 수).
   * 엔진은 락 즉시 줄을 접어 버리므로, 낙하를 보여주려면 위 블록을 **접기 전 위치**에서
   * 시작해 제자리로 내려오게 그려야 한다.
   */
  clear: {
    rows: number[];
    start: number;
    ms: number;
    shift: number[];
    /** 락한 조각 색 — 색을 못 읽은 칸의 대체값 */
    color: string;
    /**
     * 지워진 칸의 **원래 색**. `rows[i]` 행 `c` 열 = `colors[i * COLS + c]`.
     * 이게 없으면 흰 섬광으로밖에 못 그린다(= 무슨 블록이 터졌는지 안 읽힌다).
     */
    colors: string[];
    /** 이미 파편을 뿌린 와이프 단계(0..5). 루프가 단계가 넘어갈 때마다 하나씩 올린다. */
    shattered: number;
    /** 4줄/퍼펙트 — 바닥 폭발(밴드에서 빛이 번짐)까지 얹는다 */
    big: boolean;
  } | null;
  /** 하드드롭 잔상 */
  trail: { cols: number[]; fromRow: number; toRow: number; color: string; start: number } | null;
  /** 락 화이트 플래시 */
  lock: { start: number } | null;
  /** 쓰레기 줄이 밀고 올라온 직후(아래→위 슬라이드) */
  rise: { start: number } | null;
  /** 화면 흔들림 — 사건별 세기/방향/길이 (fx.ts SHAKE 표) */
  shake: ShakeState | null;
  /** 4줄 — 판 전체 시안 플래시 + 세로 광선 */
  beam: { start: number } | null;
  /** T-스핀 — 보라 파문(보드 칸 좌표) */
  ring: { x: number; y: number; start: number } | null;
  /** 퍼펙트 클리어 — 판 전체 화이트 플래시 */
  flash: { start: number } | null;
  /** 락 딜레이 진행도 0..1. >0 이면 조각이 깜빡여 "곧 굳는다"가 눈에 보인다 */
  lockDelay: number;
  /** 현재 콤보 — 테두리 글로우 */
  combo: number;
  /** 0..1 위험도 — 테두리 빨간 맥박 + 미세 상시 떨림 */
  danger: number;
  /** `prefers-reduced-motion` — 와이프만 남기고 파편·폭발은 생략한다(§Z4) */
  reduced: boolean;
  /** 줄 파편/착지 먼지. 풀이라서 배열이 새로 생기지 않는다 */
  particles: ParticleField;
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

    // 흔들림을 1/4 로 줄인다(끄지 않는 이유: 0 이면 "맞았다/지웠다"가 아예 전달되지 않는다).
    const reduced = prefersReducedMotion();
    const shakeScale = reduced ? 0.25 : 1;
    const particles = new ParticleField();
    const shakeOut: ShakeOut = { x: 0, y: 0, rot: 0, power: 0 };
    /** 낙하 연출용 행 이동량 버퍼 — 줄 지울 때마다 새 배열을 만들지 않는다 */
    const clearShift: number[] = new Array(ROWS).fill(0);
    /** 지워진 줄의 원래 색 버퍼(최대 4행 × 10칸). 락마다 덮어쓰기만 한다 */
    const clearColors: string[] = new Array(4 * COLS).fill('#FFFFFF');
    /**
     * 화면에 그릴 셀 버퍼. **길이를 미리 맞춰 둬야** `engine.toCells` 가 이 배열을 재사용한다
     * (빈 배열로 두면 길이 검사에 걸려 매 프레임 200칸 배열을 새로 만든다 = GC 폭탄).
     * 줄 지움 색도 여기(= 접히기 직전 프레임)에서 읽는다.
     */
    const renderCells: number[] = new Array(ROWS * COLS).fill(0);

    const fx: BoardFx = {
      now: performance.now(), dt: 16, clear: null, trail: null, lock: null, rise: null,
      shake: null, beam: null, ring: null, flash: null,
      lockDelay: 0, combo: 0, danger: 0, reduced, particles, alive: true,
    };

    /** 사건별 세기로 흔든다 — 약한 사건이 강한 사건을 덮어쓰지 않는다(fx.ts strongerShake). */
    const bump = (ev: Parameters<typeof strongerShake>[2], power?: number) => {
      fx.shake = strongerShake(fx.shake, performance.now(), ev, power);
    };

    /** 마지막으로 살아 있던 조각 — 락 직후에는 이미 다음 조각이 스폰돼 색/위치를 잃는다. */
    const lastPiece = { id: 1, x: 3, y: 0 };
    /** 락 직전의 대기 쓰레기 수. 락에서 줄어들었으면 = 이번에 실제로 밀려 올라왔다는 뜻. */
    let prevPending = 0;
    const notePiece = () => {
      prevPending = engine.pendingCount(state);
      if (state.piece) {
        lastPiece.id = state.piece.id;
        lastPiece.x = state.piece.x;
        lastPiece.y = state.piece.y;
      }
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
      const t0 = performance.now();
      fx.lock = { start: t0 };
      const pieceColor = PIECE_COLORS[lastPiece.id] ?? '#FFFFFF';

      if (lock.cleared > 0) {
        // 엔진이 kind/combo/b2b 를 확정해서 준다 — 소켓 페이로드와 배지가 어긋날 여지가 없다.
        const kind: ClearKind = lock.kind ?? PLAIN_KIND[Math.min(3, lock.cleared - 1)];
        const b2b = lock.b2b;
        const rows = lock.rows.filter((r) => r >= 0 && r < ROWS);
        const big = lock.cleared >= 4 || lock.perfect;

        // shift[r] = 자기보다 **아래에서** 지워진 줄 수 = 내려앉을 칸 수.
        for (let r = 0; r < ROWS; r++) {
          let n = 0;
          for (const cr of rows) if (cr > r) n++;
          clearShift[r] = n;
        }
        // 접히기 직전 프레임(renderCells)에서 그 줄의 **원래 색**을 읽어 둔다 (§Z4-2).
        // 엔진은 락 즉시 줄을 접으므로 이 순간이 지나면 무슨 색이 터졌는지 알 방법이 없다.
        // 복사는 락당 1회, 최대 4행 × 10칸.
        for (let i = 0; i < rows.length && i < 4; i++) {
          const base = rows[i] * COLS;
          for (let c = 0; c < COLS; c++) {
            // 빈 칸/그림자 = 방금 놓은 조각이 메운 자리(직전 프레임엔 아직 없었다) → 조각 색.
            clearColors[i * COLS + c] = colorOfCell(renderCells[base + c] ?? 0) ?? pieceColor;
          }
        }

        fx.clear = {
          rows, start: t0, ms: clearMsOf(lock.cleared),
          shift: clearShift, color: pieceColor, colors: clearColors,
          shattered: 0, big,
        };
        // 파편은 루프가 **와이프 단계에 맞춰** 나눠 뿌린다(여기서 몰아 뿌리면 상한을 다 쓴다).

        // 흔들림 — 줄 수 → 세기. T-스핀/퍼펙트가 더 세므로 뒤에서 덮어쓴다.
        bump(shakeEventOfLines(lock.cleared));
        if (kind.startsWith('ts')) {
          bump('tspin');
          fx.ring = { x: lastPiece.x + 1.5, y: lastPiece.y + 1.5 - HIDDEN_ROWS, start: t0 };
        }
        if (lock.cleared >= 4) fx.beam = { start: t0 };
        if (lock.perfect) { bump('perfect'); fx.flash = { start: t0 }; }
        if (lock.combo >= 2) bump('combo', comboShakePower(lock.combo));

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
        // 콤보가 오를수록 **피치가 올라간다** — `match` 는 콤보 음계를 갖고 있어(sounds.ts)
        // 파일을 건드리지 않고도 상승감을 얹을 수 있다.
        if (lock.combo >= 2) playGameSound('match', { combo: lock.combo, gain: 0.5 });

        // 배지 하나만 띄운다 — B2B 는 뒤에 붙여서 화면에 두 개가 겹치지 않게.
        const base = lock.perfect ? 'PERFECT CLEAR!' : CLEAR_BADGE[kind];
        const badge = base && b2b ? `${base} B2B x${state.b2b}` : base ?? (b2b ? `B2B x${state.b2b}` : null);
        if (badge) store.getState().setBadge(badge, lock.perfect ? 'gold' : toneOfClear(kind));

        store.getState().pushFx({ type: 'clear', lines: lock.cleared, kind });
        // 화면(아레나 전체) 플래시 — 퍼펙트는 색이 달라야 해서 text 로 구분한다(스토어 타입 불변).
        if (lock.cleared >= 4 || lock.perfect) {
          store.getState().pushFx({
            type: 'screen', lines: lock.cleared, kind,
            text: lock.perfect ? 'perfect' : undefined,
          });
        }

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
        // 줄은 못 지웠지만 T-스핀은 인정 — 손맛을 위해 배지/소리/파문은 준다.
        bump('tspin', 5);
        fx.ring = { x: lastPiece.x + 1.5, y: lastPiece.y + 1.5 - HIDDEN_ROWS, start: t0 };
        playGameSound('tspin');
        store.getState().setBadge(lock.spin === 'mini' ? 'T-SPIN MINI' : 'T-SPIN', 'purple');
      } else {
        playGameSound('lock');
      }

      // 이번 락에서 쓰레기 줄이 실제로 밀고 올라왔다면 아래→위 밀림 연출.
      if (engine.pendingCount(state) < prevPending) {
        fx.rise = { start: t0 };
        bump('rise');
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
          // 잔상·먼지를 그리려면 **떨어지기 전에** 조각의 열과 낙하 거리를 재 둬야 한다.
          notePiece();
          const before = engine.toCells(state, opts);
          const cols: number[] = [];
          let fromRow = Number.POSITIVE_INFINITY;
          let bottomRow = -1;
          for (let i = 0; i < before.length; i++) {
            if (before[i] >= CELL_ACTIVE_BASE) {
              const c = i % COLS;
              if (!cols.includes(c)) cols.push(c);
              const r = Math.floor(i / COLS);
              if (r < fromRow) fromRow = r;
              if (r > bottomRow) bottomRow = r;
            }
          }
          const drop = state.piece ? engine.ghostY(state) - state.piece.y : 0;
          const dropColor = PIECE_COLORS[lastPiece.id] ?? '#FFFFFF';
          const res = engine.hardDrop(state);
          const now = performance.now();
          if (Number.isFinite(fromRow)) {
            fx.trail = {
              cols, fromRow, toRow: fromRow + Math.max(0, drop),
              color: dropColor, start: now,
            };
            // 착지 지점 먼지 — 잔상만 있으면 "멈춘 느낌"이 없다.
            particles.dust(cols, Math.min(ROWS - 1, bottomRow + Math.max(0, drop)), dropColor);
          }
          bump('drop');
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
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(MAX_DT, now - lastT);
      lastT = now;

      notePiece();
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
      fx.dt = dt;
      fx.alive = state.alive;
      fx.combo = state.combo;
      fx.lockDelay = state.piece && state.lockTimer > 0
        ? Math.min(1, state.lockTimer / engine.LOCK_DELAY_MS)
        : 0;
      // 줄 지움 파편 — 와이프 단계(가운데→바깥)가 넘어갈 때마다 **그 단계의 두 열**에서만
      // 뿌린다. 한 번에 다 뿌리면 첫 프레임에 상한(120)을 다 써서 바깥 열이 조용해진다.
      if (fx.clear && !reduced && fx.clear.shattered < WIPE_STAGES) {
        const cl = fx.clear;
        const reach = Math.min(WIPE_STAGES, Math.floor((now - cl.start) / WIPE_STAGE_MS) + 1);
        const per = cl.rows.length >= 3 ? 2 : 3;   // 4줄은 칸이 많으니 칸당 조각을 줄인다
        const half = COLS >> 1;
        while (cl.shattered < reach) {
          const s = cl.shattered++;
          const left = half - 1 - s;
          const right = half + s;
          for (let i = 0; i < cl.rows.length; i++) {
            const r = cl.rows[i];
            particles.shatterCell(left, r, cl.colors[i * COLS + left], per);
            particles.shatterCell(right, r, cl.colors[i * COLS + right], per);
          }
        }
      }
      if (fx.clear && now - fx.clear.start > fx.clear.ms) fx.clear = null;
      if (fx.trail && now - fx.trail.start > FX_MS.trail) fx.trail = null;
      if (fx.lock && now - fx.lock.start > FX_MS.lock) fx.lock = null;
      if (fx.rise && now - fx.rise.start > FX_MS.rise) fx.rise = null;
      if (fx.shake && now - fx.shake.start > fx.shake.ms) fx.shake = null;
      if (fx.beam && now - fx.beam.start > FX_MS.beam) fx.beam = null;
      if (fx.ring && now - fx.ring.start > FX_MS.ring) fx.ring = null;
      if (fx.flash && now - fx.flash.start > FX_MS.flash) fx.flash = null;
      particles.step(dt);

      // 위험도는 게이지(스토어)와 캔버스 테두리가 같은 값을 써야 눈이 헷갈리지 않는다.
      const danger = Math.min(1, stackHeight(state) / 20);
      fx.danger = danger;

      // 아레나 DOM 흔들림 — 스토어를 거치지 않고 transform 만 쓴다(리렌더 0회).
      shakeAt(fx.shake, now, shakeScale, shakeOut);
      if (danger >= 0.8 && state.alive && shakeScale > 0) {
        // 위험할 때의 **아주 미세한 상시 떨림** — 0.6px 이하라 거슬리지 않지만 긴장감을 준다.
        const micro = (danger - 0.8) * 3 * shakeScale;
        shakeOut.y += Math.sin(now / 47) * micro;
        shakeOut.x += Math.sin(now / 71) * micro * 0.6;
        shakeOut.power = Math.max(shakeOut.power, micro);
      }
      emitShakeFrame(shakeOut);

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
      bump('rise');
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
      // 언마운트 순간의 transform 이 DOM 에 굳지 않도록 0 프레임을 한 번 더 보낸다.
      shakeOut.x = 0; shakeOut.y = 0; shakeOut.rot = 0; shakeOut.power = 0;
      emitShakeFrame(shakeOut);
      particles.clear();
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
