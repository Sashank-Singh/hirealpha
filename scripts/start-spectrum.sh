#!/usr/bin/env bash
# Start all three HireAlpha Spectrum bots (Friend / Coworker / Cofounder).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/Users/sashanksingh/Library/Application Support/reflex/bun/bin:$PATH"

for bot in alpha alpha-coworker alpha-cofounder; do
  if [[ ! -f "$ROOT/spectrum/$bot/.env" ]]; then
    echo "Missing $ROOT/spectrum/$bot/.env"
    exit 1
  fi
  if ! grep -q '^GMI_API_KEY=.\+' "$ROOT/spectrum/$bot/.env"; then
    echo "WARN: $bot has empty GMI_API_KEY — will use local personality fallback until you set it."
  fi
done

mkdir -p "$ROOT/spectrum/logs"
pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

(cd "$ROOT/spectrum/alpha" && bun start) >"$ROOT/spectrum/logs/alpha.log" 2>&1 &
pids+=($!)
(cd "$ROOT/spectrum/alpha-coworker" && bun start) >"$ROOT/spectrum/logs/alpha-coworker.log" 2>&1 &
pids+=($!)
(cd "$ROOT/spectrum/alpha-cofounder" && bun start) >"$ROOT/spectrum/logs/alpha-cofounder.log" 2>&1 &
pids+=($!)

echo "Started Friend / Coworker / Cofounder (pids: ${pids[*]})"
echo "Logs: $ROOT/spectrum/logs/"
echo "Intros target INTRO_TO (default +12163032166). Set SKIP_INTRO=1 to skip."
wait
