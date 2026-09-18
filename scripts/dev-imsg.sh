#!/usr/bin/env bash
# Run the Friend bot ON THIS MACHINE, answering your real iMessage line.
#
# Why this exists: the only other way to test a bot change is commit → push →
# Coolify build → deploy, which is ~3 minutes per iteration for a one-line edit.
# This loop is seconds.
#
#   1. Stop HireAlpha-Friend in Coolify. Two clients on one Photon line race for
#      each text and the container usually wins, so the local bot looks deaf.
#   2. ./scripts/dev-imsg.sh              # bot, against the PRODUCTION API
#      ./scripts/dev-imsg.sh --stack      # bot + a LOCAL web server (server
#                                         # changes, no deploy either)
#   3. Text Alpha from your phone. The terminal prints the inbound text and the
#      reply as they happen. Ctrl-C to stop.
#   4. Start HireAlpha-Friend again in Coolify. Do not leave the line on a
#      laptop process — closing the lid ends the hire.
#
# --stack starts deploy/web-server.ts on PORT=8099 with the same env and points
# the bot at it, so a change to hire-api.ts is testable without a deploy. It
# talks to the real database (DATABASE_URL from the bench env), so it writes
# real rows for the number you text from.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STACK=0
[ "${1:-}" = "--stack" ] && STACK=1

# The bot's own env first (Photon project + model keys), then the bench env,
# which carries the API URL, the internal key, the database and Kernel keys.
set -a
# shellcheck disable=SC1091
[ -f spectrum/alpha/.env ] && . spectrum/alpha/.env
# shellcheck disable=SC1091
[ -f spectrum/alpha/bench-runtime.env ] && . spectrum/alpha/bench-runtime.env
set +a

export HIREALPHA_BOT=friend
export SKIP_INTRO=1
export HEALTH_PORT="${HEALTH_PORT:-3100}"

if [ -z "${PROJECT_ID:-}" ] || [ -z "${PROJECT_SECRET:-}" ]; then
  echo "PROJECT_ID / PROJECT_SECRET missing — is spectrum/alpha/.env present?" >&2
  exit 1
fi

LOCAL_API_PID=""
cleanup() {
  [ -n "$LOCAL_API_PID" ] && kill "$LOCAL_API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$STACK" = "1" ]; then
  export PORT="${PORT:-8099}"
  echo "[dev] starting the local web server on :$PORT (real database)"
  (cd "$ROOT" && bun run deploy/web-server.ts) &
  LOCAL_API_PID=$!
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  export HIREALPHA_API_URL="http://127.0.0.1:$PORT"
  echo "[dev] bot will call the LOCAL api at $HIREALPHA_API_URL"
else
  echo "[dev] bot will call the api at ${HIREALPHA_API_URL:-<unset>}"
fi

echo "[dev] make sure HireAlpha-Friend is STOPPED in Coolify, then text Alpha."
echo "[dev] the turn prints below. Ctrl-C when done, then start the app again."
cd "$ROOT/spectrum/alpha"
exec bun run src/index.ts
