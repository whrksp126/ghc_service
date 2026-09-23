/**
 * 테트리스 "손맛" 엔진 (설계서 §T6.1).
 *
 * 여기에는 **React 를 절대 거치지 않는** 연출 계산만 둔다 — 화면 흔들림 수식, 파티클 풀,
 * 캔버스가 쓰는 보조 수학. 매 프레임 도는 코드이므로 배열/객체를 새로 만들지 않는다.
 * 규칙(`engine.ts`/`types.ts`)은 여기서 절대 참조하지 않는다(UI 전용).
 */

// ---------------------------------------------------------------- 화면 흔들림

/**
 * 흔들림 방향.
 * - `v` 세로 / `h` 가로 / `both` 세로+가로 / `rot` 회전감(가로 위주 + 미세 회전)
 * - `up` 아래에서 위로 밀림(쓰레기 줄) — 진동이 아니라 한 방향 밀림 + 잔진동
 */
export type ShakeDir = 'v' | 'h' | 'both' | 'rot' | 'up';

export interface ShakeSpec {
  /** 최대 진폭(px) */
  power: number;
  dir: ShakeDir;
  /** 지속 시간(ms) */
  ms: number;
}

/** 사건 이름 — 세기 표(설계서 요청)의 단일 출처. */
export type ShakeEvent =
  | 'drop' | 'clear1' | 'clear2' | 'clear3' | 'tetris'
  | 'tspin' | 'perfect' | 'combo' | 'rise';

/**
 * 사건별 흔들림 세기 표.
 * 값을 한곳에 모아 둬야 "하드드롭이 4줄보다 세게 흔들린다" 같은 감각 붕괴가 안 난다.
 */
export const SHAKE: Record<ShakeEvent, ShakeSpec> = {
  drop: { power: 2.5, dir: 'v', ms: 90 },
  clear1: { power: 3, dir: 'v', ms: 120 },
  clear2: { power: 5, dir: 'v', ms: 160 },
  clear3: { power: 7, dir: 'v', ms: 200 },
  tetris: { power: 11, dir: 'both', ms: 300 },
  tspin: { power: 8, dir: 'rot', ms: 260 },
  perfect: { power: 12, dir: 'both', ms: 400 },
  combo: { power: 2, dir: 'v', ms: 140 },
  rise: { power: 4, dir: 'up', ms: 200 },
};

/** 줄 수 → 흔들림 사건. 4줄 이상은 전부 테트리스 취급. */
export function shakeEventOfLines(lines: number): ShakeEvent {
  if (lines >= 4) return 'tetris';
  if (lines === 3) return 'clear3';
  if (lines === 2) return 'clear2';
  return 'clear1';
}

/** 콤보 세기 — 2px + combo×0.8, 최대 9px (요청 표). */
export function comboShakePower(combo: number): number {
  return Math.min(9, 2 + combo * 0.8);
}

export interface ShakeState {
  start: number;
  power: number;
  dir: ShakeDir;
  ms: number;
}

export interface ShakeOut {
  x: number;
  y: number;
  /** deg — 회전감(T-스핀) 전용 */
  rot: number;
  /** 지금 이 프레임의 진폭(px). Playwright 가 `data-ghc-shake-power` 로 읽는다 */
  power: number;
}

/** 진동 주파수(Hz). 26Hz 가 "툭" 치는 느낌, 17Hz 보조파가 기계적 반복을 깨 준다. */
const F_MAIN = 26;
const F_SUB = 17;

/**
 * 지수 감쇠 × 사인 진동.
 * `(1 - t)` 를 곱해 **끝에서 정확히 0** 이 되게 한다 — 지수만 쓰면 마지막에 툭 끊겨 싸구려로 보인다.
 * `out` 객체를 재사용한다(매 프레임 할당 금지).
 */
export function shakeAt(s: ShakeState | null, now: number, scale: number, out: ShakeOut): ShakeOut {
  out.x = 0; out.y = 0; out.rot = 0; out.power = 0;
  if (!s || scale <= 0) return out;
  const t = (now - s.start) / s.ms;
  if (t < 0 || t >= 1) return out;

  const env = Math.exp(-3.4 * t) * (1 - t);
  const p = s.power * scale * env;
  const w = ((now - s.start) / 1000) * 2 * Math.PI;
  const a = Math.sin(w * F_MAIN);
  const b = Math.sin(w * F_SUB + 1.1);

  switch (s.dir) {
    case 'v': out.y = p * a; break;
    case 'h': out.x = p * a; break;
    case 'both': out.x = p * b * 0.75; out.y = p * a; break;
    case 'rot': out.x = p * a; out.rot = p * b * 0.11; break;
    // 아래에서 밀려 올라오는 느낌 — 한 방향(위)으로 밀렸다가 잔진동하며 제자리로
    case 'up': out.y = -p * (0.6 + 0.4 * a); break;
  }
  out.power = Math.abs(p);
  return out;
}

/**
 * 새 흔들림이 기존 것보다 약하면 덮어쓰지 않는다.
 * (하드드롭 착지 → 곧바로 4줄 판정이 이어지는데, 약한 쪽이 강한 쪽을 지우면 김이 샌다.)
 */
export function strongerShake(
  cur: ShakeState | null, now: number, ev: ShakeEvent, powerOverride?: number,
): ShakeState {
  const spec = SHAKE[ev];
  const next: ShakeState = {
    start: now, power: powerOverride ?? spec.power, dir: spec.dir, ms: spec.ms,
  };
  if (!cur) return next;
  const t = (now - cur.start) / cur.ms;
  if (t >= 1 || t < 0) return next;
  const remaining = cur.power * Math.exp(-3.4 * t) * (1 - t);
  return next.power >= remaining ? next : cur;
}

