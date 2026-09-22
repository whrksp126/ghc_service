# 방 안 미니게임 — 사천성(Shisen-sho) 멀티플레이 설계서

작성 2026-09-23. 상태: **v1 확정 (구현 계약)**. 이 문서의 타입·이벤트·파일 경로는 백엔드/프론트 작업의 단일 계약이다. 바꿔야 하면 문서를 먼저 고친다.

## 0. 한 줄 요약

밤에 방에 남아 있는 사람들이 **카메라·음성은 켠 채로** 방 안에서 사천성을 같이 즐긴다.
각자 자기 판을 지우면서 상대 판을 실시간으로 옆에서 본다(테트리스 멀티 스타일).
모드는 3개: **레이스**(같은 판, 누가 먼저), **아이템 레이스**(레이스 + 방해 아이템), **협동**(한 판을 같이).
최대 4명 플레이, 나머지는 관전. 결과는 방이 살아 있는 동안 메모리에만 남는 "오늘 밤 전적판".
아키텍처는 `gameId`로 일반화해 두어 다음 게임(테트리스)은 엔진+보드 컴포넌트만 추가하면 된다.

---

## 1. 게임 규칙

### 1.1 판
- 격자 `cols × rows`, 각 칸은 `0`(빈칸) 또는 심볼 id `1..S`. 모든 심볼은 정확히 **4개**씩(=2쌍) 존재. `S = cols*rows/4`.
- 크기 프리셋 (`boardSize`):

| 값 | cols×rows | 타일 | 심볼 수 | 용도 |
|---|---|---|---|---|
| `s` | 8×5 | 40 | 10 | 빠른 한 판(1~2분) |
| `m` | 12×6 | 72 | 18 | 기본 |
| `l` | 14×8 | 112 | 28 | 협동 기본 / 긴 판 |

- 중력 없음(고전 규칙). 좌표는 `idx = r*cols + c`.

### 1.2 연결 규칙
두 타일 `a, b`가 **같은 심볼**이고, 빈칸만 지나는 **꺾임 ≤ 2회(선분 ≤ 3개)** 경로로 이어지면 제거 가능.
경로는 판 **바깥 테두리 1칸**(padding ring)을 지나갈 수 있다. 즉 `(cols+2)×(rows+2)` 패딩 격자 위에서 BFS/선분 스캔.
경로는 `Point[]`(패딩 좌표 기준이 아닌 **원 격자 좌표**, 바깥은 -1 또는 cols/rows 값 허용)로 반환해 클라이언트가 네온 선을 그린다. 꼭짓점만 담는다(시작, 꺾임점들, 끝) → 길이 2~4.

### 1.3 판 생성 — 풀이 가능 보장 (역재생 생성, 구현 반영 2026-09-23)
역재생 원리: 빈 판에서 시작해 쌍을 하나씩 **놓는다**. 놓을 때 두 칸이 "현재 빈칸만 지나서" 연결 가능해야 한다.
정당성: 정방향에서 X쌍 제거 시점에 비어 있는 칸 = X보다 먼저 제거된 쌍의 칸 = 역재생에서 아직 안 놓인 칸 = 현재 빈칸. 따라서 놓은 순서를 뒤집으면 반드시 끝까지 풀린다.

**주의(실측)**: 후보 쌍을 균등 랜덤으로 고르면 12×6 이상에서 거의 항상 막힌다(마지막에 남는 빈칸들이 서로 연결 불가). 실제 구현:
- 백엔드(`backend/src/games/shisen/engine.ts`): 가장 제약 많은 빈칸 우선 + 바깥→안쪽 순 배치, 4단계 백트래킹, 생성 후 그리디 풀이로 재검증. 600판 0실패, `l` 평균 2.4ms.
- 프론트 복제본은 "빈칸 집합의 격자 완전매칭 유지" 불변식으로 같은 보장(클라는 판을 만들지 않으므로 참고용).
난수는 시드 기반 결정적 `mulberry32(seed)`. 클라이언트는 판을 재생성하지 않고 서버가 준 `cells`를 그대로 쓴다.

### 1.4 막힘(데드락) 처리
플레이어가 순서를 다르게 지우면 막힐 수 있다. 매 제거 후 서버가 `findAnyPair()`로 검사 → 없으면 남은 타일을 **자동 셔플**(`shuffleRemaining`: 남은 타일 위치는 유지, 심볼만 재배치, 반드시 1쌍 이상 연결 가능할 때까지 재시도) 하고 `game:shuffled` 브로드캐스트. 페널티 없음(UI에 "막혀서 섞었어요" 토스트 + 타일 텀블 애니메이션).

### 1.5 점수·콤보
- 쌍 제거 = **+10점**.
- **콤보**: 직전 제거로부터 **2.0초 이내** 제거 시 `combo += 1`, 아니면 `combo = 1`. 점수 보너스 `+5 × (combo-1)` (콤보 2=+5, 3=+10 …, 상한 콤보 10).
- 잘못된 선택(연결 불가)은 점수 변화 없음, 콤보 리셋도 없음(짜증 방지). 단 클라이언트 흔들림 피드백.
- **힌트**: 판당 3회. 사용 시 연결 가능한 한 쌍을 서버가 골라 준다(해당 플레이어에게만). 힌트를 쓰면 **다음** 제거의 콤보가 1로 리셋된다(손맛 균형). 힌트 사용은 `game:state`(hintsLeft 반영)로 전파.

### 1.6 모드별 승패
- **레이스 (`race`)**: 전원 동일 `cells`. 누군가 **먼저 다 지우면 즉시 종료**. 순위 = 다 지운 사람(완주 시간 오름차순) → 못 지운 사람(남은 타일 오름차순 → 점수 내림차순). 상한 시간 `timeLimitSec`(기본 300, 0=무제한) 초과 시 같은 순위 규칙으로 종료.
- **아이템 레이스 (`race` + `items: true`)**: 레이스 규칙 + §1.7 방해. 방해 효과는 `effects`로 판에 걸린다.
- **협동 (`coop`)**: 보드 하나(`boardId: 'shared'`), `l` 사이즈 기본. 모두가 같은 판을 클릭. 선택은 (a,b) 원자 제출이므로 충돌 시 나중 요청은 `reason: 'gone'`(클라는 토스트 없이 타일 플래시만, 롤백 금지 — 이미 사라진 타일). 타이머는 카운트업. 다 지우면 종료 → 결과는 **팀 기록(클리어 시간, 모든 row의 `timeMs`)** + 개인 기여도(`pairsCleared` 내림차순, 점수 타이브레이크). 협동은 힌트 공유 5회(모든 플레이어 `hintsLeft`에 미러).

