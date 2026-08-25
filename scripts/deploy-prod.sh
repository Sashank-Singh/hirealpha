#!/bin/bash
# Deploy the HireAlpha web app + API/bot to production.
#
# Production runs at https://hirealpha.chat — the SPA served from dist/ and the
# API/bot behind it (bun src/index.ts). This rebuilds the frontend, uploads it,
# pulls the latest server code, restarts the services, and verifies health.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD="${PROD:-hirealpha.chat}"
: "${SSH_HOST:=root@${PROD}}"
: "${SSH_USER:=root}"
APP_DIR="${APP_DIR:-/opt/hirealpha}"
REMOTE_BUN="~/.bun/bin/bun"

echo "== 1/6 building the client bundle =="
npm run build

echo "== 2/6 uploading dist to ${SSH_USER}@${PROD} =="
rsync -az --delete dist/ "${SSH_USER}@${PROD}:${APP_DIR}/dist/"
rsync -az deploy/ "${SSH_USER}@${PROD}:${APP_DIR}/deploy/"

echo "== 3/6 updating the API server code + deps =="
ssh "${SSH_USER}@${PROD}" "cd ${APP_DIR} && git fetch origin && git reset --hard origin/main && cd deploy && ${REMOTE_DIR_BUN:-bun} install --frozen-lockfile --production"
echo "== 4/6 restarting the API service =="
ssh "${SSH_USER}@${PROD}" "sudo systemctl restart hirealpha-api || sudo systemctl restart hireapi || true"

echo "== 5/6 health checks =="
sleep 5
for i in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://${PROD}/healthz" || true)
  echo "  healthz: ${code}"
  [ "$code" = "200" ] && break
  sleep 3
done

echo "== 6/6 verifying the new bundle is live =="
curl -s "https://${PROD}/" | grep -oE 'assets/index-[^"]+\.js' | sort -u | head -5

echo "== done =="