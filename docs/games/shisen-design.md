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
| `game:spectate` | `{}` | `{ state }` | 플레이어→관전자(lobby) / playing 중 플레이어는 **기권**(`players[]`에 남아 보드·점수 계속 표시, 순위 최하위 그룹. 리매치하면 기권 표시가 풀리고 **그대로 다음 판 플레이어**로 남는다 — 빠지려면 로비에서 다시 `game:spectate`) |
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

---

# v3 — 넷마블 사천성 수준 고도화 (2026-09-23 새벽, 구현 계약)

사용자 피드백: 물음표는 클릭 시 **일회성 엿보기**(연결 실패하면 다시 숨김) / 초반에 같은 타일이 바로 옆에 붙어 너무 쉬움 → **난이도 설정** / 자물쇠 **종류(색)별 열쇠** / 리듬게임처럼 **화려한 콤보 연출** / 게임 방 안에 **게임 팩 여러 개**, 사천성 팩은 **넷마블 사천성** 방·인게임 UI 수준으로.

## W1. 규칙 변경
- **물음표(엿보기)**: `game:peek {idx}` → ack `{ ok:true, symbol }` (요청자에게만, 브로드캐스트 없음, 서버 상태 불변). 클라는 그 타일을 **첫 선택 상태로** 심볼을 보여 준다. 두 번째 선택이 성공하면 제거, 실패·선택 해제·다른 타일 선택 시 즉시 다시 `?`로 숨긴다(재클릭하면 다시 엿보기 가능, 횟수 제한 없음). `game:pick`은 숨김 타일도 **허용**(서버는 진실 심볼로 판정) → reason `'hidden'` 삭제. 인접 제거 시 자동 영구 공개(`game:revealed`)는 유지.
- **난이도** `difficulty: 1|2|3|4|5` (기본 3). 생성기 영향: (a) 심볼 다양성 — 사용 심볼 수 = `clamp(round(tiles/4 × [0.55,0.7,0.85,1,1][d-1]), 6, 28)` (낮을수록 같은 그림이 많아 쉬움); (b) 쌍 배치 거리 — 역재생에서 후보 쌍을 고를 때 가중치 `w = 1 + α·dist` (d=1: α=-0.6 → 붙은 쌍 선호, d=3: 0, d=5: α=+1.2 → 멀고 꺾인 쌍 선호; dist = 맨해튼 거리 + 꺾임 수×2). (c) d≥4는 초기 판에서 **인접한 같은 심볼 쌍의 수를 최대 2개**로 제한(재시도).
- **자물쇠 종류**: 열쇠 종류 수 `keyTypes` = s:1, m:2, l:3 (옵션 `specials.keys`가 true일 때). 인코딩 `LOCK_BASE=90` → 자물쇠 = `90+k`(k=1..3, 색 보임, 심볼 숨김), `KEY_BASE=100` → 열쇠 = `100+k`. (기존 `LOCKED=98`, `KEY_SYMBOL=100` 폐기.) 열쇠 k쌍 제거 시 그 종류의 자물쇠만 공개 → `game:unlocked { …, keyType:k, tiles }`. `Board.keysLeft` = 남은 열쇠 쌍 수. 역재생 순서 R의 앞 K쌍이 열쇠(k=1..K 순), 자물쇠는 그 뒤 쌍 중 종류별로 균등 배정. 색: k=1 빨강 `#F87171`, 2 파랑 `#60A5FA`, 3 초록 `#4ADE80`.
- **아이템(소모품, 넷마블식)**: `PlayerState.items: { hint: number; shuffle: number; wand: number }` (레이스 기본 힌트 3·재배치 2·여의봉 1, 쟁탈전은 공유 카운트를 각 플레이어에 미러). `hintsLeft` 필드는 `items.hint`로 대체.
  - `game:hint` 그대로(F1). 
  - `game:shuffle`(F2 재배치) → 자기 판(쟁탈전=공유 판) `shuffleNormals` 후 `game:shuffled {cause:'item', userId}`; 콤보 리셋.
  - `game:wand`(F3 여의봉) → 서버가 규칙상 유효한 쌍 하나를 골라 **제거**(`game:matched` userId=본인, `byItem:'wand'`, 점수 +10 고정, 콤보 리셋).
  - 잔여 0이면 `{ok:false, reason:'none'}`.