### 1.7 방해 아이템 (`items: true` 일 때만)
- **공격 게이지** `attackMeter 0..3`: 콤보가 **3, 6, 9** 에 도달할 때마다 공격 1회 자동 발사. (게이지 UI는 콤보 진행도 표시)
- 대상: 나를 제외하고 **남은 타일이 가장 적은 플레이어**(선두). 동률이면 랜덤. 이미 완주했거나 나간 사람 제외. 대상이 없으면 발사 안 함.
- 공격 종류는 발사 시 서버가 **랜덤** 선택:

| type | 효과 | 지속 |
|---|---|---|
| `freeze` | 대상 판 클릭 불가(선택 즉시 거부 `reason:'frozen'`), 서리 오버레이 | 3000ms |
| `fog` | 대상 판의 남은 타일 중 무작위 40%가 `?`로 가려짐(`payload.hidden: number[]`). 서버는 가려진 타일 선택도 **허용**(기억력 플레이) | 4000ms |
| `shuffle` | 대상 판 남은 타일 즉시 재배치(§1.4와 같은 함수, `game:shuffled cause:'attack'`). `Effect`는 남기지 않고 `AttackEvent.until = now+250`(연출 길이) | 즉시 |

- 효과는 `effects: {type, until}[]`로 스냅샷에 남는다(재접속 복구용). 서버는 `until` 지나면 자동 제거 & 별도 이벤트 없음(클라가 `until`로 스스로 끝냄).
- 협동 모드에는 아이템 없음(옵션 UI에서 비활성).

---

## 2. 공유 타입 (계약)

백엔드 `backend/src/games/types.ts`, 프론트 `frontend/src/games/types.ts` **동일 내용** (헤더 주석 `// KEEP IN SYNC with <상대 경로>`). 패키지 공유 대신 복제한다 — 도커 빌드 컨텍스트가 각각이라서.

```ts
export type GameId = 'shisen';                      // 추후 'tetris'
export type GameMode = 'race' | 'coop';
export type BoardSize = 's' | 'm' | 'l';
export type GamePhase = 'lobby' | 'countdown' | 'playing' | 'finished';
export type AttackType = 'freeze' | 'fog' | 'shuffle';

export interface GameOptions { boardSize: BoardSize; items: boolean; timeLimitSec: number; }
export const DEFAULT_OPTIONS: Record<GameMode, GameOptions> = {
  race: { boardSize: 'm', items: false, timeLimitSec: 300 },
  coop: { boardSize: 'l', items: false, timeLimitSec: 0 },
};
export const BOARD_DIMS: Record<BoardSize, { cols: number; rows: number }> = {
  s: { cols: 8, rows: 5 }, m: { cols: 12, rows: 6 }, l: { cols: 14, rows: 8 },
};
export const MAX_PLAYERS = 4;
export const COMBO_WINDOW_MS = 2000;
export const COUNTDOWN_MS = 3000;

export interface Point { r: number; c: number; }   // 원 격자 좌표. 바깥 테두리는 -1 / cols / rows
export interface Effect { type: AttackType; until: number; hidden?: number[]; }

export interface Board {
  id: string;            // race: userId, coop: 'shared'
  cols: number; rows: number;
  cells: number[];       // 0 = empty
  remaining: number;     // 남은 타일 수
  effects: Effect[];
}

export interface PlayerState {
  userId: string; nickname: string;
  color: string;         // 플레이어 색 (서버가 PLAYER_COLORS 순서대로 배정)
  boardId: string;
  score: number; combo: number; maxCombo: number;
  pairsCleared: number;
  lastMatchAt: number;   // ms epoch, 0 = 없음
  hintsLeft: number;
  finishedAt: number | null;   // race 완주 시각
  connected: boolean;    // 소켓 끊김(10s 유예 중) 표시용
}

export interface ResultRow {
  rank: number; userId: string; nickname: string; color: string;
  score: number; timeMs: number | null; remaining: number; maxCombo: number; pairsCleared: number;
}

export interface ScoreboardRow { userId: string; nickname: string; wins: number; games: number; bestTimeMs: number | null; }

export interface GameSnapshot {
  gameId: GameId;
  phase: GamePhase;
  hostUserId: string;
  mode: GameMode;
  options: GameOptions;
  seed: number;
  startAt: number | null;      // countdown 시작 시 = now + COUNTDOWN_MS. playing 시작 시각
  endedAt: number | null;
  players: PlayerState[];      // 참가 순서
  boards: Record<string, Board>;
  spectators: { userId: string; nickname: string }[];
  results: ResultRow[] | null;
  scoreboard: ScoreboardRow[]; // 방 단위 누적(메모리)
  seq: number;                 // 판 상태가 바뀔 때마다 +1 (matched/shuffled/attack/state)
}

export const PLAYER_COLORS = ['#FE2C55', '#25F4EE', '#FACC15', '#A78BFA'];
```

`seq`는 클라이언트가 늦게 온 델타를 버리는 용도(스냅샷 `seq`보다 작거나 같은 델타 무시, `seq > snapshot.seq + 1`이면 갭 → `game:sync`). 발신 순서: `matched` < `attack` < `shuffled(attack)` < `shuffled(stuck)` < `state`.

---

## 3. 소켓 프로토콜 (`game:` 네임스페이스)

모두 방에 `room:join` 된 소켓만 사용 가능(`currentRoomId` 없으면 `{ error: '방에 먼저 입장하세요' }`). 플레이어 식별은 **userId** (한 유저가 여러 기기로 들어와도 플레이어는 1명; 같은 유저의 모든 소켓이 같은 플레이어를 조작). 방당 게임 1개.

### 3.1 클라이언트 → 서버 (ack)
| 이벤트 | payload | ack | 권한/조건 |
|---|---|---|---|
| `game:sync` | `{}` | `{ state: GameSnapshot \| null }` | 누구나. 패널 열 때·재접속 시 |
| `game:create` | `{ gameId, mode, options? }` | `{ state }` | 게임 없을 때. 생성자=host, 자동 플레이어 등록 |
| `game:join` | `{}` | `{ state }` | phase=lobby, 인원 < 4. 관전자→플레이어 |
| `game:spectate` | `{}` | `{ state }` | 플레이어→관전자(lobby) / playing 중 플레이어는 **기권**(`players[]`에 남아 보드·점수 계속 표시, 순위 최하위 그룹, 리매치 때 관전자로 이동) |
| `game:updateOptions` | `{ mode?, options? }` | `{ state }` | host, lobby |
| `game:start` | `{}` | `{ state }` | host, lobby, 플레이어 ≥ 1 (혼자 연습 허용) |
| `game:pick` | `{ a: number, b: number }` | `{ ok: true, path: Point[] } \| { ok: false, reason }` | playing 플레이어. reason: `'same'`,`'symbol'`,`'gone'`,`'nopath'`,`'frozen'`,`'phase'` |
| `game:select` | `{ idx: number \| null }` | (ack 없음) | playing 플레이어. 상대에게 내 첫 선택 표시용. 서버는 검증 없이 방 브로드캐스트(`game:peerSelect`, 발신자 제외). 클라는 50ms 스로틀 |
| `game:hint` | `{}` | `{ ok: true, pair: [number, number] } \| { ok: false, reason: 'none' }` | hintsLeft > 0. 서버가 hintsLeft 차감, 스냅샷 반영은 다음 `game:state`. 클라는 응답의 pair를 하이라이트 |
| `game:rematch` | `{}` | `{ state }` | host, finished → lobby로(플레이어·옵션 유지, 새 seed는 start 때) |
| `game:close` | `{}` | `{ ok: true }` | host 또는 방 owner. 게임 삭제, `game:state {state:null}` |

