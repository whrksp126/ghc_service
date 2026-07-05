#!/usr/bin/env bash
# GHC 홈서버 초기 설정 (한 번만 실행)
# 사용: bash scripts/setup.sh
set -euo pipefail

SSH="ssh -i ${HOME}/.ssh/ghmate_server -p 222 ghmate@ghmate.iptime.org"
REMOTE_DIR="/srv/projects/ghc"
REPO_URL="https://github.com/whrksp126/ghc_service.git"

# ---------- 1) SSH 연결 테스트 ----------
echo "[setup] 1/7 SSH 연결 테스트"
if ! ${SSH} "echo ok" >/dev/null 2>&1; then
  echo "  ✗ SSH 접속 실패. ~/.ssh/ghmate_server 키 및 서버 상태 확인."
  exit 1
fi
echo "  ✓ SSH 연결 성공"

# ---------- 2) 프로젝트 디렉토리 + git clone ----------
echo "[setup] 2/7 프로젝트 디렉토리 생성"
${SSH} env REMOTE_DIR="${REMOTE_DIR}" REPO_URL="${REPO_URL}" bash -se <<'REMOTE'
set -euo pipefail
if [ -d "${REMOTE_DIR}/.git" ]; then
  echo "  이미 존재: ${REMOTE_DIR}"
else
  mkdir -p "$(dirname "${REMOTE_DIR}")"
  git clone "${REPO_URL}" "${REMOTE_DIR}"
  echo "  ✓ git clone 완료"
fi
REMOTE

# ---------- 3) .env 파일 확인 ----------
echo "[setup] 3/7 .env 파일 확인"
ENV_STATUS=$(${SSH} env REMOTE_DIR="${REMOTE_DIR}" bash -se <<'REMOTE'
set -euo pipefail
missing=""
[ ! -f "${REMOTE_DIR}/.env" ] && missing="${missing} .env"
[ ! -f "${REMOTE_DIR}/backend/.env" ] && missing="${missing} backend/.env"
echo "${missing}"
REMOTE
)

if [ -n "${ENV_STATUS// /}" ]; then
  echo "  ⚠️ 다음 파일이 없습니다:${ENV_STATUS}"
  echo ""
  echo "  서버에서 직접 생성하세요:"
  echo "    ssh -i ~/.ssh/ghmate_server -p 222 ghmate@ghmate.iptime.org"
  echo ""
  if echo "${ENV_STATUS}" | grep -q "\.env$\| \.env "; then
    echo "  ── ${REMOTE_DIR}/.env (docker-compose MySQL용) ──"
    echo "  MYSQL_ROOT_PASSWORD=<루트 비밀번호>"
    echo "  MYSQL_USER=ghc"
    echo "  MYSQL_PASSWORD=<유저 비밀번호>"
    echo ""
  fi
  if echo "${ENV_STATUS}" | grep -q "backend/.env"; then
    echo "  ── ${REMOTE_DIR}/backend/.env (API 서버용) ──"
    echo "  .env.example 참고하여 모든 값을 채워주세요."
    echo "  특히 MEDIASOUP_ANNOUNCED_IP=<서버 공인IP> 필수!"
    echo ""
  fi
  echo "  .env 파일 생성 후 이 스크립트를 다시 실행하세요."
  exit 1
fi
echo "  ✓ .env 파일 확인 완료"

# ---------- 4) nginx_proxy 네트워크 확인 ----------
echo "[setup] 4/7 nginx_proxy 네트워크 확인"
${SSH} bash -se <<'REMOTE'
set -euo pipefail
if docker network ls --format '{{.Name}}' | grep -q '^nginx_proxy$'; then
  echo "  ✓ nginx_proxy 네트워크 존재"
else
  echo "  ✗ nginx_proxy 네트워크 없음. /srv/nginx-proxy 먼저 설정 필요."
  exit 1
fi
REMOTE

# ---------- 5) nginx conf 배포 ----------
echo "[setup] 5/7 nginx conf 배포"
${SSH} env REMOTE_DIR="${REMOTE_DIR}" bash -se <<'REMOTE'
set -euo pipefail
cp "${REMOTE_DIR}/deploy/nginx/ghc.conf" /srv/nginx-proxy/conf.d/ghc.conf
docker exec nginx_proxy nginx -t >/dev/null 2>&1
docker exec nginx_proxy nginx -s reload
echo "  ✓ nginx conf 배포 + reload 완료"
REMOTE

# ---------- 6) docker compose up ----------
echo "[setup] 6/7 컨테이너 빌드 + 기동"
${SSH} env REMOTE_DIR="${REMOTE_DIR}" bash -se <<'REMOTE'
set -euo pipefail
cd "${REMOTE_DIR}"
docker compose -p ghc_prod up --build -d
echo "  ✓ docker compose up 완료"

echo "  API 부팅 대기 (최대 60초)..."
for i in $(seq 1 12); do
  if curl -fs http://localhost:3000/health >/dev/null 2>&1; then
    echo "  ✓ API 정상 응답"
    break
  fi
  if [ "$i" -eq 12 ]; then
    echo "  ⚠️ API 응답 없음. 로그 확인: docker logs ghc_api_prod"
  fi
  sleep 5
done
REMOTE

# ---------- 7) 포스트 체크리스트 ----------
echo "[setup] 7/7 포스트 체크리스트"
echo ""
echo "  ── Cloudflare DNS (아직 안 했다면) ──"
echo "  ghc.ghmate.com      CNAME  ghmate.iptime.org  (Proxied)"
echo "  ghc-api.ghmate.com  CNAME  ghmate.iptime.org  (Proxied)"
echo "  ghc-turn.ghmate.com CNAME  ghmate.iptime.org  (DNS Only!)"
echo ""
echo "  ── 라우터 포트포워딩 ──"
echo "  3478 UDP+TCP  → 서버IP  (TURN)"
echo "  40000-40100 UDP → 서버IP  (WebRTC media)"
echo ""
echo "  ── 확인 사항 ──"
echo "  □ TURN_SECRET: backend/.env ↔ turn/turnserver.conf 값 일치"
echo "  □ MEDIASOUP_ANNOUNCED_IP: 서버 공인 IP와 일치"
echo "  □ Google OAuth redirect URI: https://ghc-api.ghmate.com/api/auth/google/callback"
echo ""
echo "[setup] ✅ 초기 설정 완료!"
echo "  이후 배포: bash scripts/deploy.sh [--restart]"
