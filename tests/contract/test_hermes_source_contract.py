"""Read-only checks against the Hermes checkout we verified in docs/HERMES_INTEGRATION.md.

These tests do not import Hermes (it has its own environment); they parse the
cited source files and assert the contract facts we depend on.  When the
checkout is absent, the whole module skips cleanly.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path

import pytest

HERMES_ROOT = Path(os.environ.get("HERMES_SOURCE", str(Path.home() / ".hermes" / "hermes-agent")))

pytestmark = pytest.mark.skipif(
    not HERMES_ROOT.is_dir(),
    reason=f"Hermes checkout not present at {HERMES_ROOT}",
)

CONSUMED_HOOKS = (
    "on_session_start",
    "on_session_end",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "post_tool_call",
    "subagent_start",
    "subagent_stop",
)

# Fire sites cited in docs/HERMES_INTEGRATION.md §4.
FIRE_SITE_FILES = {
    "on_session_start": ("agent/conversation_loop.py",),
    "on_session_end": ("agent/turn_finalizer.py", "hermes_cli/cli_shutdown.py"),
    "pre_llm_call": ("agent/turn_context.py",),
    "post_llm_call": ("agent/turn_finalizer.py",),
    "pre_api_request": ("agent/turn_api_request.py",),
    "post_api_request": ("agent/turn_response_intake.py",),
    "api_request_error": ("agent/api_request_hooks.py",),
    "post_tool_call": ("model_tools.py",),
    "subagent_start": ("tools/delegate_tool.py",),
    "subagent_stop": ("tools/delegate_tool_results.py",),
}

# Kwargs our normalizers read from each hook.  If Hermes stops passing one of
# these, the corresponding field silently disappears from events; fail here.
CONSUMED_KWARGS = {
    "on_session_start": {"session_id", "model", "platform"},
    "on_session_end": {"session_id", "task_id", "turn_id", "completed", "interrupted"},
    "pre_llm_call": {
        "session_id", "task_id", "turn_id", "parent_session_id", "model", "platform",
        "is_first_turn", "user_message",
    },
    "post_llm_call": {"session_id", "task_id", "turn_id", "model", "assistant_response"},
    "pre_api_request": {
        "session_id", "task_id", "turn_id", "api_request_id", "model", "provider",
        "api_mode", "api_call_count", "retry_count", "message_count", "tool_count",
        "approx_input_tokens", "max_tokens", "started_at",
    },
    "post_api_request": {
        "session_id", "task_id", "turn_id", "api_request_id", "model", "api_duration",
        "started_at", "ended_at", "first_chunk_at", "finish_reason", "response_model",
        "usage", "assistant_tool_call_count",
    },
    "api_request_error": {
        "session_id", "task_id", "turn_id", "api_request_id", "api_duration",
        "status_code", "retry_count", "retryable", "reason", "error",
    },
    "post_tool_call": {
        "session_id", "task_id", "turn_id", "api_request_id", "tool_call_id",
        "tool_name", "args", "result", "duration_ms", "status", "error_type",
        "error_message",
    },
    "subagent_start": {
        "parent_session_id", "parent_turn_id", "child_session_id", "child_subagent_id",
        "child_role", "child_goal",
    },
    "subagent_stop": {
        "parent_session_id", "child_session_id", "child_status", "duration_ms",
        "tool_call_history",
    },
}

HOOK_INVOKERS = {"invoke_hook", "_invoke_hook", "_invoke_hook_safely"}


def _parse(relative: str) -> ast.Module:
    path = HERMES_ROOT / relative
    assert path.is_file(), f"cited Hermes source is missing: {relative}"
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _assigned_set(tree: ast.Module, name: str) -> set[str]:
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        else:
            continue
        if any(isinstance(target, ast.Name) and target.id == name for target in targets):
            value = ast.literal_eval(node.value)
            assert isinstance(value, set), f"{name} is not a literal set"
            return value
    raise AssertionError(f"{name} assignment not found")


def _call_ids_fields(tree: ast.Module) -> set[str]:
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "_CallIds":
            return {
                child.target.id
                for child in node.body
                if isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name)
            }
    return set()


def _unpacked_names(value: ast.AST, tree: ast.Module) -> set[str]:
    # ``**_CallIds(...).hook_kwargs()`` and ``**_CallIds(...)`` both carry the ids.
    for node in ast.walk(value):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name == "_CallIds":
                return _call_ids_fields(tree)
    if isinstance(value, ast.Dict):
        return {
            key.value
            for key in value.keys
            if isinstance(key, ast.Constant) and isinstance(key.value, str)
        }
    return set()


def _fire_sites(relative: str, hook: str) -> list[dict]:
    tree = _parse(relative)
    sites = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name not in HOOK_INVOKERS:
            continue
        first = node.args[0]
        if not (isinstance(first, ast.Constant) and first.value == hook):
            continue
        explicit = {kw.arg for kw in node.keywords if kw.arg is not None}
        unpacked: set[str] = set()
        for kw in node.keywords:
            if kw.arg is None:
                unpacked |= _unpacked_names(kw.value, tree)
        sites.append({"lineno": node.lineno, "explicit": explicit, "unpacked": unpacked})
    return sites


def test_every_consumed_hook_is_still_a_valid_hermes_hook():
    valid = _assigned_set(_parse("hermes_cli/plugins.py"), "VALID_HOOKS")
    missing = set(CONSUMED_HOOKS) - valid
    assert not missing, f"hooks removed from Hermes VALID_HOOKS: {sorted(missing)}"
    # Deliberately not consumed, but the fail-closed rationale depends on it existing.
    assert "pre_tool_call" in valid


def test_pre_tool_call_is_still_fail_closed_and_subagent_stop_stays_on_caller_thread():
    dispatch = _parse("hermes_cli/plugins_dispatch.py")
    fail_closed = _assigned_set(dispatch, "_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS")
    assert "pre_tool_call" in fail_closed, "pre_tool_call is no longer fail-closed"

    caller_thread = _assigned_set(dispatch, "_HOOK_CALLER_THREAD_HOOKS")
    assert "subagent_stop" in caller_thread, "subagent_stop may now run off the caller thread"


@pytest.mark.parametrize("hook", CONSUMED_HOOKS)
def test_consumed_kwargs_still_reach_the_cited_fire_site(hook):
    coverage: set[str] = set()
    for relative in FIRE_SITE_FILES[hook]:
        sites = _fire_sites(relative, hook)
        assert sites, f"{hook} fire site disappeared from {relative}"
        for site in sites:
            coverage |= site["explicit"] | site["unpacked"]

    missing = CONSUMED_KWARGS[hook] - coverage
    assert not missing, (
        f"{hook} no longer passes consumed kwargs {sorted(missing)} "
        f"at its cited fire site(s)"
    )
