# 테트리스 (방 안 미니게임 #2) — 구현 계약

작성 2026-09-23. 사천성(`shisen-design.md`)이 만든 **게임 방 프레임을 그대로 재사용**하고,
보드·규칙·연출만 새로 얹는다. 이 문서가 백엔드/프론트 공통 계약이다.

## T0. 사용자 결정 사항

| 항목 | 결정 |
|---|---|
| 대전 방식 | **대전(줄 보내기)** + **40줄 레이스** + **서바이벌(시간 압박)** 3종 |
| 조작 | **PC 키보드 전용**. 모바일은 관전(남의 판 구경)만 |
| 블록 규칙 | **현대 가이드라인** — 7-bag, 홀드, 다음 5개, 그림자, SRS 벽차기, T-스핀 인정 |

## T1. 권위 모델 — 클라 시뮬 + 서버 중재 (사천성과 다름)

사천성은 서버가 판을 소유했지만, 테트리스는 **입력 지연이 손맛을 직접 망가뜨린다**
(DAS/ARR 단위가 10ms대). 그래서:

- **클라이언트**가 60fps 시뮬레이션 전부를 돈다 — 즉시 반응.
- **결정론**: 조각 순서는 `snapshot.seed` → `mulberry32` → 7-bag 으로 **모두 동일**.
  레이스 모드의 공정성은 이것으로 보장된다.
- **서버**가 소유하는 것: 시드, phase/카운트다운, **쓰레기 줄 계산·대상 선택·전달**,
  탈락/완주 판정과 등수, 결과·누적 전적, 레이트 리밋.
- 클라는 8Hz로 자기 판 스냅샷을 올리고, 서버가 묶어서 모두에게 돌려준다(상대 미니보드).

치팅 방지는 목표가 아니다(사내 화상회의 방). 서버는 단조 증가 검사와 초당 공격 상한만 본다.

## T2. 타입

`backend/src/games/tetris/types.ts` ↔ `frontend/src/games/tetris/types.ts` (KEEP IN SYNC 쌍, 백엔드가 원본).
공유 `games/types.ts` 변경은 3가지뿐:
- `GameId = 'shisen' | 'tetris'`
- `PlayerState`에 `lines: number; ko: number` 추가(사천성은 0)
- `GameSnapshot`에 `tetris: TetrisOptions | null` 추가

필드 크기: `COLS=10`, `ROWS=20`(보이는 행), `HIDDEN_ROWS=2`(스폰 버퍼, 렌더 안 함).

## T3. 소켓 프로토콜 (`tetris:` 네임스페이스)

게임 개설/입장/설정/시작/결과/재대결/닫기는 **기존 `game:*` 를 그대로 쓴다.**
`game:updateOptions` 가 `{ gameId:'tetris', tetris: Partial<TetrisOptions> }` 를 받도록 확장한다.

| 이벤트 | 방향 | 페이로드 | 설명 |
|---|---|---|---|
| `tetris:frame` | C→S | `TetrisFrame`(userId 제외) | 내 판 스냅샷. **초당 15회 상한**, 넘으면 조용히 버림 |
| `tetris:frames` | S→전원 | `TetrisFramesEvent` | 8Hz로 모아서 브로드캐스트 |
| `tetris:clear` | C→S | `TetrisClearMsg` | 줄을 지웠다 → 서버가 공격량 계산 |
| `tetris:garbage` | S→대상 | `TetrisGarbageEvent` | 쓰레기 줄 `amount` + 구멍 열 `holes` |
| `tetris:sent` | S→전원 | `TetrisSentEvent` | 공격 연출(투사체)용 |
| `tetris:rise` | S→전원 | `TetrisRiseEvent` | 서바이벌 바닥 상승 |
| `tetris:topout` | C→S | `{}` | 내가 죽었다 → 서버가 등수 부여 |
| `tetris:finish` | C→S | `{ timeMs, lines }` | 레이스 목표 달성 |
| `tetris:down` | S→전원 | `TetrisDownEvent` | 누가 떨어졌다(KO 연출) |
| `tetris:finished` | S→전원 | `TetrisFinishEvent` | 누가 완주했다 |

### T3.1 공격량 계산 (서버)

```
base   = GARBAGE_BASE[kind]
combo  = COMBO_TABLE[min(combo, last)]
b2b    = b2b ? B2B_BONUS : 0
pc     = perfect ? PERFECT_CLEAR_BONUS : 0
raw    = floor((base + combo + b2b + pc) * options.garbageMul)
```
**상쇄**: 대상이 아직 못 받은 `pending` 이 있으면 먼저 깎는다(클라가 자기 pending 을
소진하고 남은 만큼만 `tetris:clear` 에 실어 보내는 게 아니라, **서버가 상쇄 원장을 들고 있다**).
서버는 각 플레이어의 `pending` 을 알고 있으며, 공격자 자신의 pending 을 먼저 상쇄한 뒤 남는
양만 상대에게 보낸다.

