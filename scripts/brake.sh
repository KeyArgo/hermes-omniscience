#!/usr/bin/env bash
# Turn Hermes' run API on or off, so Omniscience's Ignore/brake can reach a real stop.
#
# Everything this does is reversible with `off`: the four config values are unset and the token file
# removed. Nothing else in config.yaml is touched (`hermes config set/unset`, not a text edit).
#
#   on      enable the API server on 127.0.0.1:8642 with a fresh token, restart the gateway
#   off     remove those values, delete the token file, restart the gateway
#   status  say what is set and whether the port answers
#
# The gateway restart ends any chat that is mid-run, so run `on` when nothing is working.
set -euo pipefail

STATE_DIR="${HERMES_HOME:-$HOME/.hermes}/plugin-data/omniscience"
BRAKE_FILE="$STATE_DIR/brake.json"
PORT="${OMNI_BRAKE_PORT:-8642}"

usage() { sed -n '2,12p' "$0"; exit 2; }

restart_gateway() {
  if command -v hermes >/dev/null 2>&1; then
    echo "==> Restarting the gateway so the change takes effect"
    hermes gateway restart 2>&1 | tail -5 || echo "    the gateway did not restart cleanly; check 'hermes gateway status'"
  else
    echo "    no hermes CLI on PATH: restart the gateway yourself"
  fi
}

case "${1:-}" in
  on)
    TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "==> Enabling the run API on 127.0.0.1:$PORT"
    hermes config set platforms.api_server.enabled true >/dev/null
    hermes config set platforms.api_server.host 127.0.0.1 >/dev/null
    hermes config set platforms.api_server.port "$PORT" >/dev/null
    hermes config set platforms.api_server.token "$TOKEN" >/dev/null
    mkdir -p "$STATE_DIR"
    printf '{"url":"http://127.0.0.1:%s","token":"%s","enabled_at":%s}\n' \
      "$PORT" "$TOKEN" "$(date +%s)" > "$BRAKE_FILE"
    chmod 600 "$BRAKE_FILE"
    restart_gateway
    for _ in $(seq 1 30); do
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/runs" || true)"
      if [ -n "$code" ] && [ "$code" != "000" ]; then
        echo "==> The run API answers ($code). Omniscience can now ask it to stop a chat."
        exit 0
      fi
      sleep 1
    done
    echo "FAIL: the API did not answer on $PORT. Undo with: $0 off"
    exit 1
    ;;
  off)
    echo "==> Removing the run API settings"
    for key in enabled host port token; do
      hermes config unset "platforms.api_server.$key" >/dev/null 2>&1 || true
    done
    rm -f "$BRAKE_FILE"
    restart_gateway
    echo "==> Off. The viewer will say it cannot stop a run again, which is the honest answer."
    ;;
  status)
    echo "brake file: $([ -f "$BRAKE_FILE" ] && echo present || echo absent)"
    for key in enabled host port; do
      printf '  platforms.api_server.%s = %s\n' "$key" "$(hermes config get "platforms.api_server.$key" 2>/dev/null || echo '(unset)')"
    done
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v1/runs" || true)"
    echo "  port $PORT answers: $code"
    ;;
  *) usage ;;
esac
