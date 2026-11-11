"""
Viewer launcher for the Omniscience Hermes plugin.

Ensures the local viewer is running, spawning it if necessary.
Designed to be called from register(ctx) on a daemon thread.
"""

import hashlib
import logging
import os
import sys
import time
import urllib.request
import urllib.error
import subprocess
try:
    import fcntl
except ImportError:  # Windows: no file locks; the start-up re-check still avoids most double starts
    fcntl = None  # type: ignore[assignment]
import errno
import json
from pathlib import Path

log = logging.getLogger("omniscience")

# Default port for the viewer
DEFAULT_PORT = 8797


def viewer_url() -> str:
    """Return the configured viewer URL."""
    return os.environ.get("OMNISCIENCE_VIEWER_URL", f"http://127.0.0.1:{DEFAULT_PORT}")


def _db_fingerprint(db_path: str) -> str:
    """Return a short fingerprint of the database path for identity verification."""
    try:
        real = os.path.realpath(db_path)
    except OSError:
        real = db_path
    return hashlib.sha256(real.encode("utf-8")).hexdigest()[:12]


def is_up(url: str, timeout: float = 0.5) -> bool:
    """Check if the viewer is responding to /api/v1/ping."""
    try:
        req = urllib.request.Request(f"{url.rstrip('/')}/api/v1/ping", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, Exception):
        return False


def _ping_with_fingerprint(url: str, timeout: float = 0.5) -> tuple[bool, str | None]:
    """Check if the viewer is up and return its db_fingerprint.

    Returns (is_up, fingerprint_or_None).
    """
    try:
        req = urllib.request.Request(f"{url.rstrip('/')}/api/v1/ping", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return False, None
            body = resp.read().decode("utf-8", errors="replace")
            data = json.loads(body)
            fp = data.get("db_fingerprint")
            return True, fp if isinstance(fp, str) else None
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, Exception):
        return False, None


def _is_local_url(url: str) -> bool:
    """Check if the URL points to localhost/127.0.0.1."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        host = parsed.hostname or ""
        return host in ("127.0.0.1", "localhost", "::1")
    except Exception:
        return False


def _get_port_from_url(url: str) -> int:
    """Extract port from URL, defaulting to DEFAULT_PORT."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.port:
            return parsed.port
    except Exception:
        log.debug("omniscience: could not read the port from the viewer URL; using the default", exc_info=True)
    return DEFAULT_PORT


def pythonpath_entries(bundle_dir: str, entries) -> list[str]:
    """The PYTHONPATH handed to the spawned viewer: absolute directories only.

    A relative entry (``.`` or a bare name) resolves against the child's working directory, so a
    file sitting there could shadow a stdlib module inside the viewer process.
    """
    parts = [bundle_dir]
    for entry in entries:
        if entry and os.path.isabs(entry) and os.path.isdir(entry):
            parts.append(entry)
    return list(dict.fromkeys(parts))


PAUSE_MARKER = "paused"


def pause_marker_path(state_dir: str) -> str:
    return os.path.join(state_dir, PAUSE_MARKER)


def is_paused(state_dir: str) -> bool:
    return os.path.exists(pause_marker_path(state_dir))