**대상 선택(versus, 3인 이상)**: 살아 있는 사람 중 `lines` 가 가장 많은 사람(선두)을 친다.
동률이면 랜덤. 2인이면 무조건 상대.

**구멍 열**: 서버가 시드 rng 로 정한다. 한 번의 공격 묶음은 **같은 열**에 구멍(가이드라인 방식),
단 4줄을 넘으면 4줄마다 열을 바꾼다.

### T3.2 종료 조건

- **versus**: 살아 있는 사람이 1명 이하 → 종료. 마지막 생존자 1등. 먼저 죽은 순서의 역순이 등수.
- **sprint**: 모두가 완주하거나 `timeLimitSec` 만료 → 종료. 완주 시간 오름차순, 미완주는 지운 줄 내림차순.
- **survival**: 살아 있는 사람이 1명 이하 → 종료. 등수 규칙은 versus 와 동일.
- 혼자일 때도 성립한다(1인 플레이 허용).

## T4. 엔진 API (`frontend/src/games/tetris/engine.ts`, 순수 함수 + 상태 객체)

```ts
export interface TetrisState {
  field: Uint8Array;        // FIELD_ROWS * COLS, 값 = 0 | 1..7 | 8(garbage)
  piece: { id: PieceId; rot: 0|1|2|3; x: number; y: number } | null;
  hold: PieceId | 0; holdUsed: boolean;
  bag: PieceId[]; bagIndex: number; rng: () => number;
  next: PieceId[];
  lines: number; score: number; level: number; combo: number; b2b: number;
  pending: { amount: number; holes: number[] }[];   // 다음 락에서 올라올 쓰레기
  alive: boolean; ko: number;
  lockTimer: number; lockResets: number;
  gravityAcc: number;
}
export function createState(seed: number, opts: TetrisOptions): TetrisState;
export function spawn(s: TetrisState): boolean;            // false = 탑아웃
export function tryMove(s, dx, dy): boolean;
export function tryRotate(s, dir: 1 | -1): boolean;        // SRS 킥 테이블
export function hardDrop(s): LockResult;
export function softDropStep(s): boolean;
export function holdPiece(s): boolean;
export function tick(s, dtMs): TickResult;                 // 중력 + 락딜레이
export function ghostY(s): number;
export function applyGarbage(s, amount, holes): void;      // 즉시 밀어 올림(서바이벌 rise 포함)
export function toCells(s, opts): number[];                // 길이 200, 조각/그림자 오버레이 포함
export interface LockResult { cleared: number; kind: ClearKind | null; perfect: boolean; toppedOut: boolean; rows: number[]; }
```

규칙 수치(가이드라인):
- **중력**: `level` 1..10 → `[1000, 793, 618, 473, 355, 262, 190, 135, 94, 64]` ms/칸.
- **락 딜레이** 500ms, 이동/회전으로 **최대 15회** 리셋.
- **DAS 133ms / ARR 20ms**, 소프트드롭 = 중력 ÷ 20 (최소 15ms).
- **T-스핀**: 마지막 동작이 회전이고, T 중심 기준 네 대각 중 **3개 이상** 막혔으면 스핀.
  앞쪽 두 칸이 모두 막혔으면 정식, 하나만이면 **미니**. 킥 #5(마지막 오프셋)로 들어갔으면 정식.
- **Perfect Clear**: 줄을 지운 뒤 필드가 완전히 빈 경우.
- **쓰레기 줄 삽입 시점**: 조각이 **락된 직후**, 그 락에서 줄을 못 지웠을 때만.

## T5. 키 매핑 (PC)

| 키 | 동작 |
|---|---|
| ← → | 좌우 이동 (DAS/ARR) |
| ↓ | 소프트 드롭 |
| Space | 하드 드롭 |
| ↑ / X | 시계 회전 |
| Z / Ctrl | 반시계 회전 |
| A | 180° 회전 |
| Shift / C | 홀드 |
| Esc | 일시정지 안내(멀티라 실제 정지는 없음, 조작 안내 오버레이) |

방향키 스크롤을 막기 위해 `preventDefault`. 입력은 **게임 패널이 포커스일 때만** 먹는다.

## T6. 화면 (넷마블/현대 테트리스 혼합, 사천성 v4 프레임 계승)