- 방해 아이템(공격) 규칙은 그대로.

## W2. 타입 변경
```ts
export type Difficulty = 1 | 2 | 3 | 4 | 5;
export interface GameOptions { boardSize; mapShape; specials; difficulty: Difficulty; items: boolean; timeLimitSec: number; }
export const LOCK_BASE = 90;  export const KEY_BASE = 100;  export const MAX_KEY_TYPES = 3;
export const isLock = (v) => v > LOCK_BASE && v <= LOCK_BASE + MAX_KEY_TYPES;
export const isKey  = (v) => v > KEY_BASE  && v <= KEY_BASE  + MAX_KEY_TYPES;
export const KEY_COLORS = ['#F87171', '#60A5FA', '#4ADE80'];
export interface PlayerItems { hint: number; shuffle: number; wand: number; }
PlayerState: hintsLeft 제거 → items: PlayerItems
UnlockedEvent: + keyType: number
MatchedEvent: + byItem?: 'wand'
ShuffledEvent.cause: 'stuck' | 'attack' | 'item'
PickReason에서 'hidden' 제거
```

## W3. 게임 방 UI (넷마블 참고, 프론트)
- **팩 선택 화면**(게임 방 생성 직후, 방장): 카드 그리드 — 사천성(활성), 테트리스(준비 중), 그 외 자리(빈 카드 "곧 추가"). 방장이 팩을 고르면 전원이 해당 팩 방으로 이동(`gameId`). 비방장은 팩 선택 화면에서 "방장이 게임을 고르는 중…" 대기.
- **사천성 방(로비) 레이아웃** (데스크탑 3컬럼 / 모바일 세로 스택):
  - 좌: **플레이어 컬럼** — 슬롯 4개 카드(색 아바타 이니셜, 닉네임, 방장 왕관, 오늘 밤 승/판, 준비 상태 점) + 관전자 칩.
  - 중: **설정 패널** — 상단 "맵 선택 ▸"(맵 썸네일 큰 미리보기 + 모양 그리드 팝오버), "개인전(레이스) / 쟁탈전" 큰 토글, **난이도 ? 1 2 3 4 5** 버튼 열(?=랜덤), 판 크기, 특수 타일, 제한 시간, 방해 아이템, 그리고 크고 붉은 **게임시작!** 버튼(Space 바 힌트). 비방장은 잠금 표시.
  - 우: **맵 가이드** — 선택된 맵 이름·설명·특수 타일 규칙 설명(물음표=엿보기, 숫자=순서, 자물쇠=같은 색 열쇠, 벽=통과 불가), 미리보기 실루엣.
  - 하단: **방 로그 스트립**(입장/퇴장/설정 변경/방장 이양 이벤트를 시간순으로, 클라 로컬 생성) + 나가기 / 방 닫기.
- **인게임 HUD**(넷마블 참고): 상단 카운터 바 — `남은 패 N` · `소거 가능 패 N`(movesLeft) · `F1 힌트 n` · `F2 재배치 n` · `F3 여의봉 n`(클릭 가능 버튼, 키보드 F1/F2/F3, 0이면 회색), 우측 큰 **`N등`**(실시간 순위: 레이스=남은 패 오름차순, 쟁탈전=지운 쌍). 좌측 **플레이어 컬럼**(아바타·닉·남은 패·진행 바·콤보) — 데스크탑에서 미니보드 대신/함께(미니보드는 컬럼 아래 작게), 모바일은 상단 스트립. 중앙 보드. 하단 좁은 상태줄(모드·시간).
- **콤보 연출(리듬게임식)**: `ComboBurst` — 콤보 ≥2에서 보드 중앙 위에 대형 텍스트 `N COMBO` (3중 레이어: 무지개/골드 그라디언트 채움 + 두꺼운 흰 스트로크 + 진한 그림자, 살짝 기울임), 숫자는 티어마다 커지고(2~3 작게, 4~6 중간, 7+ 크게) 등장 시 0.6→1.15→1 스프링 + 글로우 펄스, 주변 별·하트·다각형 파티클 방사(12~24개, 색 랜덤), 보조 콜아웃 `매치!`(항상) / `콤보!`(≥3) / `대단해요!`(≥6) / `완벽!!`(≥10) 이 다른 각도로 튀어나옴, 콤보 티어 상승 시 화면 가장자리 빛 줄기(레이 스윕). 콤보 끊기면 텍스트가 흔들리며 떨어져 사라짐. reduced-motion이면 텍스트만 짧게.
- 물음표 엿보기 UI: 클릭 → 카드 뒤집기 150ms로 심볼 표시 + 선택 링; 실패 시 붉은 링과 함께 다시 뒤집혀 `?`.
- 자물쇠/열쇠 색: `KEY_COLORS`로 자물쇠 테두리·열쇠 배경 색 구분, 해당 색 열쇠 쌍 제거 시 같은 색 자물쇠만 순차 flip.

