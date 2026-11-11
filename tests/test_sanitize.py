import json

import pytest

from omniscience.sanitize import HOOK_KINDS, host_only, normalize, redact

ROOT = "local-" + "ab12" * 16
TURN = f"{ROOT}:{ROOT}:a870a1a2"
API = f"{TURN}:api:1"
CHILD = "20261105_234903_b11152"

# Fake credentials, assembled at runtime so no literal key sits in the source.
SECRETS = [
    "sk-" + "ant-api03-" + "Q" * 40,
    "gh" + "p_" + "A1b2" * 9,
    "AK" + "IA" + "ABCDEFGHIJKLMNOP",
    "hunter2-" + "pw",
    "Bea" + "rer " + "abc.def.ghi",
]
SECRET_TEXT = (f"key {SECRETS[0]} gh {SECRETS[1]} aws {SECRETS[2]} password={SECRETS[3]} "
               f"Authorization: {SECRETS[4]} https://u:{SECRETS[3]}@host/x?token=zzz")

# Realistic kwargs per hook, shaped like the live probe run (docs/HERMES_INTEGRATION.md §3-4).
PAYLOADS = {
    "on_session_start": dict(session_id=ROOT, platform="cli", model="DeepSeek-V4.1-Flash-1017"),
    "on_session_end": dict(session_id=ROOT, completed=True, interrupted=False),
    "pre_llm_call": dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, parent_session_id="", platform="cli",
                         model="m", is_first_turn=True, user_message=SECRET_TEXT,
                         conversation_history=[{"role": "user", "content": SECRET_TEXT}]),
    "post_llm_call": dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, model="m", user_message=SECRET_TEXT,
                          assistant_response=SECRET_TEXT),
    "pre_api_request": dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, api_request_id=API, model="m",
                            provider="custom", base_url="https://u:p@h:1/v1?api_key=" + SECRETS[0],
                            api_mode="chat_completions", api_call_count=1, retry_count=0, message_count=3,
                            tool_count=15, approx_input_tokens=12971, max_tokens=4096, started_at=100.0,
                            request={"messages": [SECRET_TEXT]}, request_messages=[SECRET_TEXT],
                            system_prompt=SECRET_TEXT, user_message=SECRET_TEXT),
    "post_api_request": dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, api_request_id=API, model="m",
                             api_duration=2.5, started_at=100.0, ended_at=102.5, first_chunk_at=100.75,
                             finish_reason="tool_calls", response_model="m",
                             usage={"input_tokens": 12971, "output_tokens": 144, "total_tokens": 13115,
                                    "raw": SECRET_TEXT},
                             response={"content": SECRET_TEXT}, assistant_message=SECRET_TEXT,
                             assistant_tool_call_count=1),
    "api_request_error": dict(session_id=ROOT, turn_id=TURN, api_request_id=API, status_code=401,
                              retryable=False, reason="auth", error={"type": "AuthError", "message": SECRET_TEXT},
                              error_body={"detail": SECRET_TEXT}, request={"messages": [SECRET_TEXT]}),
    "post_tool_call": dict(session_id=ROOT, task_id=ROOT, turn_id=TURN, api_request_id=API,
                           tool_call_id="call_713285d6", tool_name="terminal",
                           args={"command": SECRET_TEXT, "timeout": 30}, result=SECRET_TEXT, duration_ms=3230,
                           status="ok", error_type=None, error_message=None, middleware_trace=[SECRET_TEXT]),
    "subagent_start": dict(parent_session_id=ROOT, parent_turn_id=TURN, parent_subagent_id=None,
                           child_session_id=CHILD, child_subagent_id="sa-0-2ad31b82", child_role="leaf",
                           child_goal=SECRET_TEXT),
    "subagent_stop": dict(parent_session_id=ROOT, parent_turn_id=TURN, child_session_id=CHILD, child_role="leaf",
                          child_summary=SECRET_TEXT, child_status="completed",
                          tool_call_history=[{"tool": "terminal"}], duration_ms=9000),
}


@pytest.mark.parametrize("hook", sorted(PAYLOADS))
def test_no_secret_reaches_output(hook):
    out = normalize(hook, PAYLOADS[hook])
    assert out is not None and out[0] == HOOK_KINDS[hook]
    blob = json.dumps(out)
    for s in SECRETS + ["zzz", "hunter2"]:
        assert s not in blob, (hook, s)


@pytest.mark.parametrize("hook", sorted(PAYLOADS))
def test_content_fields_never_copied(hook):
    _, _, _, attrs, _ = normalize(hook, PAYLOADS[hook])
    for banned in ("user_message", "conversation_history", "request", "response", "assistant_message",
                   "system_prompt", "request_messages", "args", "result", "child_goal", "child_summary",
                   "error_body", "middleware_trace", "base_url", "assistant_response"):
        assert banned not in attrs


def test_unknown_kwargs_ignored_and_none_omitted():
    kw = dict(PAYLOADS["post_tool_call"], brand_new_field="x", error_type=None)
    _, _, _, attrs, _ = normalize("post_tool_call", kw)
    assert "brand_new_field" not in attrs and "error_type" not in attrs


def test_token_counts_kept():
    _, _, _, attrs, _ = normalize("pre_api_request", PAYLOADS["pre_api_request"])
    assert attrs["max_tokens"] == 4096 and attrs["approx_input_tokens"] == 12971


