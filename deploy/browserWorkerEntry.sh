#!/bin/sh
set -eu

screen_size="${BROWSER_SCREEN_SIZE:-1280x800x24}"
vnc_password="${CHROME_VNC_PASSWORD:-}"

Xvfb "${DISPLAY:-:99}" -screen 0 "$screen_size" -ac +extension GLX +render -noreset &
xvfb_pid=$!
openbox >/tmp/openbox.log 2>&1 &
openbox_pid=$!

if [ -n "$vnc_password" ]; then
  x11vnc -storepasswd "$vnc_password" /tmp/hirealpha-vnc.pass >/dev/null
  x11vnc -display "${DISPLAY:-:99}" -forever -shared -rfbport 5900 -rfbauth /tmp/hirealpha-vnc.pass -o /tmp/x11vnc.log &
else
  x11vnc -display "${DISPLAY:-:99}" -forever -shared -rfbport 5900 -nopw -o /tmp/x11vnc.log &
fi
x11vnc_pid=$!

websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
websockify_pid=$!

cleanup() {
  kill "$websockify_pid" "$x11vnc_pid" "$openbox_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec bun run browserWorker.ts