### 3.2 서버 → 클라이언트 (방 전체 브로드캐스트)
| 이벤트 | payload | 언제 |
|---|---|---|
| `game:state` | `{ state: GameSnapshot \| null }` | 로비 변화, 옵션 변경(모드 전환 시 `boardSize`·`timeLimitSec`만 새 모드 `DEFAULT_OPTIONS` 값으로 되돌리고 `mapShape`·`specials`는 유지, coop은 항상 items=false), 카운트다운 시작, playing 진입(판 배부), 힌트 사용, 재접속(`connected`), 리매치, 종료(`results` 포함), 삭제(null), 참가자 이탈 |
| `game:matched` | `{ seq, userId, boardId, a, b, path, combo, score, remaining, attack?: AttackEvent }` | 제거 성공마다. 발신자 **포함**(클라는 자기 것은 예측 확정으로만 씀) |
| `game:peerSelect` | `{ userId, idx }` | 발신자 제외 |
| `game:shuffled` | `{ seq, boardId, cells, cause: 'stuck' \| 'attack' }` | 자동 셔플·셔플 공격 |
| `game:attack` | `AttackEvent = { seq, from, to, boardId, type, until, hidden? }` | 공격 발사(matched에 붙여 보내고 **별도로도** 보냄 — 클라는 `game:attack`만 처리, matched.attack은 로깅용) |

playing 진입 시 `game:state`에 완성된 `boards`가 들어간다. 카운트다운은 `startAt` 기준으로 클라가 로컬 시계로 3-2-1을 그리고, 서버는 `startAt` 이후에만 `pick`을 받는다(그 전이면 `reason:'phase'`).

### 3.3 이탈·정리
- `performParticipantLeave`(10s 유예 후 실제 이탈) 시: 그 유저의 다른 소켓이 방에 남아 있지 않으면 → lobby면 플레이어/관전자에서 제거, playing이면 `connected=false`로 두고 30초 뒤에도 안 돌아오면 기권 처리. host가 나가면 다음 플레이어에게 host 이양, 플레이어 0명이면 게임 삭제.
- `forceCloseRoom` / 방 삭제 시 게임 삭제.
- 재접속(`room:join` 재실행) 후 클라가 `game:sync`로 복구.

---

## 4. 서버 구조

```
backend/src/games/
  types.ts              # §2
  shisen/engine.ts      # 순수 함수: mulberry32, generateBoard, findPath, findAnyPair, shuffleRemaining, countRemaining
  gameManager.ts        # Map<roomSlug, RoomGame>. 상태 전이·검증·타이머·공격·결과·전적판. io 의존 없음, 이벤트는 콜백/반환값으로
  gameSocket.ts         # registerGameHandlers(io, socket, ctx) — 이벤트 파싱(zod)·ack·브로드캐스트만
  __selfcheck__.ts      # `npx tsx src/games/__selfcheck__.ts`: 보드 100개 생성→역재생 풀이 검증, findPath 케이스, shuffle 보장, 성능(생성 < 50ms)
```
- `socketHandler.ts`에서 `room:join` 성공 직후 `registerGameHandlers(io, socket, { getRoomSlug: () => currentRoomId, user })` 호출(중복 등록 방지: 소켓당 1회, `socket.data.gameHandlersBound`). `performParticipantLeave`/`forceCloseRoom`에서 `gameManager.onParticipantLeft(slug, userId, stillInRoom)` / `gameManager.destroy(slug)` 호출.
- 서버가 **권위**: 모든 제거는 서버 검증. `findPath`는 `cells` 스냅샷으로 계산하므로 O(cols·rows) — 동시 4명 방 수십 개도 문제없음.
- 타이머: `timeLimitSec` 종료 타이머, 효과 만료(정리만), 끊김 기권 타이머. 게임 삭제 시 전부 clear.
- 전적판 `scoreboard`: 방 슬러그별 `Map`, race 1위=`wins+1`, 참여=`games+1`, `bestTimeMs`=완주 최단. coop은 games만. 방 삭제 시 함께 삭제.
- zod로 payload 검증(기존 라우트 관례). 에러 메시지 한국어, 로그 영어.

---

## 5. 프론트 구조

```
frontend/src/games/
  types.ts                 # §2 복제
  shisen/engine.ts         # 백엔드 engine.ts 복제(클라 예측용: findPath만 실제 사용)
  sounds.ts                # WebAudio 합성 효과음 (mp3 자산 없음). initGameAudio()는 첫 유저 제스처에서 AudioContext resume
frontend/src/stores/gameStore.ts
frontend/src/hooks/useGameSocket.ts
frontend/src/components/game/
  GamePanel.tsx            # 컨테이너. phase/역할별 분기 + 닫기. 방 안 게임 없음→Idle(모드 선택·만들기)
  GameLobby.tsx            # 모드·옵션·플레이어 슬롯(4)·관전자·시작 버튼·전적판
  ShisenArena.tsx          # 플레이어 수/역할별 레이아웃(§6.2), 카운트다운, 결과 오버레이 호출
  ShisenBoard.tsx          # 보드 1개: 타일 그리드 + SVG 경로 오버레이 + 파티클 + 효과 오버레이. props: board, player, interactive, cellPx, peerSelectIdx?, hintPair?
  ShisenTile.tsx           # 타일 1개 (memo)
  PlayerHeader.tsx         # 색 점·닉네임·남은 타일·점수·콤보 배지·힌트 남은 수·공격 게이지·상태 아이콘
  Countdown.tsx
  ResultsOverlay.tsx       # 순위/팀 기록 + 다시하기/로비/나가기
  Scoreboard.tsx           # 오늘 밤 전적
  AttackFx.tsx             # 공격 투사체(발사→대상 미니보드) + 피격 오버레이(freeze/fog/shuffle)
  symbols.ts               # 28개 심볼 {icon: LucideIcon, color} (§6.3)
```

