#!/usr/bin/env python3
"""Install the current Omniscience test-channel commit on Linux or Windows."""

import argparse
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

REPOSITORY = "https://github.com/KeyArgo/hermes-omniscience.git"
# The current test source. A future channel rename must be an explicit cutover.
TEST_REF = "refs/heads/fix/omni-cross-platform"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="resolve and show the commit without installing")
    args = parser.parse_args()
    git = shutil.which("git")
    hermes = shutil.which("hermes")
    if not git:
        print("Git is required and was not found on PATH.", file=sys.stderr)
        return 1
    if not hermes:
        print("Hermes is required and was not found on PATH.", file=sys.stderr)
        return 1
    try:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
        result = subprocess.run(
            [git, "ls-remote", REPOSITORY, TEST_REF],
            check=True, capture_output=True, text=True, timeout=60, env=env,
        )
        rows = [line.split() for line in result.stdout.splitlines() if line.strip()]
        if not rows:
            raise ValueError(f"test branch not found: {TEST_REF}")
        if len(rows) != 1 or len(rows[0]) != 2 or rows[0][1] != TEST_REF or not re.fullmatch(r"[0-9a-fA-F]{40}", rows[0][0]):
            raise ValueError("test branch did not resolve to exactly one full commit SHA")
        sha = rows[0][0].lower()
        print(f"Omniscience test branch: {TEST_REF}\nCommit: {sha}\nHermes: {hermes}", flush=True)
        print(f"Hermes home: {os.environ.get('HERMES_HOME', '(Hermes default)')}", flush=True)
        command = [hermes, "plugins", "install", REPOSITORY, "--force", "--ref", sha, "--enable"]
        if args.dry_run:
            print("Dry run: no installation performed.")
            print(subprocess.list2cmdline(command) if os.name == "nt" else shlex.join(command))
            return 0
        print("This replaces the installed Omniscience plugin with the test build and enables it. Hermes may ask about dependencies.", flush=True)
        status = subprocess.run(command, check=False).returncode
        if status:
            return status
        plugin = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "plugins" / "omniscience"
        installed = subprocess.run(
            [git, "-C", str(plugin), "rev-parse", "--verify", "HEAD"],
            check=False, capture_output=True, text=True, timeout=30,
        )
        if installed.returncode == 0:
            actual = installed.stdout.strip().lower()
            if actual != sha:
                print(f"Installed commit {actual} does not match requested {sha}.", file=sys.stderr)
                return 1
            print(f"Verified installed files: {actual}")
        else:
            print("Installation returned success, but the installed commit could not be verified from Git. Check Hermes before testing.", file=sys.stderr)
        print("Reload Hermes when sessions are idle, then verify the running Desktop pane.")
        return 0
    except subprocess.CalledProcessError as exc:
        print(f"Could not resolve the test branch: {(exc.stderr or str(exc)).strip()}", file=sys.stderr)
        return 1
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        print(f"Could not resolve or install the test build: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