## W4. 작업 분할
- **A7 backend**: W1·W2 전부(peek, pick 숨김 허용, 난이도 생성, 색 자물쇠, 아이템 3종), selfcheck(난이도별 인접 동일쌍 수·심볼 수 통계, 색 자물쇠 규칙 재생, 여의봉/재배치 카운트).
- **B8 frontend**: W2 복제 반영, W3 전부(팩 선택·3컬럼 방·맵 가이드·로그·인게임 HUD·N등·플레이어 컬럼·ComboBurst·엿보기·색 자물쇠·아이템 버튼/F키).
- **C3 Fable**: E2E 갱신(엿보기 실패 시 재숨김, 색 자물쇠, 여의봉/재배치, 난이도 1 vs 5 인접 동일쌍 수 비교) + 스크린샷 → 배포 + 데스크탑 0.1.27.

## v3 검증 결과 (2026-09-23, Playwright 3계정 자동 플레이 + 스크린샷)
- [x] 게임 방 만들기 → 팩 선택(사천성) → 넷마블식 3컬럼 방(플레이어 컬럼·설정·맵 가이드·방 기록) → 입장/관전 → 게임시작!
- [x] 난이도 1~5 반영(초기 판 인접 동일쌍 5→2, 백엔드 100판 통계 25.5→6.3), 옵션 병합 버그 수정
- [x] 물음표 엿보기: 클릭 시 심볼 표시+선택, 실패/해제 시 즉시 `?`로 복귀(서버 상태 불변)
- [x] 색 자물쇠·열쇠: 같은 색 열쇠 쌍 제거 시 그 색 자물쇠만 공개, keysLeft/HUD 색 점
- [x] F1 힌트 / F2 재배치 / F3 여의봉 소모품 카운트·키보드, 쟁탈전 공유 카운트(5/3/2)
- [x] 인게임 HUD(남은 패·소거 가능 패·아이템·N등·플레이어 컬럼), 관전자 HUD 정리
- [x] 리듬게임식 콤보 버스트(N COMBO 그라디언트 텍스트·콜아웃·파티클·플로팅 점수)
- [x] 리매치 시 기권자도 플레이어로 유지(설계 변경), 결과·전적·쟁탈전
- 부수: 로비 중앙 컬럼이 눌려 게임시작 버튼이 잘리던 레이아웃, 로컬 MySQL `rooms.slug` 유니크 인덱스 중복(sync alter) 정리
- [ ] 사운드 v2 실청취, 4인 동시, 모바일 `크게` 판 가독성

---

# v4 — 넷마블 사천성 인게임 레이아웃 이식 (2026-09-23 오전, 구현 계약)

참고 원본: 넷마블 사천성 공식 가이드(guide.asp?type=1..9)의 iframe 이미지 71장을 내려받아 확인
(`scratchpad/nm/img/img_guide*.jpg`). 특히 `img_guide3_02`(인게임 영역 번호 표시), `img_guide4_01/03`,
`img_guide5_02`(GOAL IN), `img_guide2_04`(방만들기 설정), `img_guide1_02`(상단 카운터 바).

