#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root relative to this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PLUGIN_DIR="$REPO_ROOT"
VIEWER_SRC="$REPO_ROOT/viewer/omniscience_viewer"
WEB_SRC="$REPO_ROOT/web"
DEST_APP="$PLUGIN_DIR/viewer_app"
DEST_VIEWER="$DEST_APP/omniscience_viewer"
DEST_STATIC="$DEST_APP/static"

NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

echo "==> Bundling Omniscience viewer into $DEST_APP"

# 1. Build web assets if needed
if [[ "$NO_BUILD" -eq 0 ]]; then
  if [[ -d "$WEB_SRC" ]]; then
    echo "==> Building web assets (npm --prefix web run build)"
    npm --prefix "$WEB_SRC" run build
  else
    echo "WARNING: web/ directory not found, skipping build" >&2
  fi
else
  echo "==> Skipping web build (--no-build)"
fi

# 2. Clean destination
rm -rf "$DEST_APP"
mkdir -p "$DEST_APP"

# 3. Copy viewer Python package
if [[ -d "$VIEWER_SRC" ]]; then
  echo "==> Copying viewer package: $VIEWER_SRC -> $DEST_VIEWER"
  cp -r "$VIEWER_SRC" "$DEST_VIEWER"
  # Remove __pycache__ directories
  find "$DEST_VIEWER" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
else
  echo "ERROR: Viewer source not found at $VIEWER_SRC" >&2
  exit 1
fi

# 4. Copy static assets
if [[ -d "$WEB_SRC/dist" ]]; then
  echo "==> Copying static assets: $WEB_SRC/dist -> $DEST_STATIC"
  cp -r "$WEB_SRC/dist" "$DEST_STATIC"
else
  echo "WARNING: web/dist not found, static assets may be missing" >&2
  mkdir -p "$DEST_STATIC"
fi

echo "==> Done. Bundled viewer at $DEST_APP"
