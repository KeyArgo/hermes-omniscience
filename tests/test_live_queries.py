"""Identical concurrent websocket reads may share work, but no results are cached."""

from __future__ import annotations

import asyncio
import importlib
import threading

import pytest


@pytest.fixture(params=[
    "omniscience.viewer.omniscience_viewer.live_queries",
    "omniscience.viewer_app.omniscience_viewer.live_queries",
])
def coalescer_type(request):
    return importlib.import_module(request.param).LiveQueryCoalescer


def _blocking_query(started: threading.Event, release: threading.Event, calls: list[int]):
    calls.append(1)
    started.set()
    if not release.wait(2):
        raise TimeoutError("test did not release the shared query")
    return ["rows"], None


async def _wait_for(event: threading.Event) -> bool:
    deadline = asyncio.get_running_loop().time() + 1
    while not event.is_set() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.005)
    return event.is_set()


def test_identical_in_flight_queries_share_one_call_then_run_fresh_query(coalescer_type):
    async def scenario():
        coalescer = coalescer_type()
        started = threading.Event()
        release = threading.Event()
        calls: list[int] = []
        key = ("events.db", "root", 42, 1000)

        first = asyncio.create_task(coalescer.run(key, _blocking_query, started, release, calls))
        second = asyncio.create_task(coalescer.run(key, _blocking_query, started, release, calls))
        assert await _wait_for(started)
        await asyncio.sleep(0)  # let the second coroutine join the existing task
        release.set()
        assert await asyncio.gather(first, second) == [(["rows"], None), (["rows"], None)]
        assert len(calls) == 1

        # Coalescing is in-flight only. A later poll performs a new read.
        fresh = await coalescer.run(key, lambda: (calls.append(1), (["fresh"], None))[1])
        assert fresh == (["fresh"], None)
        assert len(calls) == 2

    asyncio.run(scenario())


def test_different_query_keys_and_app_instances_do_not_share(coalescer_type):
    async def scenario():
        started = threading.Event()
        release = threading.Event()
        calls: list[int] = []
        one = coalescer_type()
        two = coalescer_type()
        tasks = [
            asyncio.create_task(one.run(("db", "root", 1, 1000), _blocking_query, started, release, calls)),
            asyncio.create_task(one.run(("db", "root", 2, 1000), _blocking_query, started, release, calls)),
            asyncio.create_task(two.run(("db", "root", 1, 1000), _blocking_query, started, release, calls)),
        ]
        await asyncio.sleep(0.005)
        deadline = asyncio.get_running_loop().time() + 1
        while len(calls) < 3 and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.005)
        assert len(calls) == 3
        release.set()
        await asyncio.gather(*tasks)

    asyncio.run(scenario())


def test_shared_query_errors_reach_all_waiters_and_do_not_poison_retry(coalescer_type):
    async def scenario():
        coalescer = coalescer_type()
        started = threading.Event()
        release = threading.Event()
        calls: list[int] = []

        def broken_query():
            calls.append(1)
            started.set()
            if not release.wait(2):
                raise TimeoutError("test did not release the shared query")
            raise RuntimeError("database unavailable")

        key = ("events.db", "root", 7, 1000)
        first = asyncio.create_task(coalescer.run(key, broken_query))
        second = asyncio.create_task(coalescer.run(key, broken_query))
        assert await _wait_for(started)
        await asyncio.sleep(0.005)
        release.set()
        results = await asyncio.gather(first, second, return_exceptions=True)
        assert len(calls) == 1
        assert all(isinstance(result, RuntimeError) for result in results)
        assert str(results[0]) == str(results[1]) == "database unavailable"

        assert await coalescer.run(key, lambda: ("recovered", None)) == ("recovered", None)

    asyncio.run(scenario())


def test_cancelling_one_waiter_does_not_cancel_the_other_waiter(coalescer_type):
    async def scenario():
        coalescer = coalescer_type()
        started = threading.Event()
        release = threading.Event()
        calls: list[int] = []
        key = ("events.db", "root", 0, 1000)
        first = asyncio.create_task(coalescer.run(key, _blocking_query, started, release, calls))
        second = asyncio.create_task(coalescer.run(key, _blocking_query, started, release, calls))
        assert await _wait_for(started)
        await asyncio.sleep(0.005)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        assert await second == (["rows"], None)
        assert len(calls) == 1

    asyncio.run(scenario())
