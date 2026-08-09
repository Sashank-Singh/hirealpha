#!/bin/bash
set -euo pipefail
echo "Killing listeners on TCP 5173-5310..."
PIDS=$(lsof -tiTCP:5173-5310 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "${PIDS:-}" ]; then
  kill -9 $PIDS
  echo "Killed: $PIDS"
else
  echo "No listeners found."
fi
sleep 0.5
cd /Users/sashanksingh/Projects/hirealpha
exec npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
