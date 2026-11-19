"""Periodic health lines for viewer.log: memory, CPU, threads, sockets, database size.

The viewer must leave a trail when it misbehaves (memory growth, CPU spikes, stuck requests)
without costing anything while it behaves. One task wakes every ``HEALTH_INTERVAL_S``, reads a
few cheap numbers (one small /proc file or one kernel call, one stat, one counter) and writes
one line to the ``omniscience`` logger — which ``__main__`` already sends to viewer.log with
timestamps. An idle viewer with unchanged numbers stays silent, but checks in at least every
``HEALTH_FORCE_INTERVAL_S`` so a log can never look like a viewer that died quietly.

Stdlib only: no psutil, no queries, no timers beyond the one sleep. Every read is guarded —
a value that cannot be read prints as ``?`` and never crashes the tick.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import threading
import time
from collections import deque

log = logging.getLogger("omniscience")

HEALTH_INTERVAL_S = 60.0
# Even an idle, unchanged viewer says it is alive this often.
HEALTH_FORCE_INTERVAL_S = 600.0
# Memory warnings repeat at most this often, so a high plateau cannot flood the log.
MEMORY_WARN_COOLDOWN_S = 600.0
GROWTH_WINDOW_S = 1800.0
GROWTH_WARN_MB = 100.0
RSS_WARN_DEFAULT_MB = 400.0


def rss_warn_mb(environ: dict | None = None) -> float:
    """``OMNISCIENCE_VIEWER_RSS_WARN_MB``: the RSS level that earns a warning.

    Junk and non-positive values read as the default rather than as "warn always" or "never".
    """
    raw = (environ or os.environ).get("OMNISCIENCE_VIEWER_RSS_WARN_MB", "")
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return RSS_WARN_DEFAULT_MB
    return value if value > 0 else RSS_WARN_DEFAULT_MB


def _memory_from_proc() -> tuple[float | None, float | None]:
    """Linux: VmRSS (current) and VmHWM (peak) from /proc/self/status, in MB."""
    rss = peak = None
    with open("/proc/self/status", "r", encoding="ascii") as handle:
        for line in handle:
            if line.startswith("VmRSS:"):
                rss = float(line.split()[1]) / 1024.0  # kB -> MB
            elif line.startswith("VmHWM:"):
                peak = float(line.split()[1]) / 1024.0
    return rss, peak


def _memory_from_windows() -> tuple[float | None, float | None]:
    """Windows: the kernel's working-set counters for this process, in MB."""
    import ctypes
    from ctypes import wintypes

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
    handle = kernel32.GetCurrentProcess()
    if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        return None, None
    return counters.WorkingSetSize / (1024.0 * 1024.0), counters.PeakWorkingSetSize / (1024.0 * 1024.0)


def _memory_from_rusage() -> tuple[float | None, float | None]:
    """macOS/BSD: getrusage reports only the peak. It is bytes on macOS, kB elsewhere.

    Current RSS has no stdlib source on these platforms, so it reads as ``?``.
    """
    import resource

    peak_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform != "darwin":
        peak_kb = peak_kb / 1024.0  # BSD reports kB, macOS reports bytes
    return None, float(peak_kb) / 1024.0


def read_memory_mb() -> tuple[float | None, float | None]:
    """``(rss_mb, peak_mb)`` for this process; either is None when it cannot be read."""
    try:
        if sys.platform.startswith("linux"):
            return _memory_from_proc()
        if sys.platform == "win32":
            return _memory_from_windows()
        return _memory_from_rusage()
    except Exception:
        return None, None


def _fmt(value: float | None, spec: str = ".1f") -> str:
    return "?" if value is None else format(value, spec)


