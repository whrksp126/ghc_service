# GHC 보안 취약점 · 확장성 감사 (2026-06-10)

> 코드 탐색 + 핵심 사실 직접 검증 기반의 진단 기록.
>
> **상태 (2026-06-10 prod 배포 완료)**: B1·B2·B3·B5·B6 및 C1·C2·C3·C4·C5 적용 후 `bash deploy.sh --restart`로 배포(commit 7114304). 헬스체크 전부 OK, helmet/HSTS prod 확인, prod `backend/.env` 4개 시크릿 SET 확인(B2 fail-fast 통과). nginx limit_req_zone은 메인 nginx.conf 대신 ghc.conf 최상단에 선언(conf.d가 http 컨텍스트에서 include되므로 유효) → 메인 설정 미변경. 보류: B4의 JWT 30일 refresh 토큰 도입(LiveKit TTL만 4h로 단축). 참고: 같은 커밋에 앱다운로드/releases WIP도 함께 배포됨.

당시 스택: React 18 PWA + Node/Express + **LiveKit SFU**(mediasoup에서 전환됨, 메모리 `livekit-vs-mediasoup-decision`).
서버: 홈서버 `ghmate.iptime.org`, **회선 100Mb NIC(사용자 확인, 2026-06-10 시점)**.

---

## 1. 용량 판정 — "100명 / 방 40~50개 / 방당 1:1캠 + 라이브 1개, 버틸 수 있나?"

**결론: 현재 홈서버(100Mb NIC)로는 불가능. 회선과 CPU 두 군데서 막힌다. 지금 규모(1~2명)는 여유.**

### 경로 구조 (검증됨)
- **1:1 캠** = 디바이스 간 P2P WebRTC 프리뷰(`frontend/src/services/previewStream.ts`). SFU 미경유. **직접연결이면 서버 대역폭 0**, NAT 때문에 coturn 릴레이로 가는 분만 서버 대역폭 소모.
- **라이브** = OBS → RTMP → **LiveKit Ingress(트랜스코딩)** → 방 트랙 → 구독자에게 SFU fan-out (`backend/src/services/livekitService.ts:87` `createRoomIngress`).

### 부하 추정 (방 45개, 방당 라이브 1개, 시청자 1~2명 가정)
| 부하원 | 서버 업로드 영향 |
|--------|----------------|
| 라이브 SFU egress | 방당 2.5~5Mbps × 45 ≈ **110~225 Mbps** |
| 1:1 캠 TURN 릴레이(~10~30%) | ≈ **30 Mbps** |
| **합계** | **≈ 140~250 Mbps** → 100Mb(실효 ~90Mbit) 천장의 **1.5~2.7배 초과** |

### 두 개의 하드 천장
1. **회선 (100Mb)**: 현실적 동시 라이브 ≈ **8~15개**(시청자 1~2명 기준). 45개 불가.
2. **CPU — LiveKit Ingress 트랜스코딩**: RTMP→트랙 변환이 스트림당 ~0.5~1코어. 동시 라이브 45개 = 22~45코어 필요 → 홈서버(4~8코어)는 **라이브 ~5~10개**에서 먼저 막힘. **기가비트로 회선을 올려도 이 천장은 그대로.**

> 단일 홈서버 현실 규모: 동시 라이브 ~5~10개 + P2P 캠 ~20~30세션(직접연결 위주).

### 해결책 (우선순위)
1. **동시 라이브 수 상한 가드**(앱 레벨, ENV `MAX_CONCURRENT_LIVES`) — 비용 0의 안전장치. ingress 생성(`routes/rooms.ts`)에서 활성 ingress 카운트 검사.
2. **비트레이트 하향** — `frontend/src/lib/livekitRoom.ts:119-147`(desktop 3.5→2.0Mbps 등), 720p 단일레이어, OBS 권장값 문서화.
3. **미디어 오프로드(근본책)** — Ingress/SFU를 기가비트 VPS 또는 LiveKit Cloud로 분리. 시그널링/DB만 홈서버. (인프라 비용 결정 필요)
4. **대규모 시청 fan-out은 HLS/Egress 풀 방식** — 현재 Egress 미구현(`MediaFile` 모델만 존재).

### 인프라 부수 이슈
- `docker-compose.yml`: 서비스별 **CPU/메모리 한도 없음** → 한 컨테이너가 호스트 자원 고갈 가능. ingress/livekit/mysql에 `mem_limit`/`cpus` 권장.
- **로그 로테이션 없음**(coturn/livekit verbose stdout) → 장기 디스크 충전 위험. `logging: json-file max-size/max-file` 또는 호스트 logrotate.
- `deploy/nginx/ghc.conf`: `limit_req`/`client_max_body_size` 없음.
- DB 풀 `max:10`(`config/database.ts:12`) — 이 시그널링 부하엔 충분. 동시 입장 버스트 대비 15~20 소폭 상향은 선택.

---

## 2. 보안 취약점 (심각도 순, 검증 완료)

