"""
Viewer launcher for the Omniscience Hermes plugin.

Ensures the local viewer is running, spawning it if necessary.
Designed to be called from register(ctx) on a daemon thread.
"""

import hashlib
import logging
import os
import signal
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

# viewer.log is capped so a long-lived viewer cannot fill the disk. Rotation happens at viewer
# start only: on Windows an open file cannot be renamed, and the spawned viewer holds the log
# open for its whole life. At start the old viewer has exited and the new one has not opened
# the file yet, so the rename is safe on every platform.
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUPS = 2


def rotate_viewer_log(log_dir: str, *, max_bytes: int = LOG_MAX_BYTES, backups: int = LOG_BACKUPS) -> bool:
    """Roll an oversized ``viewer.log`` to ``viewer.log.1`` … ``.N``, dropping the oldest.

    Returns True when a rotation happened. Never raises: a log that cannot be rotated (locked
    file, missing directory) is kept as-is rather than blocking the viewer's start.
    """
    path = os.path.join(log_dir, "viewer.log")
    try:
        if os.path.getsize(path) <= max_bytes:
            return False
    except OSError:
        return False
    try:
        oldest = f"{path}.{backups}"
        if os.path.exists(oldest):
            os.unlink(oldest)
        for index in range(backups - 1, 0, -1):
            source = f"{path}.{index}"
            if os.path.exists(source):
                os.replace(source, f"{path}.{index + 1}")
        os.replace(path, f"{path}.1")
        return True
    except OSError:
        log.debug("omniscience: could not rotate viewer.log", exc_info=True)
        return False


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
PID_FILE_NAME = "viewer.pid"


def pause_marker_path(state_dir: str) -> str:
    return os.path.join(state_dir, PAUSE_MARKER)


def is_paused(state_dir: str) -> bool:
    return os.path.exists(pause_marker_path(state_dir))


def pid_path(log_dir: str) -> str:
    """Where the launcher records the viewer it started, next to ``viewer.lock``."""
    return os.path.join(log_dir, PID_FILE_NAME)