### 5.1 gameStore (Zustand)
```ts
interface GameStore {
  isPanelOpen: boolean; openPanel(); closePanel();
  snapshot: GameSnapshot | null;
  applySnapshot(s), applyMatched(e), applyShuffled(e), applyAttack(e), applyPeerSelect(e)
  // 로컬 UI 상태
  selectedIdx: number | null;        // 내 첫 선택
  pendingPick: { a, b } | null;      // 서버 응답 대기(예측 적용됨)
  hintPair: [number, number] | null;
  peerSelect: Record<userId, number | null>;
  fxQueue: FxEvent[];                // 보드 컴포넌트가 소비하는 일회성 연출(경로, 팝, 공격 투사체, 셔플 텀블)
  pushFx(), consumeFx(id)
  me(): PlayerState | undefined; role(): 'player' | 'spectator' | 'none'
}
```
- `game:matched`가 **내 것**이면: pendingPick과 일치 → 확정(이미 예측 적용됨, seq만 갱신). 불일치/서버 상태와 어긋나면 `game:sync`로 복구.
- **클라 예측**: `pick` 전송과 동시에 로컬 `findPath`로 검증 → 성공이면 즉시 타일 제거·경로 애니·사운드. 서버가 `ok:false`면 롤백(타일 복구 + 흔들림). `frozen`/`gone`은 사운드 다르게.
- 상대 보드는 스냅샷 + 델타로만 갱신(예측 없음).

### 5.2 useGameSocket
`RoomPage` phase `inRoom`일 때 마운트. `socket.off(ev).on(ev, …)` 관례. 마운트/재접속(`room:join` 성공 후) 시 `game:sync`. `game:state`에서 진행 중(playing/countdown) 게임이 있고 내가 플레이어이면 패널 자동 오픈. 게임이 생성되면(누군가 `game:create`) 패널이 닫혀 있는 사람에게 토스트 "🎮 {닉네임}님이 사천성 방을 열었어요" + 하단 바 게임 버튼 뱃지 펄스.

### 5.3 RoomPage / BottomBar / uiStore 통합
- `BottomBar`에 `onToggleGame`, `gameBadge?: 'none' | 'lobby' | 'playing'` prop 추가. 아이콘 `Gamepad2`, 마이크 옆(주요 버튼). 뱃지: lobby=secondary 점 펄스, playing=primary 점.
- `gameStore.isPanelOpen`이면 인룸 본문(`RoomPage.tsx` `flex-1 min-h-0 relative` 영역)을 다음처럼 바꾼다:
  - **데스크탑(≥ md)**: `flex-row` — 왼쪽 `GamePanel`(flex-1), 오른쪽 비디오 컬럼 `w-[280px] shrink-0`에 기존 `GridLayout`(그대로 재사용, 열 솔버가 1열로 쌓음). 스포트라이트 모드는 게임 중엔 무시.
  - **모바일(< md)**: `flex-col` — 위에 비디오 필름스트립 `h-20`(가로 스크롤, FeedCard 축소), 아래 `GamePanel`(flex-1).
- 음성/카메라/화면공유는 그대로 동작. 카메라 끄는 건 유저가 알아서.

---

## 6. UI / 비주얼 / 손맛 스펙

### 6.1 톤
다크(`bg-dark-900`) 위의 네온. primary `#FE2C55`, secondary `#25F4EE`. 플레이어 색 `PLAYER_COLORS`. 유리(`.glass`) 패널. 폰트는 기존 sans, 숫자(점수·타이머)는 `font-display tabular-nums`.

### 6.2 아레나 레이아웃
- **2인**: 좌우 반반, 같은 크기. 내 판은 항상 **왼쪽**(관전자는 참가 순서).
- **3~4인, 플레이어 시점**: 내 판 왼쪽 큼(≈ 62% 폭), 오른쪽 컬럼에 상대 미니보드 세로 스택(`cellPx` 작게). 미니보드 클릭 시 임시로 크게 보기(토글) 가능.
- **관전자 시점**: 플레이어 수에 따라 1/2/2×2 그리드 균등. 클릭하면 확대.
- **협동**: 보드 하나 중앙 큼. 상단에 플레이어 칩(색·닉·기여 쌍 수·콤보) 가로 나열. 각자의 `peerSelect`는 그 사람 색 테두리로 표시.
- 보드 크기: 컨테이너에 맞춰 `cellPx = floor(min(W/cols, H/rows))`, 최소 22px(미니), 최대 64px. 타일 간격 4px. 모바일 세로에서는 판이 폭에 맞게 축소되고, 상대 미니보드는 내 판 **위**에 가로 스크롤 스트립.

### 6.3 타일
- 심볼 28개 = lucide 아이콘 + 네온 색. 예: Heart#FE2C55, Zap#FACC15, Star#FDE68A, Moon#A78BFA, Sun#FB923C, Cloud#93C5FD, Flame#F97316, Droplet#38BDF8, Leaf#4ADE80, Music#F472B6, Ghost#E9D5FF, Rocket#25F4EE, Diamond#67E8F9, Crown#FBBF24, Anchor#60A5FA, Bug#86EFAC, Cherry#FB7185, Bell#FCD34D, Umbrella#C084FC, Fish#7DD3FC, Pizza#FDBA74, Gamepad2#F9A8D4, Cat#FDE047, Snowflake#BAE6FD, Flower2#F0ABFC, Planet(=Orbit)#A5B4FC, Key#FCD34D, Skull#D4D4D8. (아이콘 이름은 lucide-react 1.x에 실제 존재하는 것으로 확인해서 쓴다.)
- 타일: `rounded-[10px]`, 배경 `dark-700`→`dark-600` 미세 그라디언트, 아이콘 색 + 아이콘 색 `15%` radial glow, 안쪽 하이라이트 1px. 크기 비율: 아이콘 = cell 55%.
- 상태
  - hover(포인터 기기): `translateY(-2px)` + 글로우 강화, 80ms.
  - **선택**: 테두리 2px `내 색` + 외부 글로우 + `scale 1.06` 스프링, 아이콘 살짝 흔들(pulse).
  - **상대 선택**(peerSelect): 상대 색 점선 테두리(미니보드에서도 보임).
  - **힌트**: 두 타일 노란 점멸 3회.
  - **제거**: 경로 SVG 폴리라인(선 4px, 색=플레이어 색, 바깥 글로우 필터) 120ms에 걸쳐 그려짐 → 두 타일 `scale 1.15 → 0` 160ms + 색 파티클 8개 방사(`AnimatePresence` 없는 가벼운 CSS/framer 조합) → 경로 200ms 페이드. 총 ≈ 350ms, 그 동안 다음 클릭 **가능**(입력 안 막음).
  - **실패**: 두 타일 좌우 흔들림 200ms + 붉은 플래시. `frozen`이면 서리 오버레이가 잠깐 밝아짐.
  - **fog**: 가려진 타일은 아이콘 대신 `?`, 뒤집힘 애니(rotateY) 150ms.
  - **freeze**: 판 위 반투명 하늘색 서리 + 균열 라인 + 남은 시간 원형 프로그레스. 클릭 시 흔들림.
  - **shuffle(공격/막힘)**: 남은 타일 전부 무작위 지연(0~200ms)으로 `rotate ±15°` + `scale 0.7`→새 심볼로 교체→복귀. 250ms.
