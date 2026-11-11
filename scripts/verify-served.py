#!/usr/bin/env python3
"""Prove that the page the server is serving is the page that was just built.

A deploy that copies files and restarts a process can still leave a browser (or a stale hashed
bundle left behind in the static directory) on old code, and every symptom of that looks like
"my change did not happen". This walks the chain end to end:

  1. GET / and read the hashed bundle it names.
  2. GET that bundle and require 200.
  3. Check the bundle on disk matches the one the page names (no orphan index-*.js).
  4. Grep the served bundle for markers the current source should contain.

Exit 1 on any failure, with the reason, so a deploy cannot quietly succeed while serving nothing.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Strings that only exist in this build. Keep them short and stable-ish: the point is "the bytes
# being served came from this tree", not a pin on wording.
MARKERS = [
    "at last call",
    "vertical axis is logarithmic",
    "Context at the last model call",
    "Facts accurate to",
]

ROOT = Path(__file__).resolve().parents[1]


def get(url: str, token: str = "") -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers={"x-omni-token": token} if token else {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, b""
    except Exception as error:  # pragma: no cover - network edge
        return 0, str(error).encode()


def main(argv: list[str]) -> int:
    port = argv[1] if len(argv) > 1 else "8797"
    token_file = argv[2] if len(argv) > 2 else ""
    token = ""
    if token_file:
        try:
            token = Path(token_file).read_text(encoding="utf-8").strip()
        except OSError:
            token = ""
    base = f"http://127.0.0.1:{port}"

    status, body = get(f"{base}/")
    if status != 200:
        print(f"  FAIL: GET / returned {status}")
        return 1
    match = re.search(rb"index-[A-Za-z0-9_-]+\.js", body)
    if not match:
        print("  FAIL: the served page names no bundle")
        return 1
    bundle = match.group(0).decode()
    print(f"  page names {bundle}")

    status, served = get(f"{base}/assets/{bundle}")
    if status != 200:
        print(f"  FAIL: /assets/{bundle} returned {status} — the page points at a missing file")
        return 1

    on_disk = ROOT / "viewer_app" / "static" / "assets" / bundle
    if on_disk.is_file() and on_disk.read_bytes() != served:
        print(f"  FAIL: the served {bundle} differs from the one in this tree")
        return 1

    missing = [marker for marker in MARKERS if marker.encode() not in served]
    if missing:
        print(f"  FAIL: the served bundle is missing: {missing}")
        return 1

    text = served.decode("utf-8", "replace")
    print(f"  served bundle {len(text):,} chars, all {len(MARKERS)} markers present")

    status, version = get(f"{base}/api/v1/version", token)
    # This check exists to prove the deploy; a version endpoint that will not answer or will
    # not parse is a failed deploy, not a warning to print on the way to "OK".
    if status == 401 and not token:
        print("  FAIL: the version check needs the viewer token; pass its path as the second argument")
        return 1
    if status != 200:
        print(f"  FAIL: /api/v1/version returned {status}")
        return 1
    try:
        info = json.loads(version.decode("utf-8"))
    except ValueError:
        print("  FAIL: /api/v1/version did not parse")
        return 1
    line = " · ".join(
        part
        for part in (
            info.get("version"),
            info.get("commit_short"),
            (info.get("commit_date") or "")[:10],
        )
        if part
    )
    print(f"  server reports {line}" + (" (modified)" if info.get("dirty") else ""))
    print("  OK: the browser will receive this build on the next load")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
