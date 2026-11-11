"""Privacy proof: fake secrets in every free-text field must never reach disk.

Same live-path setup as tests/e2e/test_live_path.py: OMNISCIENCE_DB points at
a tmp file, omniscience.register(ctx) wires the real hook callbacks into the
real EventStore (which runs sanitize.normalize before writing). Each test
feeds one hook's free-text field with all five fake secrets, flushes the
writer thread, then reads the raw events.db bytes and asserts none of the
secrets appear. Hermes-looking ids (local-<64 hex>) must survive verbatim.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
import os as _os_pkg  # noqa: E402
sys.path.insert(0, _os_pkg.environ["OMNI_TEST_PKG_DIR"])  # set by tests/conftest.py

import omniscience  # noqa: E402

OPENAI_KEY = "sk-FAKE0123456789abcdefABCDEF0123"
GITHUB_TOKEN = "ghp_FAKE0123456789abcdefABCDEF012345"
PASSWORD_URL = "https://user:hunter2FAKE@example.com/x"
EMAIL = "fake.person@example.com"
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsig"

SECRETS = (OPENAI_KEY, GITHUB_TOKEN, PASSWORD_URL, EMAIL, JWT)

SESSION = "local-" + "0123456789abcdef" * 4
TURN = SESSION + ":turn1"
API_ID = TURN + ":api:1"
TOOL_ID = "local-" + "f" * 64
CHILD_SESSION = SESSION + ":child"
SUBAGENT_ID = "local-" + "cd" * 32


def _joined(secrets=SECRETS):
    return " ".join(secrets)


def _tool_base(**over):
    kwargs = {
        "session_id": SESSION,
        "turn_id": TURN,
        "api_request_id": API_ID,
        "tool_call_id": TOOL_ID,
        "tool_name": "terminal",
        "duration_ms": 7,
    }
    kwargs.update(over)
    return kwargs


def _llm_error_base(**over):
    kwargs = {
        "session_id": SESSION,
        "turn_id": TURN,
        "api_request_id": API_ID,
        "api_duration": 0.5,
        "status_code": 500,
        "retryable": True,
    }
    kwargs.update(over)
    return kwargs


CASES = [
    pytest.param(
        "pre_llm_call/user_message",
        "pre_llm_call",
        lambda: {
            "session_id": SESSION,
            "turn_id": TURN,
            "model": "m",
            "user_message": _joined(),
        },
        id="pre_llm_call/user_message",
    ),
    pytest.param(
        "post_llm_call/assistant_response",
        "post_llm_call",
        lambda: {
            "session_id": SESSION,
            "turn_id": TURN,
            "model": "m",
            "assistant_response": _joined(),
        },
        id="post_llm_call/assistant_response",
    ),
    pytest.param(
        "subagent_start/child_goal",
        "subagent_start",
        lambda: {
            "parent_session_id": SESSION,
            "parent_turn_id": TURN,
            "child_session_id": CHILD_SESSION,
            "child_subagent_id": SUBAGENT_ID,
            "child_role": "worker",
            "child_goal": _joined(),
        },
        id="subagent_start/child_goal",
    ),
    pytest.param(
        "post_tool_call/args",
        "post_tool_call",
        lambda: _tool_base(
            status="ok",
            args={**{secret: secret for secret in SECRETS}, "cwd": "."},
            result="ok",
        ),
        id="post_tool_call/args",
    ),
    pytest.param(
        "post_tool_call/result",
        "post_tool_call",
        lambda: _tool_base(status="ok", args={"command": "ls"}, result=_joined()),
        id="post_tool_call/result",
    ),
    pytest.param(
        "post_tool_call/error_message",
        "post_tool_call",
        lambda: _tool_base(status="error", error_message=_joined()),
        id="post_tool_call/error_message",
    ),
    pytest.param(
        "post_tool_call/error_type",
        "post_tool_call",
        lambda: _tool_base(status="error", error_type=_joined()),
        id="post_tool_call/error_type",
    ),
    pytest.param(
        "post_tool_call/error_dict",
        "post_tool_call",
        lambda: _tool_base(
            status="error",
            error={"type": _joined(), "message": _joined()},
        ),
        id="post_tool_call/error_dict",
    ),
    pytest.param(
        "api_request_error/reason",
        "api_request_error",
        lambda: _llm_error_base(reason=_joined()),
        id="api_request_error/reason",
    ),
    pytest.param(
        "api_request_error/error_message",
        "api_request_error",
        lambda: _llm_error_base(error_message=_joined()),
        id="api_request_error/error_message",
    ),
    pytest.param(
        "api_request_error/error_type",
        "api_request_error",
        lambda: _llm_error_base(error_type=_joined()),
        id="api_request_error/error_type",
    ),
    pytest.param(
        "api_request_error/error_dict",
        "api_request_error",
        lambda: _llm_error_base(
            error={"type": _joined(), "message": _joined()},
        ),
        id="api_request_error/error_dict",
    ),
]


class _Ctx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, cb):
        self.hooks[name] = cb


@pytest.fixture()
def live_store(tmp_path, monkeypatch):
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("OMNISCIENCE_DB", str(db_path))
    ctx = _Ctx()
    omniscience.register(ctx)
    store = omniscience._store
    yield ctx.hooks, store, db_path
    store.flush(5)
    store.close()


def _raw_db_bytes(db_path: Path) -> bytes:
    blob = db_path.read_bytes()
    for suffix in ("-wal", "-shm"):
        sidecar = db_path.with_name(db_path.name + suffix)
        if sidecar.exists():
            blob += sidecar.read_bytes()
    return blob


@pytest.mark.parametrize("case_id,hook_name,build_kwargs", CASES)
def test_fake_secrets_never_reach_raw_db_bytes(
    live_store, case_id, hook_name, build_kwargs
):
    hooks, store, db_path = live_store

    hooks[hook_name](**build_kwargs())

    assert store.flush(5.0), "writer thread did not drain in time"
    assert store.stats()["written"] >= 1, f"nothing was written for {case_id}"

    blob = _raw_db_bytes(db_path)
    leaked = [secret for secret in SECRETS if secret.encode() in blob]
    assert not leaked, f"{case_id}: fake secrets found verbatim in raw DB bytes: {leaked}"


def test_hermes_ids_are_kept_unchanged(live_store):
    hooks, store, db_path = live_store

    hooks["on_session_start"](session_id=SESSION, platform="cli", model="m")
    hooks["pre_llm_call"](
        session_id=SESSION, turn_id=TURN, model="m", user_message="hello"
    )
    hooks["pre_api_request"](
        session_id=SESSION,
        turn_id=TURN,
        api_request_id=API_ID,
        model="m",
        provider="fleet",
        retry_count=0,
    )
    hooks["post_tool_call"](
        session_id=SESSION,
        turn_id=TURN,
        api_request_id=API_ID,
        tool_call_id=TOOL_ID,
        tool_name="terminal",
        args={"command": "ls"},
        result="ok",
        duration_ms=1,
        status="ok",
    )
    hooks["subagent_start"](
        parent_session_id=SESSION,
        parent_turn_id=TURN,
        child_session_id=CHILD_SESSION,
        child_subagent_id=SUBAGENT_ID,
        child_role="worker",
        child_goal="do the thing",
    )
    hooks["on_session_end"](session_id=SESSION, completed=True)

    assert store.flush(5.0), "writer thread did not drain in time"

    blob = _raw_db_bytes(db_path)
    for needle in (SESSION, TURN, API_ID, TOOL_ID, CHILD_SESSION, SUBAGENT_ID):
        assert needle.encode() in blob, f"hermes id {needle!r} must survive unchanged"
