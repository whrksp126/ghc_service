#!/usr/bin/env bash
# GHC 배포: 로컬에서 한 번 실행하면 push → 홈서버 pull → 기동/재기동 → 헬스체크
# 사용:
#   bash scripts/deploy.sh           # 표준 배포 (변경 없으면 컨테이너 기동 생략)
#   bash scripts/deploy.sh --restart # 컨테이너 강제 재기동
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

SSH="ssh -i ${HOME}/.ssh/ghmate_server -p 222 ghmate@ghmate.iptime.org"
REMOTE_DIR="/srv/projects/ghc"

FORCE_RESTART=0
[[ "${1:-}" == "--restart" ]] && FORCE_RESTART=1

# ---------- 1) 로컬 사전 체크 ----------
echo "[deploy] 1/5 로컬 사전 체크"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "  ✗ uncommitted 변경 있음. 먼저 커밋하세요:"
  git status --short
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${CURRENT_BRANCH}" != "main" ]]; then
  echo "  ✗ 현재 브랜치가 main이 아닙니다 (${CURRENT_BRANCH}). main에서만 배포 가능."
  exit 1
fi
echo "  ✓ clean / branch=main"

# ---------- 2) push ----------
echo "[deploy] 2/5 git push origin main"
git push origin main 2>&1 | tail -2

# ---------- 3) 원격: pull + 변경 감지 + 재기동 ----------
echo "[deploy] 3/5 홈서버 pull + 적용"
${SSH} env FORCE_RESTART="${FORCE_RESTART}" REMOTE_DIR="${REMOTE_DIR}" bash -se <<'REMOTE'
set -euo pipefail
cd "${REMOTE_DIR}"

BEFORE=$(git rev-parse HEAD)
git pull --quiet
AFTER=$(git rev-parse HEAD)

if [[ "${BEFORE}" == "${AFTER}" ]]; then
  CHANGED=""
  echo "  pull: 변경 없음 (HEAD ${BEFORE:0:7})"
else
  CHANGED=$(git diff --name-only "${BEFORE}" "${AFTER}")
  echo "  pull: ${BEFORE:0:7} → ${AFTER:0:7}"
  echo "${CHANGED}" | sed 's/^/    /'
fi

# compose / Dockerfile / deploy / scripts / .env.example / turn 중 하나라도 바뀌었거나 --restart면 up
if [[ "${FORCE_RESTART}" == "1" ]] || echo "${CHANGED}" | grep -qE '(docker-compose.*\.yml|deploy/|scripts/|\.env\.example|backend/Dockerfile|frontend/Dockerfile|turn/)'; then
  echo "  컨테이너 재기동..."
  docker compose -p ghc_prod up --build -d > /tmp/ghc_up.log 2>&1 || { cat /tmp/ghc_up.log; exit 1; }
  echo "  ✓ up done"
else
  echo "  컨테이너 기동 생략"
fi

# nginx conf 변경 감지
if ! diff -q deploy/nginx/ghc.conf /srv/nginx-proxy/conf.d/ghc.conf >/dev/null 2>&1; then
  echo "  nginx conf 갱신..."
  cp deploy/nginx/ghc.conf /srv/nginx-proxy/conf.d/ghc.conf
  docker exec nginx_proxy nginx -t >/dev/null 2>&1
  docker exec nginx_proxy nginx -s reload
  echo "  ✓ nginx reload"
fi
REMOTE

# ---------- 4) 헬스체크 ----------
echo "[deploy] 4/5 헬스체크"
${SSH} bash -se <<'REMOTE'
set -e

# API (network_mode: host → localhost:3000)
echo -n "  API health    "
for i in $(seq 1 12); do
  if curl -fs http://localhost:3000/health >/dev/null 2>&1; then
    echo "OK"
    break
  fi
  if [ "$i" -eq 12 ]; then
    echo "FAIL"
    exit 1
  fi
  sleep 5
done

# Frontend
echo -n "  Frontend      "
docker exec ghc_front_prod curl -fs http://localhost:80/ >/dev/null 2>&1 && echo OK || { echo FAIL; exit 1; }

# MySQL
echo -n "  MySQL         "
docker exec ghc_mysql_prod mysqladmin ping -h localhost >/dev/null 2>&1 && echo OK || { echo FAIL; exit 1; }

# TURN
echo -n "  TURN          "
docker ps --filter name=ghc_turn_prod --format '{{.Status}}' | grep -q "Up" && echo OK || { echo FAIL; exit 1; }
REMOTE

# ---------- 5) 외부 도메인 검증 ----------
echo "[deploy] 5/5 외부 도메인 검증"
ok=1
curl -fsSL -o /dev/null -w "  https://ghc.ghmate.com/ → %{http_code}\n" --max-time 10 \
  https://ghc.ghmate.com/ || ok=0
curl -fsSL -o /dev/null -w "  https://ghc-api.ghmate.com/health → %{http_code}\n" --max-time 10 \
  https://ghc-api.ghmate.com/health || ok=0

if [[ "${ok}" == "1" ]]; then
  echo "[deploy] ✅ 완료"
else
  echo "[deploy] ⚠️ 외부 접근 실패. Cloudflare DNS / 공유기 포트포워딩 / nginx conf 확인 필요."
fi