```
┌──────────────────────────────────────────────────────────────┐
│ 상단 바: 지운 줄 · 레벨 · 시간 · 목표(레이스) · 효과음 토글      │
├────────┬──────────────────────────────┬──────────┬──────────┤
│ 좌:    │        내 보드 (지배적)        │ 상대 미니 │ 위험도    │
│ 프로필  │  ┌────┐ ┌──────────┐ ┌────┐  │  보드     │ 게이지    │
│ 카메라  │  │HOLD│ │  10 x 20 │ │NEXT│  │  (최대3)  │ (세로)    │
│ +줄수  │  └────┘ └──────────┘ └────┘  │           │           │
│ 4칸    │     ▲ 받을 줄 경고 바(좌측)     │           │           │
├────────┴──────────────────────────────┴──────────┴──────────┤
│ 관전자 카메라 스트립                        [나가기](우하단 고정) │
└──────────────────────────────────────────────────────────────┘
```

- **내 보드는 캔버스**로 그린다(200칸 DOM을 60fps 리렌더하면 버벅인다).
  상대 미니보드도 캔버스. 오버레이(콤보/배지/경고)만 DOM + framer-motion.
- **좌측 프로필**: 사천성 v4와 **같은 컴포넌트**(`ProfileVideo`) 재사용. 카메라 + 닉네임 +
  지운 줄 수 + KO 수. 내 카드에 플레이어 색 링.
- **상대 미니보드**: 사용자가 처음 요청한 "테트리스 멀티처럼 옆에 상대 판" 그대로.
  클릭해도 확대되지 않는다(사천성 v2.1 결정 계승 — 내 판이 항상 제일 크다).
- **위험도 게이지**: 내 필드 최고 높이가 위험선(16행)을 넘으면 빨갛게 차오르고 맥박.

### T6.1 손맛 (juice)

| 순간 | 연출 |
|---|---|
| 이동/회전 | 짧은 클릭음, 조각 테두리 살짝 밝아짐 |
| 하드 드롭 | 낙하 잔상(트레일) + 착지 지점 먼지 + 화면 2px 진동 |
| 락 | 블록 1프레임 화이트 플래시 |
| 1~3줄 | 해당 줄 가로로 흰 섬광 → 수축, 파티클 |
| **테트리스(4줄)** | 화면 전체 시안 플래시 + 크게 흔들림 + `TETRIS!` 대형 배지 |
| **T-스핀** | 보라 육각 파문 + `T-SPIN DOUBLE!` |
| **B2B / 콤보** | 사천성 v2.1 `ComboBurst` 재사용 — 숫자가 **즉시 떴다 바로 사라진다**(v4 결정) |
| 공격 보냄 | 상대 미니보드로 네온 탄환이 날아감(`AttackFx` 재사용) |
| 공격 받음 | 좌측 경고 바가 빨갛게 차고, 올라올 때 판 전체가 아래에서 위로 밀림 |
| KO | 상대 판이 회색으로 무너져 내리고 `K.O.` 배지 |
| 레벨 업 | 상단 바 번쩍 + 상승음 |

### T6.2 사운드 (`games/sounds.ts` 확장)

`move, rotate, lock, harddrop, clear1, clear2, clear3, tetris, tspin, b2b, garbageIn, levelUp, ko`
추가. 기존 합성 방식(WebAudio, 자산 없음) 그대로. 테트리스는 시안 톤(밝은 벨),
T-스핀은 보라 톤(저음 + 벨), KO는 하강 글리산도.

## T7. 로비

`GameLobby` 는 `snapshot.gameId` 로 설정 패널만 바꾼다(`ShisenSettings` ↔ `TetrisSettings`).
좌측 플레이어 카메라 슬롯·관전자 스트립·방 로그·전적은 **그대로 재사용**.

`TetrisSettings` 항목: 대전 방식(3칩), 목표 줄 수(레이스), 시작 레벨(1~10 슬라이더),
레벨업 주기, 공격량 배수, 바닥 상승 주기(서바이벌), 홀드/그림자/다음 개수, 제한 시간.
우측 가이드 패널은 `MapGuide` 자리에 **조작법 + 공격량 표**를 띄운다.

## T8. 작업 분할

- **A-T1 (백엔드)**: `tetris/manager.ts`(공격 계산·대상·탈락/등수·프레임 릴레이·서바이벌 타이머),
  `gameManager` 의 gameId 분기, `gameSocket` 의 `tetris:*` 바인딩, `__selfcheck__` 확장.