- 콤보 배지: 헤더에 `x{combo}` 스프링 바운스, 티어 색 2~3 secondary / 4~5 primary / 6+ 그라디언트(primary→secondary) + 보드 테두리 은은한 글로우. 콤보 5 이상 제거 시 아레나 미세 흔들림(2px, 120ms).
- 공격 투사체: 발사자 헤더 → 대상 보드 중심으로 아이콘(❄️/🌫️/🌀 대응 lucide)이 곡선 비행 450ms, 도착 시 링 파동. 대상이 나면 화면 가장자리 붉은 비네트 200ms.
- 카운트다운: 아레나 중앙 `3`·`2`·`1`·`GO!` 각 `scale 1.6→1` + 페이드, GO는 secondary 색. 하단에 "같은 판이에요 — 누가 먼저?" 같은 모드 문구.
- 결과: 어두운 오버레이 위 순위 카드가 4위→1위 순으로 200ms 간격 슬라이드업, 1위 카드에 왕관 + 캔버스 컨페티(플레이어 색). 협동은 "팀 클리어 mm:ss" 크게 + 기여도 바.
- 남은 타일이 8개 이하이면 헤더 남은 수가 primary로 깜빡(막판 긴장).

### 6.4 사운드 (WebAudio 합성, `games/sounds.ts`)
`select`(짧은 블립 880Hz 30ms) · `match`(콤보에 따라 반음씩 올라가는 2음, 콤보 6+에서 화음) · `invalid`(120Hz 버즈 80ms) · `hint` · `attackSend`(스윕 업) · `attackHit`(노이즈 버스트 + 저음) · `shuffle`(빠른 트릴) · `tick`(카운트다운) · `go` · `win`(3음 아르페지오) · `lose`(하강 2음) · `finish`(협동 클리어). 마스터 볼륨 0.35, `uiStore`에 게임 효과음 on/off 토글(로비 헤더 스피커 아이콘). 모바일에서 `navigator.vibrate?.(10)` on match.

### 6.5 접근성·입력
- 클릭/탭 + 키보드(화살표로 커서 이동, Space/Enter 선택, Esc 선택 해제, H 힌트). 포커스 링은 선택 스타일과 구분(흰 1px).
- `prefers-reduced-motion`이면 파티클·흔들림 생략, 경로/팝만 짧게.
- 텍스트 전부 한국어.

---

## 7. 작업 분할

| 단계 | 담당 | 내용 | 완료 기준 |
|---|---|---|---|
| A | backend (Opus) | §2 types, §4 engine/gameManager/gameSocket, socketHandler 연결, selfcheck | `npm run build` 통과, `npx tsx src/games/__selfcheck__.ts` 전부 PASS |
| B1 | frontend (Opus) | types/engine 복제, gameStore, useGameSocket, GamePanel/Lobby/Arena/Board/Tile/Header/Countdown/Results/Scoreboard **기능 완성**(예측·롤백 포함), BottomBar/RoomPage 통합. 연출은 최소(선택 하이라이트·경로선·제거 페이드)만 | `npm run build`(tsc -b) 통과, 2인 레이스·협동 한 판 흐름 동작 |
| B2 | frontend (Opus) | §6 연출 전부: 파티클, 콤보 배지, 공격 투사체·피격 오버레이, 셔플 텀블, 카운트다운, 결과 컨페티, 사운드 합성, 키보드, reduced-motion | 빌드 통과 + 각 연출이 실제 이벤트로 트리거됨 |
| C | Fable | 크롬으로 2계정 실플레이 시각 검증·손맛 튜닝, 프로토콜 엣지(재접속·이탈) 검증, 배포 | 체크리스트 §8 전부 ✔ |

A와 B1은 병렬(계약=이 문서). B2는 B1 후 같은 에이전트가 이어서.

## 7.1 검증 도구
`portfolio_assets/_harness`의 Playwright(설치된 Chrome 채널)로 2계정(데모 김하늘/이서준) 동시 플레이를 자동 재현하는 스크립트를 세션 스크래치패드에 두고 돌렸다(로비→레이스→결과→협동→새로고침). 개발 빌드에서만 `window.__ghcGame = { store, engine }`(`stores/gameStore.ts` 끝)과 타일 `data-idx`/`data-sym` 속성을 노출해 자동 플레이가 가능하다.
부수 발견: HTTP `POST /rooms/:slug/join`이 같은 유저의 동시 요청에서 `room_members` 유니크 위반을 `throw`해 API 프로세스가 죽던 기존 버그 → 중복 시 재조회로 흡수 + `server.ts`에 `unhandledRejection` 로그 가드 추가.

## 8. 검증 결과 (C 단계, 2026-09-23 Playwright 다계정 자동 재현 + 스크린샷 육안 확인)
- [x] 로비: 만들기 → 참가/관전 전환 → 옵션 변경 전원 반영 → 시작
- [x] 레이스 2인: 같은 판, 상대 제거가 실시간 반영, 먼저 다 지우면 즉시 결과·전적판 갱신
- [x] 3인 레이아웃(내 판 크게 + 미니보드 스택) + 관전자/기권자 균등 그리드
- [x] 아이템: 콤보 3/6에서 공격 발사·선두 타겟, freeze/fog/shuffle 표시·`until`에 정확히 해제(프로브로 0.5s 간격 확인)
- [x] 협동: 동시 클릭 충돌 `gone` 시 롤백 없이 타일 수 정합(112→80, 8쌍+8쌍)
- [x] 예측 롤백(협동 충돌 경로로 검증)
- [x] 새로고침 후 `game:sync` 복구 + 플레이어 패널 자동 오픈, 호스트 이탈 시 이양, 전원 이탈 시 삭제
- [x] 모바일 400px 레이아웃(필름스트립 + 미니보드 스트립 + 내 판 상단 정렬)
- [x] 기존 방 기능(카메라 타일·마이크·하단 바) 회귀 없음, 콘솔 신규 경고 0(기존 `PopChild` ref 경고만)
- [ ] 막힘 자동 셔플 — 서버 selfcheck로만 검증(실플레이에서 막힘 미발생)
- [ ] 사운드·reduced-motion — 헤드리스에서 미검증(코드 리뷰만). 실기기에서 들어볼 것
- [ ] 4인 동시 + 네트워크 지연(throttling) 롤백 — 미실행