### 🔴 CRITICAL — `room:join` 접근통제 우회
- **위치**: `backend/src/signaling/socketHandler.ts:305-381`
- **내용**: 방 존재/활성(`is_active`)만 확인하고 **PIN·`RoomMember` 멤버십·`allow_viewers`를 검사하지 않은 채** `canPublish:true, canSubscribe:true` LiveKit 토큰 발급(`livekitService.ts:22-38`). HTTP `POST /rooms/:slug/join`의 PIN/멤버십 검사(`routes/rooms.ts:131-152`)가 실시간 경로에서 **완전 우회**됨 → slug만 알면 인증된 아무 사용자나 방에 입장·송출 가능. PIN 보호는 사실상 장식.
- **수정 방안**: `room:join`에서 `RoomMember` 멤버십 확인 + PIN 통과 세션만 허용. HTTP join 성공 시 단기(60초) 1회용 join-grant 발급(기존 inviteToken JWT 패턴 `rooms.ts:131-140` 재사용) → socket이 grant 검증 후 토큰 발급. viewer는 `canPublish:false`로 권한 차등.

### 🔴 CRITICAL — 시크릿 fallback 기본값
- **위치**: `middleware/auth.ts:4` `'ghc_dev_secret'` / `config/livekit.ts:5-6` `'devkey'`,`'localdevsecret...'` / `config/turn.ts:3` `'ghc_turn_secret'`
- **내용**: 프로덕션에서 env 누락 시 알려진 약한 키로 fallback → JWT/LiveKit/TURN 토큰 위조 가능.
- **수정 방안**: `requireSecret(name)` 헬퍼 — `NODE_ENV==='production'`이면 미설정 시 **throw(fail-fast)**, 비프로덕션만 dev 기본값. 세 곳 적용.

### 🟠 HIGH — 인증/PIN rate limiting 부재
- **위치**: `routes/auth.ts`(login/register), `routes/rooms.ts:148`(PIN, bcrypt.compare)
- **내용**: 브루트포스 + bcrypt CPU 고갈 DoS. PIN 4~6자리 = 초단위 무력화.
- **수정 방안**: `express-rate-limit` — login/register IP당 분당 5~10회, PIN 검증 점증 지연/락아웃.

### 🟠 HIGH — 토큰 수명/폐기 부재
- **위치**: `auth.ts:20` JWT `30d`, `livekitService.ts:26` LiveKit `12h`
- **수정 방안**: JWT 단축 + refresh(또는 폐기 목록), LiveKit TTL을 세션 길이(2~4h) 수준으로.

### 🟡 MEDIUM — 보안 헤더(helmet) 부재
- **위치**: `backend/src/app.ts`
- **수정 방안**: `helmet` 추가(X-Frame-Options, nosniff, HSTS, 기본 CSP).

### 🟡 MEDIUM — Socket 핸드셰이크 입력 미검증
- **위치**: `socketHandler.ts:74-86`
- **내용**: `deviceId`/`deviceLabel`을 query에서 무검증 수용 → deviceId 스푸핑(타 기기 행세), `deviceLabel` 로그인젝션/XSS 표면(브로드캐스트됨).
- **수정 방안**: deviceId가 인증 user 소유인지 `Device` 조회 확인, deviceLabel 길이/문자 제한(zod), 프론트 렌더 이스케이프 확인.

### 🟢 LOW / 정정
- **정정**: `.env.local`은 **gitignore되어 git 커밋 안 됨**(`.gitignore:5`). "OAuth 자격증명 버전관리 노출"은 오판. 단 평문 시크릿이 로컬 디스크 존재 → 과거 노출 이력 있으면 로테이션 권고(메모리 `prod-env-change-procedure`).
- 비프로덕션 CORS 전체 허용(`app.ts:19-26`) — 의도적이나 staging은 화이트리스트 권장.
- 프로덕션 로그의 닉네임/deviceId 노출 최소화(`socketHandler.ts`).
- TURN 시크릿이 `turn/turnserver.conf`에 평문(`static-auth-secret`) — backend `.env`의 `TURN_SECRET`과 일치 필요, 커밋 금지 확인.

---

## 3. 수정 착수 시 분담 (참고)
- **backend-dev**: room:join 인가, 시크릿 fail-fast, rate limiting, helmet, socket 입력검증
- **webrtc-media**: LiveKit 토큰 권한 차등, 비트레이트 하향, 라이브 상한 가드
- **devops**: docker 리소스 한도/로그로테이션, nginx rate limit
- **database**: DB 풀 소폭 상향(선택)

## 검증 포인트 (수정 후)
- 비멤버 토큰으로 PIN 방 socket `room:join` 직접 호출 → 거부 / viewer publish 불가 확인
- 프로덕션 + 시크릿 미설정 부팅 → 즉시 throw
- login/PIN 반복 → 429/락아웃
- 타 기기 deviceId 핸드셰이크 → 거부
- 라이브 상한 초과 → 한국어 거부 메시지
- 로컬 로그는 cmux `cmux capture-pane`로 확인(docker logs 재실행 금지)
