#!/usr/bin/env bash
# The two gates that a Web deploy actually dies on, in the order they bite.
#
#   ./scripts/predeploy-check.sh
#
# Both failures happened tonight, twice each:
#   1. a module imported by hire-api.ts with no COPY line in Dockerfile.web
#      (`Cannot find module './placeSite'`), and
#   2. the COPY line written but not COMMITTED, so the image built from a tree
#      that lacked it.
# The first is a test; the second is a git question, which is why this script
# exists instead of trust.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[predeploy] COPY drift (every module reachable from the Web entry points)"
bun test deploy/imageCopies.test.ts >/tmp/predeploy-copies.log 2>&1 || {
  tail -20 /tmp/predeploy-copies.log
  echo "[predeploy] FAIL: a module needs a COPY line in Dockerfile.web" >&2
  exit 1
}

echo "[predeploy] working tree"
dirty=$(git status --porcelain Dockerfile* deploy/ spectrum/ src/ | grep -v '^??' || true)
if [ -n "$dirty" ]; then
  echo "$dirty"
  echo "[predeploy] FAIL: the paths above are modified but not committed; a deploy builds the commit, not your tree" >&2
  exit 1
fi

echo "[predeploy] typechecks"
npx tsc -b >/dev/null 2>&1 || { echo "[predeploy] FAIL: npx tsc -b" >&2; exit 1; }
npm run typecheck:backend >/dev/null 2>&1 || { echo "[predeploy] FAIL: typecheck:backend" >&2; exit 1; }

echo "[predeploy] ok — safe to push (which deploys)"