## X0. 원본 레이아웃 요약 (그대로 이식할 구조)
```
┌───────────────────────────────────────────────────────────────┐
│ [남은 패 200][소거가능 패 15][F1 힌트 5][F2 재배치 4][F3 여의봉 1]      1등 │  ← 상단 와이드 바 + 우상단 등수
├──────────┬────────────────────────────────────────┬───────────┤
│ 프로필 2  │                                        │   진행    │
│ 프로필 3  │            내 플레이 보드(중앙)          │   게이지  │
│ 프로필 4  │                                        │  (세로)   │
├──────────┴────────────────────────────────────────┴───────────┤
│ [내 프로필]  [모드·맵·시간]     [관전자 스트립]        [나가기]   │
└───────────────────────────────────────────────────────────────┘
```
- 상단 카운터: 각 칸 = 작은 라벨(위) + 큰 숫자(아래). 아이템 칸은 클릭 가능 + F1/F2/F3.
- 좌측 프로필 카드: 등수 뱃지, 닉네임, **남은 패 큰 숫자**, 콤보 뱃지. → v4에서는 여기에 **그 사람 카메라**가 들어간다.
- 우측 세로 게이지: 플레이어별 마커(나/2/3/4)가 진행률 위치에 붙고, 완주 시 `GOAL IN!` 연출.
- 우하단 고정: 나가기(+기권).

## X1. 이번 라운드 확정 사항 (사용자 결정)
- 관전자 카메라 = **하단 작은 스트립**. 플레이어 카메라 = 좌측 프로필 카드 안.
- 넷마블 특수 맵(폭탄·이동·링크·힌트·리버스)은 **이번엔 제외**(다음 라운드 후보로 §X6에 기록).
- 아이템 횟수 = **방장이 방 설정에서 조절**.
- 레이스 중 상대 보드: 플레이어는 볼 수 없음. **관전자는 한 번에 한 명**(프로필 클릭으로 전환).

## X2. 규칙/서버 변경 (A10)
1. **물음표 자동 공개 완전 제거**. 인접 타일 제거로 `?`가 영구 공개되는 동작(`game:revealed` 브로드캐스트)을
   삭제한다. `?`는 오직 `game:peek`로 **본인에게만, 일회성**으로 보인다. 제거 시에도 이웃은 건드리지 않는다.
   (`RevealedEvent`/`game:revealed`는 프로토콜에서 삭제.)
2. **특수 타일 초기 배치 분산**: 같은 종류의 특수 타일이 처음부터 붙어 있지 않게 한다.
   - 열쇠: 한 쌍의 두 타일은 체비셰프 거리 ≥ 3. 서로 다른 색 열쇠끼리도 인접(8방향) 금지.
   - 자물쇠: 같은 색 자물쇠끼리 4방향 인접 금지(불가피하면 최대 1쌍까지 허용).
   - 숫자: 같은 숫자 두 타일은 체비셰프 거리 ≥ 3.
   - 물음표: 4방향 인접한 `?`가 전체 `?`의 25%를 넘지 않게.
   생성 후 제약 위반이면 심볼 자리 교환(같은 종류끼리 스왑)으로 보정하고, 30회 안에 못 맞추면 그대로 진행.
3. **아이템 횟수 옵션**: `GameOptions.tools: { hint: number; shuffle: number; wand: number }`
   (범위 hint 0~9, shuffle 0~9, wand 0~3. 기본 레이스 3/2/1, 쟁탈전 5/3/2 — 모드 전환 시 그 모드 기본값으로
   리셋, 그 외에는 유지). 게임 시작 시 각 플레이어 `items`의 초기값이 된다(쟁탈전은 공유 풀).
4. **진행률용 총량**: `Board.total: number`(초기 타일 수, 벽 제외) 추가. 스냅샷/`BoardPatch`에 포함.
   진행률 = `(total - remaining) / total`.
5. `PlayerState`에 `rank: number` 추가(서버가 계산한 실시간 등수: 레이스=남은 패 오름차순, 쟁탈전=지운 쌍
   내림차순, 완주자 우선). 동률은 같은 등수.

## X3. 인게임 화면 (B11)
- **상단 와이드 바**: `남은 패` · `소거 가능 패` · `F1 힌트 n` · `F2 재배치 n` · `F3 여의봉 n` — 넷마블처럼
  칸마다 위 라벨/아래 큰 숫자(font-display, tabular-nums), 아이템 칸은 버튼(0이면 흐리게)·F키 유지.
  우측 끝에 `N등`을 큰 숫자 + 작은 "등"으로.
- **좌측 프로필 컬럼**(폭 ~200px, 모바일은 상단 가로 스크롤):
  카드마다 ① 그 사람 **카메라 영상**(16:9, 라운드, 음소거, 카메라 꺼짐이면 색 이니셜 아바타)
  ② 등수 뱃지 ③ 닉네임(+왕관/나) ④ **남은 패 큰 숫자** ⑤ 진행 바 ⑥ 콤보 뱃지 ⑦ 완주/기권 태그.
  내 카드는 테두리 강조. 관전자 시점에서는 카드 클릭 = 그 사람 보드로 전환.
