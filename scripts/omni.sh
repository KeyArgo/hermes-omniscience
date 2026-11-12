#!/usr/bin/env bash
# Pause, resume and inspect Omniscience without touching the recording.
#
#   pause   stop the viewer (its server and the page) and remember that it is paused, so a reload
#           or a Hermes restart does not bring it back
#   resume  clear that and start the viewer again
#   status  say whether it is paused and whether the port answers
#
# Recording is not affected either way: the plugin keeps writing events to events.db while the
# viewer is down, which is why pause costs no data.
set -euo pipefail

STATE_DIR="${HERMES_HOME:-$HOME/.hermes}/plugin-data/omniscience"
MARKER="$STATE_DIR/paused"
PORT="${OMNISCIENCE_PORT:-8797}"

listening() {
  ss -ltn 2>/dev/null | grep -qE ":$PORT[[:space:]]"
}

# GNU date uses -d @epoch; BSD/macOS date uses -r epoch. Neither flag exists on the other.
show_epoch() {
  if date -d "@$1" '+%F %T' >/dev/null 2>&1; then
    date -d "@$1" '+%F %T'
  elif date -r "$1" '+%F %T' >/dev/null 2>&1; then
    date -r "$1" '+%F %T'
  else
    printf '%s' "$1"
  fi
}

stop_viewer() {
  local pid
  pid="$(ss -ltnp 2>/dev/null | grep -E ":$PORT[[:space:]]" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
  if [ -n "${pid:-}" ]; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      listening || break
      sleep 0.2
    done
    echo "==> Stopped the viewer (pid $pid)"
  else
    echo "==> Nothing was listening on $PORT"
  fi
}

case "${1:-}" in
  pause)
    mkdir -p "$STATE_DIR"
    date +%s > "$MARKER"
    stop_viewer
    echo "==> Paused. Events are still being recorded; open Omniscience with: $0 resume"
    ;;
  resume)
    rm -f "$MARKER"
    echo "==> Resumed. It starts with the next Omniscience window or Hermes restart."
    if command -v python3 >/dev/null 2>&1 && [ -f "$(dirname "$0")/../viewer_launcher.py" ]; then
      python3 - "$(dirname "$0")/.." <<'PY' || true
import sys, os
root = os.path.abspath(sys.argv[1])
sys.path.insert(0, root)
state = os.path.join(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")), "plugin-data", "omniscience")
db = os.path.join(state, "events.db")
if os.path.exists(db):
    import viewer_launcher
    print(viewer_launcher.ensure_viewer(db, log_dir=state, autostart=True))
PY
    fi
    ;;
  status)
    if [ -f "$MARKER" ]; then echo "paused since $(show_epoch "$(cat "$MARKER")")"; else echo "not paused"; fi
    if listening; then echo "viewer listening on $PORT"; else echo "viewer not listening on $PORT"; fi
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 2
    ;;
esac