/**
 * 아레나 DOM 과 게임 루프의 연결점.
 * 흔들림을 스토어에 넣으면 **매 프레임 아레나 전체가 리렌더**돼 오히려 프레임이 떨어진다.
 * 캔버스 painter 와 같은 싱글턴 패턴으로 DOM 에 직접 transform 만 쓴다.
 */
type ShakeSink = (o: ShakeOut) => void;
let sink: ShakeSink | null = null;
export function setArenaShaker(fn: ShakeSink | null): void {
  sink = fn;
}
export function emitShakeFrame(o: ShakeOut): void {
  sink?.(o);
}

// ---------------------------------------------------------------- 파티클 풀

/**
 * 동시 파티클 상한. 60fps 를 지키는 게 최우선이라 상한을 두고, **배열을 매 프레임 새로 만들지
 * 않는다**(고정 길이 Float32Array + swap-remove).
 */
export const PARTICLE_CAP = 120;

/** 셀 단위 중력(칸/초²). 판 크기가 달라져도 연출이 똑같이 보이도록 px 가 아니라 칸으로 센다. */
const GRAVITY = 26;

/**
 * 캔버스 전용 파티클 필드.
 * 좌표계는 **보드 칸**(x: 0..COLS, y: 0..ROWS)이라 셀 크기가 바뀌어도 그대로 재사용된다.
 */
export class ParticleField {
  n = 0;
  private readonly px = new Float32Array(PARTICLE_CAP);
  private readonly py = new Float32Array(PARTICLE_CAP);
  private readonly vx = new Float32Array(PARTICLE_CAP);
  private readonly vy = new Float32Array(PARTICLE_CAP);
  private readonly life = new Float32Array(PARTICLE_CAP);
  private readonly ttl = new Float32Array(PARTICLE_CAP);
  private readonly size = new Float32Array(PARTICLE_CAP);
  private readonly col: string[] = new Array(PARTICLE_CAP).fill('#ffffff');

  clear(): void {
    this.n = 0;
  }

  spawn(x: number, y: number, vx: number, vy: number, ttlMs: number, size: number, color: string): void {
    // 가득 차면 **가장 오래된 것을 덮어쓰지 않고 그냥 버린다** — 상한을 넘지 않는 게 더 중요하다.
    if (this.n >= PARTICLE_CAP) return;
    const i = this.n++;
    this.px[i] = x; this.py[i] = y;
    this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = 0; this.ttl[i] = ttlMs;
    this.size[i] = size; this.col[i] = color;
  }

  /**
   * 줄 지움 파편 (설계서 §Z4-3) — **사라지는 칸 하나**에서 2~4 조각이 좌우·위로 튀고
   * 중력에 떨어진다. 색은 그 칸에 실제로 있던 블록 색이어야 "무엇이 터졌는지"가 읽힌다.
   *
   * 줄 단위가 아니라 칸 단위인 이유: 와이프가 가운데→바깥 5단계로 진행되므로 파편도
   * 그 단계에 맞춰 나눠 뿌려야 한다. 한 번에 다 뿌리면 첫 프레임에 상한(120)을 다 써 버려
   * 정작 마지막 단계에서 아무것도 안 튄다.
   */
  shatterCell(col: number, row: number, color: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      this.spawn(
        col + 0.2 + Math.random() * 0.6,
        row + 0.2 + Math.random() * 0.6,
        side * (2 + Math.random() * 8),
        -3 - Math.random() * 5,
        220 + Math.random() * 180,
        0.13 + Math.random() * 0.16,
        Math.random() < 0.22 ? '#FFFFFF' : color,
      );
    }
  }

  /** 하드드롭 착지 먼지 — 낮고 옆으로 퍼진다. */
  dust(colsUsed: number[], row: number, color: string): void {
    for (const c of colsUsed) {
      for (let k = 0; k < 2; k++) {
        this.spawn(
          c + 0.2 + Math.random() * 0.6, row + 0.9,
          (Math.random() - 0.5) * 7,
          -1 - Math.random() * 2.2,
          180 + Math.random() * 160,
          0.1 + Math.random() * 0.14,
          Math.random() < 0.6 ? 'rgba(255,255,255,0.9)' : color,
        );
      }
    }
  }

  step(dtMs: number): void {
    const dt = dtMs / 1000;
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dtMs;
      if (this.life[i] >= this.ttl[i]) {
        // swap-remove — 배열을 다시 만들지 않는다
        const last = --this.n;
        if (i !== last) {
          this.px[i] = this.px[last]; this.py[i] = this.py[last];
          this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
          this.life[i] = this.life[last]; this.ttl[i] = this.ttl[last];
          this.size[i] = this.size[last]; this.col[i] = this.col[last];
        }
        i--;
        continue;
      }
      this.vy[i] += GRAVITY * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
    }
  }

  /** ox/oy = 보드 좌상단(px), cell = 한 칸 px. */
  draw(ctx: CanvasRenderingContext2D, ox: number, oy: number, cell: number): void {
    if (this.n === 0) return;
    ctx.save();
    for (let i = 0; i < this.n; i++) {
      const k = 1 - this.life[i] / this.ttl[i];
      const s = Math.max(1, this.size[i] * cell * (0.5 + k * 0.5));
      ctx.globalAlpha = k * k;
      ctx.fillStyle = this.col[i];
      ctx.fillRect(ox + this.px[i] * cell - s / 2, oy + this.py[i] * cell - s / 2, s, s);
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------- 보조 수학

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);

/** 콤보 티어 → 테두리 글로우 색. 콤보가 오를수록 뜨거워진다. */
export function comboGlow(combo: number): string {
  if (combo >= 8) return '#FACC15';
  if (combo >= 6) return '#FE2C55';
  if (combo >= 4) return '#A855F7';
  return '#25F4EE';
}