- **중앙 보드**: 내 판(관전자는 선택된 한 명)을 화면 중앙에 최대 크기로. 좌우 여백 균등.
- **우측 세로 진행 게이지**(폭 ~64px, 모바일은 숨김): 튜브 안에 플레이어별 마커(색 점 + `나`/등수)가
  진행률 위치(아래 0% → 위 100%)로 스프링 이동, 옆에 남은 패 수. 1위 마커에 빛나는 링. 완주 시
  화면 중앙에 `GOAL IN!` 팝(스케일+글로우, 1.2초 후 사라짐).
- **하단 바**: 좌측 모드·맵 이름·제한시간, 가운데 관전자 카메라 스트립(높이 ~56px, 가로 스크롤),
  우측 고정 `기권` + `나가기`(나가기는 게임 패널 닫기 = `game:spectate`/패널 닫기 아님, **방 게임에서
  나가기**이므로 플레이어면 기권 후 관전, 관전자면 패널 닫기).
- **오른쪽 카메라 열 제거**: 게임 패널이 열려 있는 동안 RoomPage의 비디오 컬럼/필름스트립을 렌더하지
  않는다. 카메라는 전부 게임 패널 안(프로필 + 관전자 스트립)에서만 보인다. LiveKit 트랙은 한 번만
  attach 되도록 주의(중복 attach 금지).

## X4. 로비 변경 (B11)
- **맵 선택**: 드롭다운/팝오버 폐지. 8종(랜덤 포함) 카드를 **한 번에 격자로** 보여 주고 각 카드가 실제
  실루엣 썸네일(`previewMask`)을 그린다. 클릭 즉시 선택. 선택 카드는 테두리 강조.
- **아이템 설정 행 추가**: `힌트`/`재배치`/`여의봉` 각각 숫자 칩(또는 −/+ 스테퍼). 방장만 편집.
- 나머지(난이도·판 크기·특수 타일·제한 시간·방해 아이템·게임시작!)는 유지.

## X5. 콤보 연출 수정 (B11)
- 콤보 텍스트는 **등장 후 즉시 사라진다**: 총 수명 700ms(등장 180ms → 유지 220ms → 퇴장 300ms),
  같은 시점에 **최대 1개만** 표시(새 콤보가 뜨면 이전 것 즉시 교체). 현재처럼 여러 개가 겹쳐 남는 일이
  없도록 fx 큐가 아니라 "현재 콤보 1개" 상태로 관리하고, 타이머는 항상 cleanup 한다.
- 플로팅 `+점수`도 수명 600ms 고정, 최대 4개.

## X6. 다음 라운드 후보 (넷마블 특수 맵)
폭탄 맵(폭탄 패 제거 시 막힌 블록 소거) · 이동 맵(제거 후 타일이 밀림) · 링크 맵(떨어진 영역 연결) ·
힌트 맵(돋보기 타일) · 리버스 맵(타일 뒤집힘). 이미지: `scratchpad/nm/img/img_guide6_0*.jpg`.

## v4 검증 결과 (2026-09-23, Playwright 3계정, 15개 체크 전부 PASS)
- [x] 맵 8종 격자 노출 + 카드 클릭 즉시 선택, 아이템 횟수 설정(`options.tools`)
- [x] `Board.total` / `PlayerState.rank` 제공, 상단 카운터 바·N등·좌측 프로필·우측 게이지 렌더
- [x] 열쇠 쌍 거리 ≥3, 열쇠끼리 인접 0, 숫자 쌍 거리 ≥3 (실판 측정)
- [x] 물음표 자동 공개 0건(인접 제거로 뒤집히지 않음), 엿보기는 일회성
- [x] 콤보 텍스트가 1.6초 뒤 0개 — 잔상 없음(원인: fxQueue 의존 effect가 타이머를 취소하던 문제)
- [x] 레이스에서 플레이어는 자기 판만, 관전자는 한 명씩(프로필 클릭 전환)
- [x] 게임 중 오른쪽 카메라 열 언마운트, 프로필 안 카메라 4개 재생, 관전자 하단 스트립
- 남음: 우측 진행 게이지 시인성 보강(B12), 사운드 실청취, 4인 동시
