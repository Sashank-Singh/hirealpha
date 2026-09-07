#!/bin/bash
# Legacy systemd release path. Coolify deployments use their configured app.
# Refuse dirty checkouts and verify committed source; never discard changes.
set -euo pipefail
cd "$(dirname "$0")/.."

PROD="${PROD:-hirealpha.chat}"
SSH_HOST="${SSH_HOST:-${SSH_USER:-root}@${PROD}}"
APP_DIR="${APP_DIR:-/opt/hirealpha}"
API_SERVICE="${API_SERVICE:-hirealpha-api}"
if [[ ! "$APP_DIR" =~ ^/[a-zA-Z0-9_./-]+$ || "$APP_DIR" == / || "$APP_DIR" == *..* || ! "$API_SERVICE" =~ ^[a-zA-Z0-9_.@-]+$ ]]; then
  echo 'Invalid APP_DIR or API_SERVICE' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'Commit or isolate local changes before releasing.' >&2
  exit 1
fi
REVISION=$(git rev-parse HEAD)
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes "$SSH_HOST")

echo 'Checking the remote checkout and systemd service'
"${SSH[@]}" "cd '$APP_DIR' && test -z \"\$(git status --porcelain)\" && systemctl cat '$API_SERVICE' >/dev/null"

echo 'Running release checks and building the committed client bundle'
npm run check

echo 'Fast-forwarding remote source and verifying the release revision'
"${SSH[@]}" "cd '$APP_DIR' && git fetch origin && git merge --ff-only origin/main && test \"\$(git rev-parse HEAD)\" = '$REVISION' && npm ci --omit=dev"

# Keep old hashed assets for tabs still using the previous release.
rsync -az dist/ "${SSH_HOST}:${APP_DIR}/dist/"

echo 'Restarting the API service'
"${SSH[@]}" "sudo systemctl restart '$API_SERVICE' && systemctl is-active --quiet '$API_SERVICE'"

healthy=false
for i in 1 2 3 4 5; do
  code=$(curl --connect-timeout 5 --max-time 10 -s -o /dev/null -w '%{http_code}' "https://${PROD}/healthz" || true)
  if [[ "$code" == 200 ]]; then healthy=true; break; fi
  sleep 3
done
if [[ "$healthy" != true ]]; then
  echo 'Deployment failed: health check did not recover.' >&2
  exit 1
fi

echo 'Verifying the deployed bundle matches this release'
ASSET=$(sed -n 's/.*src="\([^"]*assets\/index-[^"]*\.js\)".*/\1/p' dist/index.html | head -1)
if [[ -z "$ASSET" ]]; then
  echo 'Could not identify the built client asset.' >&2
  exit 1
fi
PAGE=$(curl --connect-timeout 5 --max-time 10 -fsS "https://${PROD}/")
if ! grep -Fq "$ASSET" <<< "$PAGE"; then
  echo 'Deployment failed: production serves a different client bundle.' >&2
  exit 1
fi
curl --connect-timeout 5 --max-time 10 -fsS -o /dev/null "https://${PROD}/${ASSET#/}"
echo "Deployed revision $REVISION"
