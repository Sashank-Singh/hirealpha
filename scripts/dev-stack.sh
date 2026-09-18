#!/usr/bin/env bash
# The fast loop: test a change here, in seconds, without a Coolify build.
#
#   ./scripts/dev-stack.sh            # local database + local API server
#   ./scripts/dev-stack.sh --bot      # …and the bot on your real iMessage line
#   ./scripts/dev-stack.sh --down     # stop the database, free the port
#
# What it gives you:
#   local Postgres (Docker, pgvector) → local web server → the real turn engine
#   against it. A change to deploy/hire-api.ts, spectrum/shared/* or the bot is
#   live on the next command, with no commit, push or deploy in between.
#
# Test a turn against the local stack:
#   BENCH_API_URL=http://127.0.0.1:8099 bun run scripts/bench-turn.ts "book me a hotel in Chicago …"
# Test it against production for comparison:
#   bun run scripts/bench-turn.ts "book me a hotel in Chicago …"
#
# --bot runs spectrum/alpha/src/index.ts on THIS machine, so a text from your
# phone is answered by the code in this working tree. Stop HireAlpha-Friend in
# Coolify first: two clients on one Photon line race for each text and the
# container usually wins. Never leave the line on a laptop — start the app again
# when you are done.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PG_NAME=ha-local-pg
PG_PORT=5433
API_PORT="${API_PORT:-8099}"
LOCAL_DB_URL="postgres://postgres:localdev@127.0.0.1:${PG_PORT}/hirealpha"
TEST_PHONE="${TEST_PHONE:-+12163032166}"
TEST_USER_ID="11111111-2222-4333-8444-555555555555"

WITH_BOT=0
for arg in "$@"; do
  case "$arg" in
    --bot) WITH_BOT=1 ;;
    --down)
      docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
      pkill -f "deploy/web-server.ts" 2>/dev/null || true
      echo "[dev] local database and server stopped"
      exit 0
      ;;
  esac
done

# The bot's own keys first (Photon project, model), then the bench env, which
# carries the internal key the local server must accept and the API URL.
set -a
# shellcheck disable=SC1091
[ -f spectrum/alpha/.env ] && . spectrum/alpha/.env
# shellcheck disable=SC1091
[ -f spectrum/alpha/bench-runtime.env ] && . spectrum/alpha/bench-runtime.env
set +a

if [ -z "${HIREALPHA_INTERNAL_KEY:-}" ]; then
  echo "[dev] HIREALPHA_INTERNAL_KEY missing — is spectrum/alpha/bench-runtime.env present?" >&2
  exit 1
fi

# 1. Database.
if ! docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
    docker start "$PG_NAME" >/dev/null
  else
    echo "[dev] starting local Postgres (pgvector) on :$PG_PORT"
    docker run -d --name "$PG_NAME" -p "${PG_PORT}:5432" \
      -e POSTGRES_PASSWORD=localdev -e POSTGRES_DB=hirealpha pgvector/pgvector:pg16 >/dev/null
  fi
  for _ in $(seq 1 30); do
    docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
fi

# 2. trvl, the live fare/rate source. The container image installs it at build
# time (Dockerfile.web); without the same binary here a local hotel or flight
# bench answers "live pricing could not be verified" and reads as a product
# failure when it is only a missing file. Downloaded once into .dev-bin.
if [ -z "${TRVL_BIN:-}" ] || [ ! -x "${TRVL_BIN:-/nonexistent}" ]; then
  TRVL_VERSION="${TRVL_VERSION:-v1.21.6}"
  DEV_BIN="$ROOT/.dev-bin"
  mkdir -p "$DEV_BIN"
  if [ ! -x "$DEV_BIN/trvl" ]; then
    case "$(uname -m)" in arm64) goarch=arm64 ;; *) goarch=amd64 ;; esac
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    asset="trvl_${TRVL_VERSION#v}_${os}_${goarch}.tar.gz"
    url="https://github.com/MikkoParkkola/trvl/releases/download/${TRVL_VERSION}"
    if curl -fsSL -o "$DEV_BIN/$asset" "$url/$asset" \
      && curl -fsSL -o "$DEV_BIN/checksums.txt" "$url/checksums.txt" \
      && (cd "$DEV_BIN" && grep "$asset" checksums.txt | shasum -a 256 -c - >/dev/null 2>&1 || true) \
      && tar xzf "$DEV_BIN/$asset" -C "$DEV_BIN" trvl; then
      chmod +x "$DEV_BIN/trvl"
      rm -f "$DEV_BIN/$asset" "$DEV_BIN/checksums.txt"
      echo "[dev] trvl ${TRVL_VERSION} installed at .dev-bin/trvl"
    else
      echo "[dev] trvl download failed — hotel and flight asks will report no live pricing" >&2
    fi
  fi
  [ -x "$DEV_BIN/trvl" ] && export TRVL_BIN="$DEV_BIN/trvl"
fi

# 3. The server. It creates its own schema on boot and applies migrations; on a
# blank database that has to happen before anything else touches it.
if curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1; then
  echo "[dev] server already up on :$API_PORT"
else
  echo "[dev] starting the local API on :$API_PORT (database $LOCAL_DB_URL)"
  DATABASE_URL="$LOCAL_DB_URL" PORT="$API_PORT" bun run deploy/web-server.ts > /tmp/ha-local-web.log 2>&1 &
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1 \
    || { echo "[dev] the server did not come up; last lines of /tmp/ha-local-web.log:"; tail -5 /tmp/ha-local-web.log; exit 1; }
fi

# 4. The test account. Seeded once so the bot's profile lookup finds a hired
# user; re-running is harmless.
docker exec -i "$PG_NAME" psql -U postgres -d hirealpha >/dev/null <<SQL
INSERT INTO hire_users (id, email, name, timezone, phone_e164)
VALUES ('${TEST_USER_ID}', 'local@test.dev', 'Local Tester', 'America/Los_Angeles', '${TEST_PHONE}')
ON CONFLICT (phone_e164) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone;
INSERT INTO hire_roster (user_id, persona) VALUES ('${TEST_USER_ID}', 'friend') ON CONFLICT DO NOTHING;
INSERT INTO hire_context (user_id, persona, fields)
VALUES ('${TEST_USER_ID}', 'friend', '{"city":"San Francisco","setup_done":true,"timezone":"America/Los_Angeles"}'::jsonb)
ON CONFLICT (user_id, persona) DO UPDATE SET fields = hire_context.fields || EXCLUDED.fields;
SQL

echo
echo "[dev] local stack ready."
echo "[dev]   turn against it:  BENCH_API_URL=http://127.0.0.1:${API_PORT} bun run scripts/bench-turn.ts \"<ask>\""
echo "[dev]   server log:       tail -f /tmp/ha-local-web.log"
echo "[dev]   database:         docker exec -it ${PG_NAME} psql -U postgres -d hirealpha"

if [ "$WITH_BOT" != "1" ]; then
  exit 0
fi

export HIREALPHA_API_URL="http://127.0.0.1:${API_PORT}"
export HIREALPHA_BOT=friend
export SKIP_INTRO=1
export HEALTH_PORT="${HEALTH_PORT:-3100}"
echo "[dev] stopping the local API so the bot's own calls are the only ones logged" >/dev/null
echo "[dev] bot is starting on the real iMessage line. Stop HireAlpha-Friend in Coolify first."
cd "$ROOT/spectrum/alpha"
exec bun run src/index.ts