class HealthMonitor:
    """Collects the health numbers and decides what earns a line.

    ``tick`` is driven by :func:`health_watch` on the event loop; the clocks and the memory
    reader are injectable so tests can drive time and fake the platform reads.
    """

    def __init__(
        self,
        db_path: str,
        activity=None,
        *,
        reader=None,
        clock=None,
        cpu_clock=None,
        cache_sessions=None,
        logger=None,
    ) -> None:
        self._db_path = db_path
        self._activity = activity
        self._reader = reader if reader is not None else read_memory_mb
        self._clock = clock if clock is not None else time.monotonic
        self._cpu_clock = cpu_clock if cpu_clock is not None else time.process_time
        self._cache_sessions = cache_sessions
        self._log = logger if logger is not None else log
        self._last_line_at: float | None = None
        self._last_fields: tuple | None = None
        self._history: deque = deque()  # (monotonic, rss_mb) inside the growth window
        self._high_warned_at: float | None = None
        self._growing_warned_at: float | None = None
        self._last_cpu = self._cpu_clock()
        self._last_wall = self._clock()

    def tick(self, now: float | None = None) -> None:
        """One health check. Never raises: a broken read is a ``?``, not a dead viewer."""
        try:
            self._tick(self._clock() if now is None else now)
        except Exception:
            self._log.debug("omniscience: health tick failed", exc_info=True)

    def _read_memory(self) -> tuple[float | None, float | None]:
        try:
            rss, peak = self._reader()
        except Exception:
            return None, None
        return rss, peak

    def _db_mb(self) -> float | None:
        try:
            return os.path.getsize(self._db_path) / (1024.0 * 1024.0)
        except OSError:
            return None

    def _cached_sessions(self) -> int | None:
        if self._cache_sessions is None:
            return None
        try:
            return int(self._cache_sessions())
        except Exception:
            return None

    def _tick(self, now: float) -> None:
        rss, peak = self._read_memory()
        cpu_now = self._cpu_clock()
        elapsed = now - self._last_wall
        cpu_pct = max(0.0, (cpu_now - self._last_cpu) / elapsed * 100.0) if elapsed > 0 else 0.0
        self._last_cpu = cpu_now
        self._last_wall = now
        threads = threading.active_count()
        sockets = self._activity.open_sockets if self._activity is not None else 0
        db_mb = self._db_mb()
        cache_sessions = self._cached_sessions()

        if rss is not None:
            self._history.append((now, rss))
            while self._history and self._history[0][0] < now - GROWTH_WINDOW_S:
                self._history.popleft()
        self._warn_memory(now, rss)

        fields = (rss, peak, cpu_pct, threads, sockets, db_mb, cache_sessions)
        # Idle silence compares coarse values: a few kB of allocator jitter is not a change.
        coarse = (
            None if rss is None else round(rss),
            None if peak is None else round(peak),
            round(cpu_pct, 1),
            threads,
            sockets,
            None if db_mb is None else round(db_mb),
            cache_sessions,
        )
        changed = self._last_fields is None or coarse != self._last_fields
        forced = self._last_line_at is None or now - self._last_line_at >= HEALTH_FORCE_INTERVAL_S
        if not (forced or changed or sockets > 0):
            return
        self._log.info(
            "omniscience: health rss_mb=%s peak_mb=%s cpu_pct=%s threads=%d sockets=%d "
            "db_mb=%s cache_sessions=%s",
            _fmt(rss), _fmt(peak), _fmt(cpu_pct), threads, sockets,
            _fmt(db_mb), _fmt(cache_sessions, "d"),
        )
        self._last_line_at = now
        self._last_fields = coarse

    def _warn_memory(self, now: float, rss: float | None) -> None:
        if rss is None:
            return
        limit = rss_warn_mb()
        if rss > limit and (
            self._high_warned_at is None or now - self._high_warned_at >= MEMORY_WARN_COOLDOWN_S
        ):
            self._log.warning(
                "omniscience: memory high rss_mb=%.1f limit_mb=%g", rss, limit
            )
            self._high_warned_at = now
        if self._history:
            rose = rss - self._history[0][1]
            if rose > GROWTH_WARN_MB and (
                self._growing_warned_at is None
                or now - self._growing_warned_at >= MEMORY_WARN_COOLDOWN_S
            ):
                self._log.warning(
                    "omniscience: memory growing rss_mb=%.1f rose_mb=%.1f window_min=%d",
                    rss, rose, int(GROWTH_WINDOW_S // 60),
                )
                self._growing_warned_at = now


async def health_watch(monitor: HealthMonitor, *, interval: float = HEALTH_INTERVAL_S) -> None:
    """One task: a health tick every ``interval``. Nothing else — no queries, no extra timers."""
    while True:
        await asyncio.sleep(interval)
        monitor.tick()