def test_usage_numeric_only_and_ttfb():
    _, ids, status, attrs, _ = normalize("post_api_request", PAYLOADS["post_api_request"])
    assert attrs["usage"] == {"input_tokens": 12971, "output_tokens": 144, "total_tokens": 13115}
    assert attrs["ttfb_s"] == pytest.approx(0.75) and status == "ok"
    assert ids["api_request_id"] == API


def test_missing_usage_is_absent_not_zero():
    kw = dict(PAYLOADS["post_api_request"]); kw.pop("usage")
    _, _, _, attrs, _ = normalize("post_api_request", kw)
    assert "usage" not in attrs


def test_tool_metadata():
    _, ids, status, attrs, key = normalize("post_tool_call", PAYLOADS["post_tool_call"])
    assert attrs["arg_names"] == ["command", "timeout"]
    assert attrs["result_chars"] == len(SECRET_TEXT) and attrs["duration_ms"] == 3230
    assert status == "ok" and key == "call_713285d6" and ids["tool_call_id"] == "call_713285d6"


def test_subagent_ids_survive_intact():
    _, ids, _, attrs, key = normalize("subagent_start", PAYLOADS["subagent_start"])
    assert ids["session_id"] == ROOT and ids["turn_id"] == TURN
    assert attrs["parent_turn_id"] == TURN and attrs["child_session_id"] == CHILD
    assert attrs["goal_chars"] == len(SECRET_TEXT) and key == CHILD


def test_child_agent_gets_subagent_id_root_does_not():
    child = dict(session_id=CHILD, task_id="sa-0-2ad31b82", turn_id="t", parent_session_id=ROOT)
    assert normalize("pre_llm_call", child)[1]["subagent_id"] == "sa-0-2ad31b82"
    assert normalize("pre_llm_call", PAYLOADS["pre_llm_call"])[1]["subagent_id"] is None


def test_unknown_hook_and_bad_input():
    assert normalize("pre_tool_call", {"session_id": "s"}) is None
    assert normalize("post_tool_call", None) is None


def test_redact_and_host_only():
    assert len(redact("word " * 100)) == 200
    assert redact("x" * 500) == "[REDACTED]"  # long base64-like run
    assert host_only("https://u:p@h.example:8443/v1?k=1") == "https://h.example:8443"
    assert host_only("not a url") is None


def test_error_text_is_length_only():
    _, _, _, attrs, _ = normalize("api_request_error", PAYLOADS["api_request_error"])
    assert attrs["error_type"] == "AuthError" and "error_message" not in attrs
    assert attrs["error_message_chars"] == len(SECRET_TEXT)


def test_idless_llm_calls_do_not_share_a_key():
    kw = dict(session_id="s", retry_count=0)
    assert normalize("pre_api_request", kw)[4] is None  # store falls back to boot_id|seq


def test_non_string_result_is_not_stringified():
    class Huge:
        def __str__(self):
            raise AssertionError("must not stringify on the agent thread")
    kw = dict(PAYLOADS["post_tool_call"], result=Huge())
    _, _, _, attrs, _ = normalize("post_tool_call", kw)
    assert "result_chars" not in attrs


# --- bug hunt round 2 (2026-11-09): the allowlist contract for non-scalar values -----


def test_a_container_value_never_reaches_attrs():
    """`_put` stringified whatever it was given, so a dict passed for a scalar field landed in

    the database as text - the one shape that can carry prompt or argument content with it
    (`model={"name": ..., "prompt": "..."}`). The module's contract is scalars or nothing.
    """
    payload = dict(PAYLOADS["post_tool_call"])
    payload["tool_name"] = {"name": "terminal", "prompt": "SECRET_PROMPT_TEXT"}
    payload["model"] = ["SECRET_LIST_VALUE"]
    _, _, _, attrs, _ = normalize("post_tool_call", payload)
    dumped = json.dumps(attrs)
    assert "SECRET_PROMPT_TEXT" not in dumped
    assert "SECRET_LIST_VALUE" not in dumped
    assert "tool_name" not in attrs or isinstance(attrs["tool_name"], str)


def test_ids_in_attrs_still_lose_credential_shapes():
    """`_put_id` wrote the raw value although its docstring promises credential redaction.

    An id that carries a token (a composite or proxied session id) was stored verbatim, while
    the same id in an event column was redacted.
    """
    payload = dict(PAYLOADS["subagent_start"])
    payload["child_session_id"] = "sess-abc Bearer abcdef1234567890XYZ"
    _, ids, _, attrs, _ = normalize("subagent_start", payload)
    assert "abcdef1234567890XYZ" not in json.dumps(attrs)
    assert "abcdef1234567890XYZ" not in json.dumps(ids)


def test_a_question_mark_only_truncates_a_url():
    """The query-string stripper ran on every string, so "gpt?variant=bar" was stored as "gpt".

    It now applies to URL-shaped values only; a bare `token=...` is still redacted by the
    key/value rule.
    """
    assert redact("gpt?variant=bar") == "gpt?variant=bar"
    assert redact("a?b") == "a?b"
    hacked = redact("https://h.example/p?token=abc123")
    assert "abc123" not in hacked and "?" not in hacked, hacked
    assert "zzz" not in redact("call?api_key=zzz")