## 9. 다음 게임(테트리스) 확장 메모
- `GameSnapshot.gameId` 분기, `boards`의 `cells` 의미만 다름(테트리스: 10×20 + 현재 조각·다음 조각·가비지 큐). 서버 권위는 동일(입력 이벤트 `game:input {op}` + 주기 틱은 클라 로컬 시뮬 + 서버 검증 해시). 로비·전적판·아레나 레이아웃(좌우/미니보드)·공격 투사체·결과 오버레이는 그대로 재사용.

---

# v2 — 게임 방 흐름 개편 + 랜덤 맵·특수 타일 + 손맛/배경 (2026-09-23 밤, 구현 계약)

사용자 피드백: "게임 방을 만들고 → 그 안에서 어떤 게임을 할지 고르고 → 게임별 상세 설정으로 진행. 레이스/협동을 두 번 고르게 하지 말 것. 만든 사람이 방장, 나머지는 입장. 맵은 다양한 모양이 랜덤으로. ?타일·숫자 순서 타일 같은 걸 설정으로 켜고 끌 수 있게. 인터랙션 손맛과 배경을 더 게임답게."

## V1. 흐름 (프론트)
- **Idle**(게임 방 없음): 큰 버튼 하나 **"게임 방 만들기"**. 누르면 `game:create {}`(gameId·mode 없이) → 만든 사람이 방장(host).
- **Idle**(게임 방 있음, 내가 미참여): 카드 "**{방장}님의 게임 방** · 사천성 · 플레이어 n/4 · (대기 중|진행 중)" + 버튼 **입장**(`game:join`) / **관전**(`game:spectate`). 진행 중이면 입장 대신 관전만.
- **로비**: 위→아래로
  1. **게임 선택** 가로 카드: **사천성**(선택), **테트리스**(`준비 중` 비활성). 방장만 변경(`game:updateOptions {gameId}`; v2는 shisen만 허용, 다른 값은 `error`).
  2. **상세 설정**(게임별 컴포넌트, 사천성은 `ShisenSettings`): 방장만 편집, 나머지는 읽기 전용(칩이 비활성·현재값 강조).
     - 대전 방식: `레이스` / `협동` (칩. 상단 큰 카드 **삭제**)
     - 판 크기: 작게 / 보통 / 크게
     - 맵 모양: 랜덤 / 직사각형 / 다이아몬드 / 액자 / 쌍둥이 탑 / 피라미드 / 십자 / 얼룩
     - 특수 타일(다중 토글): 물음표 / 숫자 순서 / 열쇠·자물쇠 / 벽
     - 제한 시간, 방해 아이템(협동이면 비활성)
     - 미리보기: 현재 설정으로 만든 **맵 실루엣 썸네일**(클라에서 `previewMask(options, seed)`로 그림. 랜덤이면 "🎲 매 판 랜덤")
  3. 플레이어 슬롯 4 + 관전자 + 방장 왕관, **시작**(방장) / **나가기**(비방장→관전) / **방 닫기**(방장)
  4. 오늘 밤 전적
- 게임 종료 결과 오버레이의 "로비로"는 같은 설정으로 로비 복귀, "다시 하기"는 즉시 재시작(동일).

## V2. 타입 변경 (`games/types.ts` 양쪽 동일)
```ts
export type MapShape = 'random' | 'rect' | 'diamond' | 'frame' | 'towers' | 'pyramid' | 'cross' | 'blob';
export const MAP_SHAPES: MapShape[] = ['random','rect','diamond','frame','towers','pyramid','cross','blob'];
export interface SpecialToggles { mystery: boolean; numbers: boolean; keys: boolean; walls: boolean; }
export interface GameOptions {
  boardSize: BoardSize; mapShape: MapShape; specials: SpecialToggles; items: boolean; timeLimitSec: number;
}
export const DEFAULT_OPTIONS: Record<GameMode, GameOptions> = {
  race: { boardSize: 'm', mapShape: 'random', specials: { mystery: false, numbers: false, keys: false, walls: false }, items: false, timeLimitSec: 300 },
  coop: { boardSize: 'l', mapShape: 'random', specials: { mystery: false, numbers: false, keys: false, walls: false }, items: false, timeLimitSec: 0 },
};
// 격자(모양은 이 안에서 마스크) — 타일 수는 마스크가 정함(대략 s≈40, m≈72~80, l≈112~120)
export const BOARD_DIMS: Record<BoardSize, { cols: number; rows: number }> = {
  s: { cols: 10, rows: 6 }, m: { cols: 14, rows: 8 }, l: { cols: 18, rows: 10 },
};
// cells 인코딩
export const EMPTY = 0;
export const WALL = -1;          // 벽: 영구 점유. 선택 불가, 경로 차단, 셔플 대상 아님
export const LOCKED = 98;        // 자물쇠(플레이스홀더): 실제 심볼은 서버만 앎. 열쇠 쌍 제거 시 game:unlocked 로 공개
export const MYSTERY = 99;       // 물음표(플레이스홀더): game:reveal 또는 인접 제거로 공개
export const KEY_SYMBOL = 100;   // 열쇠 타일(정확히 1쌍)
export const NUMBER_BASE = 200;  // 숫자 타일: NUMBER_BASE + n (n=1..K, 각 n 1쌍). n 순서대로만 제거 가능
export const isNormalSymbol = (v: number) => v >= 1 && v <= 28;

export interface Board {
  id: string; cols: number; rows: number;
  cells: number[];            // 위 인코딩. 물음표/자물쇠는 플레이스홀더로 마스킹된 상태로 전송
  remaining: number;          // 벽 제외 남은 타일 수
  effects: Effect[];
  shape: Exclude<MapShape, 'random'>;   // 실제 결정된 모양(랜덤이면 서버가 고른 값)
  nextNumber: number;         // 숫자 순서 타일이 있으면 다음에 지워야 할 n, 없거나 끝났으면 0
  keysLeft: number;           // 열쇠 쌍 남았으면 1, 아니면 0
}
```
`GameOptions.mode`는 두지 않는다 — `GameSnapshot.mode` 그대로. `game:updateOptions { gameId?, mode?, options? }`(options는 **부분 병합** 허용). `game:create { gameId?, mode?, options? }` 전부 optional(기본 shisen/race/DEFAULT_OPTIONS.race).