- **B-T1 (프론트 엔진)**: `games/tetris/engine.ts` + `games/tetris/srs.ts` + 엔진 셀프체크 스크립트.
- **B-T2 (프론트 UI)**: `stores/tetrisStore.ts`, `hooks/useTetrisGame.ts`(루프·입력·소켓),
  `components/game/Tetris*.tsx`, `TetrisSettings`, `GamePanel`/`GameLobby`/`PackSelect` 분기.
- **C-T (검증, 페이블)**: Playwright 다계정 자동 플레이 + 스크린샷 육안 확인.

## T9. 검증 체크리스트

1. 팩 선택에서 테트리스가 **활성**이고 고르면 테트리스 로비로 간다
2. 설정 변경이 모든 참가자에게 전파된다
3. 시작 → 카운트다운 → 모두 **같은 조각 순서**로 시작한다
4. 키 입력이 즉시 반영된다(이동/회전/홀드/하드드롭)
5. 줄이 지워지고 점수·레벨·줄 수가 오른다
6. 4줄 = TETRIS 배지 + 공격 전송, 상대 `pending` 증가
7. 쓰레기 줄이 실제로 밀려 올라오고 구멍 열이 양쪽에서 동일하다
8. 상대 미니보드가 실시간으로 갱신된다(8Hz)
9. 탑아웃 → KO 연출 → 등수 부여 → 결과 화면
10. 레이스 40줄 완주 시 기록이 남고 순위가 시간순이다
11. 콤보 배지가 **즉시 사라진다**(v4 결정 계승)
12. 로비/아레나/관전 모두에서 카메라가 보인다
13. 모바일은 관전 레이아웃으로 떨어진다(조작 UI 없음)

---

## T10. 검증 결과 (2026-09-23, Playwright 3계정 자동 플레이 + 스크린샷 육안 확인)

세 모드 각각 독립 실행. **대전 23/23 · 레이스 24/24 · 서바이벌 23/23 PASS**,
사천성 회귀 스위트 **16/16 PASS**, 서버 셀프체크 **37/37**, 엔진 셀프체크 **57/57**.
스크립트: `scratchpad/e2e-tetris.mjs`.

확인된 항목: 팩 선택 활성 / gameId 전환 / 설정 전파 / 로비 카메라 / 카운트다운 →
**모두 같은 조각 순서**(시드 결정론) / 키 입력 즉시 반응(이동·회전·홀드) /
4줄 + 퍼펙트클리어 = 14줄 공격 전송 / 상대 pending 증가 / 상대 미니보드 8Hz 갱신 /
배지가 즉시 사라짐 / 탑아웃 → 등수 → 결과 / 레이스 완주 기록(2.4초) / 서바이벌 바닥 상승 /
결과 화면 문구 / 콘솔 에러 0.

### T10.1 검증 중 발견해 고친 실제 버그

1. **`callback?.(gameManager.x())` 단락 평가 — 치명적.**
   옵셔널 체이닝은 `callback` 이 없으면 **인자 식 자체를 평가하지 않는다.** 클라이언트는
   `tetris:clear` / `tetris:topout` / `tetris:finish` 를 ack 없이 쏘므로 **공격·탑아웃·완주가
   통째로 동작하지 않았다.** 9개 핸들러를 전부 "먼저 실행 → 그다음 ack" 로 고쳤다
   (사천성 `pick`/`peek`/`hint`/`shuffle`/`wand`/`close` 도 같은 모양이라 선제 수정 —
   지금은 전부 `emitWithAck` 라 겉으로 안 드러났을 뿐인 같은 함정이었다).
2. **레이스에서 공격이 나갈 수 있었다.** 설정 UI 는 "레이스에서는 공격이 없어요"라고
   안내하면서 배수 버튼은 살아 있었다. 서버 `onClear` 에 `mode==='sprint'` 차단을 넣고
   UI 버튼도 잠갔다.
3. **결과 화면이 사천성 문구를 썼다.** 테트리스는 `ResultRow.remaining` 이 **지운 줄 수**인데
   "4개 남음"으로 표시돼 정반대로 읽혔다 → `N줄 · 기록` 으로 분기.

### T10.2 남은 사항 (테트리스와 무관)

- `GridLayout`/`SpotlightLayout` 의 `AnimatePresence mode="popLayout"` 이 `memo(FeedCard)` 를
  감싸서 React 가 "Function components cannot be given refs" 경고를 낸다. **기존 문제**이고
  동작에는 지장이 없지만 popLayout 퇴장 애니메이션이 제대로 안 걸린다.
  고치려면 `FeedCard` 를 `forwardRef` 로 감싸고 ref 를 루트에 달면 된다.
