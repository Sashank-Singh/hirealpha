#!/bin/sh
set -eu

case "${HIREALPHA_BOT:-friend}" in
  friend|alpha)
    cd /app/spectrum/alpha
    ;;
  coworker|alpha-coworker)
    cd /app/spectrum/alpha-coworker
    ;;
  cofounder|alpha-cofounder)
    cd /app/spectrum/alpha-cofounder
    ;;
  *)
    echo "Unknown HIREALPHA_BOT=${HIREALPHA_BOT}. Use friend|coworker|cofounder."
    exit 1
    ;;
esac

export SKIP_INTRO="${SKIP_INTRO:-1}"
exec bun src/index.ts