def _pid_cmdline(pid: int) -> str | None:
    """The command line of *pid* as one string, or None when it cannot be read.

    Read before signalling so a stale pid file can never make this module kill a stranger:
    the number in ``viewer.pid`` may have belonged to the viewer once and to something else now.
    """
    if pid <= 0:
        return None
    if sys.platform == "win32":
        # No /proc. PowerShell's CIM query answers on every supported Windows (wmic is gone from
        # Windows 11 24H2 and the CI images); wmic stays as a fallback for older machines. None
        # means "cannot check", which stop_viewer treats as a refusal, never as a kill.
        queries = (
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"],
            ["wmic", "process", "where", f"processid={pid}", "get", "commandline"],
        )
        for query in queries:
            try:
                proc = subprocess.run(query, capture_output=True, text=True, timeout=10)
            except (OSError, subprocess.SubprocessError):
                continue
            lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
            if query[0] == "wmic":
                lines = lines[1:]  # its first line is the column header
            if proc.returncode == 0 and lines:
                return lines[0]
        return None
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        raw = b""
    if raw:
        return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()
    try:
        proc = subprocess.run(
            ["ps", "-o", "command=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout.strip() or None


def _pid_running(pid: int) -> bool:
    """Is this process still running (not gone, not a zombie)? See app._pid_alive."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    if sys.platform == "win32":
        return True
    try:
        state = Path(f"/proc/{pid}/stat").read_bytes().rsplit(b") ", 1)[1].split(b" ", 1)[0]
    except (OSError, IndexError):
        return True  # cannot read it, so do not claim it is gone
    return state not in (b"Z", b"X")


def _clear_start_stamp(log_dir: str) -> None:
    """Forget the last start attempt: the viewer is being stopped on purpose.

    ``viewer.last-start`` exists so a crashing viewer is not relaunched by every Hermes process
    that loads the plugin. It is written before the spawn, so it also records starts that
    succeeded — and it outlived them. A deliberate stop (Restart viewer, or the owner's switch
    off and on again) then found the stamp younger than a minute and refused to start, leaving
    the viewer down with "a start was attempted less than a minute ago". Nothing is being
    backed off from once the viewer has been stopped, so the stamp goes with it.
    """
    try:
        os.unlink(os.path.join(log_dir, "viewer.last-start"))
    except FileNotFoundError:
        pass
    except OSError:
        log.debug("omniscience: could not clear the viewer start stamp", exc_info=True)


def stop_viewer(log_dir: str) -> dict:
    """Stop the viewer this launcher started. Never raises, never signals anything else.

    The pid comes from ``viewer.pid``; the process it names is signalled only when its command
    line still contains ``omniscience_viewer``. On Windows stopping is refused unless the command
    line can be read (PowerShell, or ``wmic`` where it still exists), because killing by pid without that check is how the wrong
    process gets killed.

    Returns ``{"stopped": bool, "reason": str}``.
    """
    result: dict = {"stopped": False, "reason": ""}
    path = pid_path(log_dir)
    try:
        raw = Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        # Nothing this launcher started is recorded, so nothing is running under its name.
        _clear_start_stamp(log_dir)
        result["reason"] = "no viewer pid"
        return result
    try:
        pid = int(raw)
    except ValueError:
        result["reason"] = "viewer pid file holds no pid"
        _remove_pid_file(path)
        _clear_start_stamp(log_dir)
        return result

    if not _pid_running(pid):
        # The viewer closed itself (the idle exit) and left its pid behind: nothing to signal.
        _remove_pid_file(path)
        _clear_start_stamp(log_dir)
        result["reason"] = "not running"
        return result

    cmdline = _pid_cmdline(pid)
    if cmdline is None:
        result["reason"] = f"cannot check what process {pid} is"
        return result
    if "omniscience_viewer" not in cmdline:
        result["reason"] = f"process {pid} is not the viewer"
        _remove_pid_file(path)
        _clear_start_stamp(log_dir)
        return result

    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                timeout=5,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            result["reason"] = f"taskkill failed: {exc}"
            return result
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            _remove_pid_file(path)
            _clear_start_stamp(log_dir)
            result["reason"] = "not running"
            return result
        except OSError as exc:
            result["reason"] = f"could not signal the viewer: {exc}"
            return result

    deadline = time.time() + 3.0
    while time.time() < deadline:
        if not _pid_running(pid):
            _remove_pid_file(path)
            # Stopped on purpose: the next start is the owner's ask, not a retry to be held back.
            _clear_start_stamp(log_dir)
            result["stopped"] = True
            result["reason"] = "stopped"
            return result
        time.sleep(0.1)
    result["reason"] = "still running after 3s"
    return result


def _remove_pid_file(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        log.debug("omniscience: could not remove the viewer pid file", exc_info=True)


def viewer_command(db_path: str, *, state_db: str | None, static_dir: str, port: int) -> list[str]:
    """The argv the viewer is spawned with.

    ``--db`` and ``--state-db`` are both facts only this process has: which recording, and which
    profile's Hermes store belongs to it. The viewer is given them, never left to guess.
    """
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
    if state_db:
        cmd += ["--state-db", str(state_db)]
    return cmd


def ensure_viewer(db_path: str, *, log_dir: str, autostart: bool, state_db: str | None = None) -> dict:
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
            cmd = viewer_command(db_path, state_db=state_db, static_dir=str(static_dir), port=port)

            # Prepare environment
            # Do not hand Hermes' provider credentials to a detached child. Keep only the
            # operating-system and documented viewer settings the viewer needs to start.
            allowed = (
                "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT",
                "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
                "HERMES_HOME", "PYTHONPATH", "OMNISCIENCE_POLL_INTERVAL_S",
                "OMNISCIENCE_IDLE_POLL_INTERVAL_S", "OMNISCIENCE_VIEWER_CONTENT_LABELS",
                "OMNISCIENCE_TENSORFOLD_HOSTS", "OMNISCIENCE_DIGEST",
                "OMNISCIENCE_VIEWER_IDLE_EXIT_S",
            )
            env = {name: os.environ[name] for name in allowed if name in os.environ}
            # The child resolves chat titles from this store; nothing else is implied.
            if state_db:
                env["OMNISCIENCE_STATE_DB"] = str(state_db)
            # Hermes adds its own package environment at startup (not via PYTHONPATH), so hand the
            # viewer this process's import path: it then finds fastapi/uvicorn exactly as Hermes does.
            parts = pythonpath_entries(str(bundle_dir), sys.path)
            existing_pythonpath = env.get("PYTHONPATH", "")
            if existing_pythonpath:
                parts.append(existing_pythonpath)
            env["PYTHONPATH"] = os.pathsep.join(dict.fromkeys(parts))

            # Roll an oversized viewer.log before the new viewer opens it — the one moment
            # that is safe on Windows (see rotate_viewer_log).
            rotate_viewer_log(log_dir)

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

            # The pid is recorded so the owner's switch can stop this exact process. A mocked or
            # unusual Popen may not carry a real pid; then nothing is written rather than a lie.
            if isinstance(getattr(proc, "pid", None), int) and proc.pid > 0:
                try:
                    with open(pid_path(log_dir), "w", encoding="utf-8") as pid_fh:
                        pid_fh.write(str(proc.pid))
                except OSError:
                    log.debug("omniscience: could not write the viewer pid file", exc_info=True)

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
        "  1. Turn off 'Run the Omniscience viewer' in the Omniscience settings\n"
        "     (or set \"viewer\": \"off\" in prefs.json beside events.db).\n"
        "     Off: recording continues; the viewer does not run.\n"
        "  2. Or find the process and kill it: ps aux | grep omniscience_viewer\n"
        "The viewer runs only while someone is looking at it, and exits by itself when idle.\n"
        "To keep it running from Hermes boot (the old behaviour):\n"
        "  Set OMNISCIENCE_VIEWER_AUTOSTART=1 in your environment.\n"
        "To change the URL:\n"
        "  Set OMNISCIENCE_VIEWER_URL=http://host:port"
    )
