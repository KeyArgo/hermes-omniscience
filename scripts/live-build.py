#!/usr/bin/env python3
"""Print the build the running viewer reports, in the same line the header chip shows.

Kept as a file rather than a `python3 -c` one-liner inside deploy.sh: nested quoting in that
form silently breaks, and a broken check inside a deploy script looks like a deploy failure.
"""

from __future__ import annotations

import json
import sys
import urllib.request


def main(argv: list[str]) -> int:
    port = argv[1] if len(argv) > 1 else "8797"
    token_file = argv[2] if len(argv) > 2 else ""
    token = ""
    if token_file:
        try:
            with open(token_file, encoding="utf-8") as handle:
                token = handle.read().strip()
        except OSError:
            token = ""
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/v1/version",
        headers={"x-omni-token": token, "accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            info = json.loads(response.read().decode("utf-8"))
    except Exception as error:  # pragma: no cover - deploy-time reporting
        print(f"  could not read the version route: {error}")
        return 1
    date = (info.get("commit_date") or "")[:10]
    line = " · ".join(part for part in (info.get("version"), info.get("commit_short"), date) if part)
    if info.get("dirty"):
        line += " (uncommitted changes installed)"
    print(f"  {line}")
    print(f"  build marker {info.get('build')} · static {info.get('static_dir')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
