#!/bin/bash
# Local smoke test for deploy/plausible — spins up the stack on :8000.
# Not used in production (Coolify runs the same compose).
set -euo pipefail
cd "$(dirname "$0")"
export BASE_URL="${BASE_URL:-http://localhost:8000}"
export SECRET_KEY_BASE="${SECRET_KEY_BASE:-$(openssl rand -base64 48)}"
echo "[plausible] BASE_URL=$BASE_URL"
docker compose up -d
echo "[plausible] up. waiting for /health ..."
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$BASE_URL/health" 2>/dev/null; then
    echo "[plausible] healthy after ${i}0s"
    exit 0
  fi
  sleep 10
done
echo "[plausible] not healthy yet — see: docker compose ps" >&2
docker compose ps >&2 || true
exit 1