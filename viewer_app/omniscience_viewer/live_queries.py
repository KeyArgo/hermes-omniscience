"""Coalesce identical overlapping SQLite reads within one viewer app instance.

This is deliberately in-flight only: completed results are never cached. The caller supplies the
complete query identity (database, root, cursor, and limit), so requests with different cursors or
roots keep their existing independent semantics.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Hashable
from typing import Any, TypeVar

T = TypeVar("T")


class LiveQueryCoalescer:
    """Share an identical synchronous query while it is already running on the same loop.

    Waiters receive the same result object; callers must treat it as read-only.
    """

    def __init__(self) -> None:
        self._inflight: dict[tuple[asyncio.AbstractEventLoop, Hashable], asyncio.Task[Any]] = {}

    async def run(self, key: Hashable, function: Callable[..., T], *args: Any) -> T:
        loop = asyncio.get_running_loop()
        scoped_key = (loop, key)
        task = self._inflight.get(scoped_key)
        if task is None:
            task = loop.create_task(asyncio.to_thread(function, *args))
            self._inflight[scoped_key] = task
            task.add_done_callback(
                lambda completed, scoped_key=scoped_key: self._forget(scoped_key, completed)
            )
        # One websocket disconnecting must not cancel a query another websocket is awaiting.
        return await asyncio.shield(task)

    def _forget(
        self,
        key: tuple[asyncio.AbstractEventLoop, Hashable],
        task: asyncio.Task[Any],
    ) -> None:
        if self._inflight.get(key) is task:
            del self._inflight[key]
        # If every waiter disconnected before a failing read completed, mark the exception as
        # observed. Awaiting callers still receive it normally.
        if not task.cancelled():
            task.exception()