## V3. 규칙 추가
- **맵 마스크**: 격자 위 타일 배치 집합. 프리셋(`rect`=꽉 채움, `diamond`, `frame`=테두리 두 겹+중앙 작은 덩어리, `towers`=좌우 탑+중앙 몸통(참고 이미지 1), `pyramid`, `cross`, `blob`=좌우대칭 랜덤 얼룩). `random`=매 판 프리셋 중 하나를 시드로 선택(`blob` 포함). 마스크 타일 수는 `4k`(열쇠 켜면 `4k+2`)가 되도록 대칭 유지하며 셀을 더하거나 뺀다. 마스크 밖 = `EMPTY`(처음부터 빈칸 → 경로 통과 가능).
- **벽**(`walls`): 마스크 안쪽 셀의 4~8%를 좌우대칭으로 `WALL`. 생성 시 미리 점유된 채로 역재생.
- **숫자 순서**(`numbers`): 역재생이 만든 제거 순서 R(정방향)에서 균등 간격으로 K쌍(작게 3, 보통 4, 크게 5) 골라 R 순서대로 1..K 부여 → 순서 규칙을 지켜도 반드시 풀림. 숫자 타일은 아이콘 없이 숫자만 보임. `nextNumber`가 아닌 숫자 선택 → `reason:'order'`.
- **열쇠·자물쇠**(`keys`): R의 **첫 쌍**을 열쇠(`KEY_SYMBOL`)로 치환(따라서 초기 판에서 반드시 연결 가능). 나머지 쌍 중 25%(쌍 단위)를 자물쇠로: 클라에는 `LOCKED`로 마스킹, 선택 시 `reason:'locked'`. 열쇠 쌍 제거 시 `game:unlocked {seq, boardId, tiles:[{idx,symbol}]}` 브로드캐스트(+ 스냅샷 반영).
- **물음표**(`mystery`): 일반 타일 중 20%(쌍 단위 아님, 개별)를 `MYSTERY`로 마스킹. 공개 조건 두 가지: (a) 플레이어가 그 타일을 클릭 → `game:reveal {idx}` → ack `{ok:true, symbol}` + 브로드캐스트 `game:revealed {seq, boardId, tiles:[{idx,symbol}]}` (선택으로 치지 않음, 콤보 무관); (b) 제거된 칸의 상하좌우 인접 물음표는 자동 공개(같은 `game:revealed`, `matched` 뒤에 emit). 공개된 뒤엔 일반 타일.
- **막힘 검사**는 규칙(순서·잠금·숨김은 "심볼은 아는 상태"로 취급)을 반영해 `findAnyMove(board)`. 없으면 일반 심볼(1..28, 공개/미공개 포함, 자물쇠 안 심볼 포함)만 셔플(벽·열쇠·숫자는 자리 고정). 20회 후에도 없으면 **막힘 해소 자동 제거**: 가장 낮은 규칙 장애(열쇠 남았으면 열쇠 쌍, 아니면 nextNumber 쌍)를 서버가 제거하고 `game:matched`(userId=`'system'`, path 빈 배열) + 토스트 "막혀서 한 쌍 정리했어요". selfcheck에서 이 경로가 1%도 안 타야 함.
- **셔플 공격**은 같은 셔플 함수(마스킹 유지: 자물쇠는 자물쇠 자리 그대로, 안의 심볼만 섞임).
- 클라 예측: 두 타일 모두 **일반 공개 심볼/숫자/열쇠**이고 규칙 통과(`canPick` = 같은 심볼 + 숫자면 nextNumber + 잠금 아님 + findPath)일 때만. `MYSTERY` 클릭은 `game:reveal`(뒤집기 애니 후 심볼 표시), `LOCKED`/`WALL` 클릭은 로컬에서 흔들림만.
- pick reason 추가: `'locked' | 'order' | 'hidden' | 'wall'`.

## V4. 엔진 API (백엔드 원본, 프론트 복제)
```ts
buildMask(shape: Exclude<MapShape,'random'>, cols, rows, rng, wantMod4Plus: 0|2): boolean[]   // 대칭 보정 포함
pickShape(rng): Exclude<MapShape,'random'>
generateBoardV2(opts: { cols, rows, mask, walls: boolean, numbers: 0|K, keys: boolean, mystery: boolean }, rng)
  → { cells: number[]  /* 서버 진실: 숨김 없음 */, hidden: number[], locked: number[], order: [number,number][] }
maskForClient(cells, hidden, locked): number[]   // MYSTERY/LOCKED 플레이스홀더 적용
canPick(view: { cells, nextNumber, keysLeft, cols, rows }, a, b): PickReason | null   // null = OK. 클라·서버 공용
findAnyMove(view): [number, number] | null
shuffleNormals(cells, hiddenSet, lockedSet, rng): number[]
previewMask(options, seed, sizeOverride?): boolean[]   // 로비 썸네일용(클라에서 호출)
```
서버 `RoomGame` 보드는 진실 `cells` + `hidden:Set` + `locked:Set` 을 들고, 스냅샷/델타로 나갈 때 `maskForClient`. `game:matched`의 `a,b`는 공개된 심볼로 제거되는 것이므로 클라는 그냥 0 처리.

## V5. 비주얼 v2 (프론트)
- **타일 = 상아색 마작 타일**(참고 이미지): 밝은 면(`#F5EFE4`→`#E7DFCF` 그라디언트) + 아래·오른쪽 2px 어두운 베벨 + 얇은 하이라이트 + 바닥 그림자. 아이콘은 채도 높은 색(기존 팔레트), 크기 58%. 다크 UI 위에 "게임 세계"로 떠 보이게.
  - 숫자 타일: 회색 석판(`#8A8F98`→`#6B7079`) + 굵은 숫자(font-display), `nextNumber`인 쌍은 은은한 노란 테두리 펄스.
  - 자물쇠: 어두운 석판 + 열쇠구멍 아이콘(lucide `Lock`); 열쇠 타일: 연두 배경 + `Key` 아이콘. 해제 시 자물쇠 전부 순차 flip(rotateY) 공개 + 잠금 해제 사운드.
  - 물음표: 황토색 타일 + 큰 `?`; 클릭/인접 공개 시 flip 150ms.
  - 벽: 나무 상자/돌(X 무늬) 타일, 살짝 낮게(그림자 약함), 클릭 시 꿈쩍 안 하는 미세 흔들림.