def ensure_viewer(db_path: str, *, log_dir: str, autostart: bool) -> dict:
    """
    Ensure the viewer is running. Never raises.

    Returns:
        dict with keys: url, running (bool), started (bool), reason (str)
    """
    url = viewer_url()
    result = {
        "url": url,
        "running": False,
        "started": False,
        "reason": "",
    }

    try:
        # Check autostart setting FIRST (before is_up) so that when autostart
        # is disabled we never report "running" even if a viewer happens to be up.
        autostart_env = os.environ.get("OMNISCIENCE_VIEWER_AUTOSTART", "").lower()
        if autostart_env in ("0", "false", "no", "off"):
            result["reason"] = "autostart off"
            return result

        if not autostart:
            result["reason"] = "autostart off"
            return result

        # Paused on purpose: the recorder keeps writing; only the page and its server stay down.
        if is_paused(log_dir):
            result["reason"] = "paused (recording continues)"
            return result

        # Only auto-start for local URLs
        if not _is_local_url(url):
            result["reason"] = "non-local URL, refusing to auto-start"
            return result

        # Check if viewer is bundled
        bundle_dir = Path(__file__).parent / "viewer_app"
        if not bundle_dir.exists():
            result["reason"] = "viewer not bundled"
            return result

        # Check if already running AND serving the correct database
        expected_fp = _db_fingerprint(db_path)
        up, actual_fp = _ping_with_fingerprint(url)
        if up:
            if actual_fp is not None and actual_fp != expected_fp:
                # Port is occupied by a viewer serving a different database
                result["reason"] = "port in use by another Omniscience viewer"
                return result
            result["running"] = True
            result["reason"] = "already running"
            return result

        # Ensure log directory exists
        os.makedirs(log_dir, exist_ok=True)

        # Acquire exclusive non-blocking lock
        lock_path = os.path.join(log_dir, "viewer.lock")
        lock_fd = None
        try:
            lock_fd = open(lock_path, "w")
            try:
                fcntl.flock(lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as e:
                if e.errno in (errno.EACCES, errno.EAGAIN):
                    # Another process holds the lock; wait briefly and re-check
                    lock_fd.close()
                    lock_fd = None
                    time.sleep(0.5)
                    up, actual_fp = _ping_with_fingerprint(url)
                    if up:
                        if actual_fp is not None and actual_fp != expected_fp:
                            result["reason"] = "port in use by another Omniscience viewer"
                            return result
                        result["running"] = True
                        result["reason"] = "started by another process"
                        return result
                    result["reason"] = "another process is starting viewer"
                    return result
                else:
                    raise
        except Exception:
            # If locking fails entirely (e.g., no fcntl), proceed without lock
            if lock_fd:
                try:
                    lock_fd.close()
                except Exception:
                    log.debug("omniscience: closing the viewer lock file failed", exc_info=True)
                lock_fd = None

        try:
            # Re-check inside the lock
            up, actual_fp = _ping_with_fingerprint(url)
            if up:
                if actual_fp is not None and actual_fp != expected_fp:
                    result["reason"] = "port in use by another Omniscience viewer"
                    return result
                result["running"] = True
                result["reason"] = "already running (re-checked)"
                return result

            # A start that failed recently is not retried at once (a crashing viewer would
            # otherwise be relaunched by every Hermes process that loads the plugin).
            stamp = os.path.join(log_dir, "viewer.last-start")
            try:
                if time.time() - os.path.getmtime(stamp) < 60:
                    result["reason"] = "a start was attempted less than a minute ago; see viewer.log"
                    return result
            except OSError:
                # No stamp yet: this is the first start of the process lifetime.
                log.debug("omniscience: no viewer start stamp at %s", stamp)
            try:
                with open(stamp, "w", encoding="utf-8") as fh:
                    fh.write(str(int(time.time())))
            except OSError:
                log.debug("omniscience: could not write the viewer start stamp", exc_info=True)

            # Prepare spawn command
            port = _get_port_from_url(url)
            static_dir = bundle_dir / "static"
            cmd = [
                sys.executable,
                "-m",
                "omniscience_viewer",
                "--db",
                db_path,
                "--static",
                str(static_dir),
                "--port",
                str(port),
                "--host",
                "127.0.0.1",
            ]

            # Prepare environment
            env = os.environ.copy()
            # Hermes adds its own package environment at startup (not via PYTHONPATH), so hand the
            # viewer this process's import path: it then finds fastapi/uvicorn exactly as Hermes does.
            parts = pythonpath_entries(str(bundle_dir), sys.path)
            existing_pythonpath = env.get("PYTHONPATH", "")
            if existing_pythonpath:
                parts.append(existing_pythonpath)
            env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(parts))

            # Log file — create with restrictive permissions (0600)
            log_file = os.path.join(log_dir, "viewer.log")
            # Ensure the log file exists with 0600 before opening for append
            try:
                # Create with 0600 if it doesn't exist
                fd = os.open(log_file, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
                os.close(fd)
            except OSError:
                log.debug("omniscience: could not pre-create the viewer log file", exc_info=True)

            # The viewer is detached so it survives a page reload, not a dead Hermes. Told which
            # process owns it, it stops when that process goes away — which is the difference
            # between an idle background server and an orphan burning CPU after the app closed.
            env = dict(env)
            env["OMNISCIENCE_PARENT_PID"] = str(os.getpid())

            # Spawn detached process
            with open(log_file, "a") as log_fh:
                proc = subprocess.Popen(
                    cmd,
                    stdout=log_fh,
                    stderr=log_fh,
                    stdin=subprocess.DEVNULL,
                    start_new_session=True,
                    close_fds=True,
                    env=env,
                )

            # Wait up to 5 seconds for viewer to come up
            deadline = time.time() + 5.0
            while time.time() < deadline:
                up, actual_fp = _ping_with_fingerprint(url)
                if up:
                    if actual_fp is not None and actual_fp != expected_fp:
                        # Another viewer grabbed the port between our check and spawn
                        result["reason"] = "port in use by another Omniscience viewer"
                        return result
                    result["running"] = True
                    result["started"] = True
                    result["reason"] = "started successfully"
                    return result
                time.sleep(0.2)

            # Timed out
            result["running"] = False
            result["started"] = True
            result["reason"] = "spawned but did not become ready within 5s"
            return result

        except Exception as e:
            result["reason"] = f"spawn failed: {e}"
            return result

        finally:
            # Release lock
            if lock_fd:
                try:
                    fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
                    lock_fd.close()
                except Exception:
                    log.debug("omniscience: releasing the viewer lock failed", exc_info=True)

    except Exception as e:
        # Never raise; catch everything
        result["reason"] = f"unexpected error: {e}"
        return result


def stop_hint() -> str:
    """Return a plain-text hint for the user on how to stop/disable the viewer."""
    return (
        "To stop the Omniscience viewer:\n"
        "  1. Find the process: ps aux | grep omniscience_viewer\n"
        "  2. Kill it: kill <PID>\n"
        "To disable auto-start:\n"
        "  Set OMNISCIENCE_VIEWER_AUTOSTART=0 in your environment.\n"
        "To change the URL:\n"
        "  Set OMNISCIENCE_VIEWER_URL=http://host:port"
    )