- **손맛**: pointerdown 즉시 `scale .93`(스프링), 선택 시 `translateY(-4px)` + **연두 글로우 링**(참고 이미지의 초록 선택), 두 번째 클릭 성공 시 두 타일이 서로를 향해 8px 튕긴 뒤 팝. 경로선은 굵기 5px + 흰 코어 + 색 글로우, 끝에 스파클 3개. 콤보 4+에서 팝 파티클 수 12. 실패 흔들림 + 짧은 붉은 링. 호버 시 3° 틸트(perspective).
- **배경/아레나**: 게임 패널 배경을 판마다 랜덤 테마 1개(시드로 결정, 스냅샷 `seed` 사용): `night`(짙은 남색 그라디언트 + 별 점묘 + 은은한 네온 오브), `wood`(따뜻한 원목 그라디언트 + `repeating-linear-gradient` 결), `stone`(회청 석판 + 노이즈). 보드는 `rounded-2xl` 트레이(반투명 어두운 판 + 안쪽 그림자) 위에 놓임. 헤더/HUD는 유리 스타일 유지. 전부 CSS/SVG로(이미지 자산 없음).
- 로비 맵 미리보기 썸네일: 마스크를 작은 사각형 점으로(벽은 어두운 점).

## V6. 작업 분할
- **A2 backend**: types v2, 엔진 v2(마스크·특수·canPick·findAnyMove·셔플), gameManager(옵션 병합·생성·pick 규칙·reveal·unlock·인접 공개·막힘 해소), gameSocket(`game:reveal`, create/updateOptions 완화, gameId 검증), selfcheck 확장(모양 8×크기 3×특수 조합 대표 12개 × 50판 규칙 준수 재생 풀이, 막힘 해소 경로 0%).
- **B4 frontend**: types/engine 복제, 로비 개편(V1), ShisenSettings + 미리보기, 타일 v2(V5), reveal/unlock/특수 클릭 처리·예측 조건, 아레나 테마 배경, 손맛, 결과/전적 유지.
- **C2 Fable**: E2E(2인 레이스 특수 4개 ON 랜덤 맵, 협동, 3인 아이템) + 스크린샷 검증 → 웹 배포 + 데스크탑 0.1.26.

## v2.1 — 사용자 피드백 2차 (2026-09-23 밤)
- **모드 명칭**: `race` = **"레이스"**(각자 독립된 판, 먼저 다 지우기), `coop` = **"쟁탈전"**(하나의 판을 나눠 먹으며 누가 더 많이·빨리 지우나). "협동"이라는 표현은 UI에서 제거. 쟁탈전 결과 순위 = 지운 쌍 수 내림차순 → 점수. 쟁탈전 중에는 상단에 **실시간 점수판**(플레이어별 지운 쌍·점수·콤보, 1위 배지)이 크게 보인다.
- **연결 가능 쌍 수**: `Board.movesLeft: number` — 서버 진실 판 기준(숨김·자물쇠 안 심볼 포함, 규칙 반영)으로 계산. 스냅샷과 `matched`/`revealed`/`unlocked`/`shuffled` 델타에 해당 보드의 `movesLeft` 포함. HUD에 "연결 가능 N쌍" 상시 표시(0이면 곧 재배치 안내, 보이는 판에서 못 찾겠는데 N>0이면 "물음표를 열어보세요" 힌트). 클라는 예측 제거 직후 로컬 `findAllMoves(view)`로 즉시 갱신하고 서버 값이 오면 덮어쓴다.
- **자동 재배치**: 타일이 남았는데 `movesLeft === 0`이면 서버가 즉시 셔플(기존 §1.4) — 예외 없이 항상. 클라는 "연결할 수 있는 타일이 없어 재배치했어요" 배너 + 텀블 애니.
- **레이스 레이아웃**: 플레이어 시점에서는 **항상 내 판이 메인(가장 크게)**, 상대 판은 옆/아래 미니(2인이어도 좌우 반반 금지). 상대 미니보드 클릭 확대 **제거**(플레이어). 관전자는 기존 균등 그리드+클릭 확대 유지.
- **콤보 연출**: 콤보 2 이상부터 아레나 중앙 상단에 큰 숫자 "×N COMBO" 팝(스케일 1.8→1 스프링 + 색 티어 + 살짝 회전, 400ms 후 페이드), 제거된 타일 자리에 "+점수" 플로팅 텍스트(위로 40px 떠오르며 페이드), 콤보 5 이상 화면 가장자리 색 플래시, 콤보 8 이상 "PERFECT!!" 급 문구 + 파티클 배증. 콤보가 끊기면 배지가 툭 떨어지는 애니.
- **효과음 v2**: 상큼·경쾌. 매치는 마림바/벨 계열 짧은 2음(콤보에 따라 스케일 위로 올라감, 4+에서 3화음), 선택은 밝은 "틱", 공개(?)는 반짝임, 잠금 해제는 상승 아르페지오, 셔플은 빠른 글리산도, 실패는 부드러운 "붑"(거슬리지 않게), 카운트다운 틱은 우드블록, GO는 밝은 팡파레, 승리 아르페지오, 콤보 티어 상승 시 추가 "샤랑". 각 소리는 2~3개 변형을 랜덤 재생해 지루하지 않게. 어택/디케이를 짧게(클릭 노이즈 없이).

## v2 검증 결과 (2026-09-23, Playwright 3계정: 방장 PC·입장 PC·모바일 관전)
- [x] 게임 방 만들기 → 방장 설정(작게·랜덤 맵·특수 4종 ON) → 입장/관전 카드 → 읽기 전용 로비
- [x] 랜덤 맵(cross/blob/frame/diamond 확인), 벽·물음표·자물쇠·열쇠·숫자 타일 렌더 = 스토어 셀 수 일치
- [x] 규칙: 숫자 순서(1→2→3), 열쇠 → 자물쇠 해제, 물음표 클릭 공개, 잘못된 순서/잠금 클릭 거부
- [x] matched 델타의 BoardPatch로 nextNumber/keysLeft/movesLeft 즉시 갱신(초기엔 stale로 막힘 → 수정)
- [x] 레이스: 내 판 메인 + 상대 미니(확대 불가), 헤더 카드(콤보 배지 포함), 완주·결과·전적
- [x] 쟁탈전: 실시간 점수판(왕관 이동), 모드 전환 시 맵/특수 설정 유지
- [x] 테마 배경(night/wood/stone), 상아색 타일, 콤보 팝/플로팅 점수(연출은 스크린샷 정지 프레임으로 부분 확인)
- [ ] 사운드 v2 실청취, 4인 동시, 모바일에서 `크게` 판은 타일이 작음(폭 맞춤) — 작게/보통 권장
- 부수 수정: 보드 크롭 캐시가 다음 판을 잘라내던 버그, 테마 배경이 헤더를 덮던 z-index, 경로 스파클 circle 초기 cx 미지정
