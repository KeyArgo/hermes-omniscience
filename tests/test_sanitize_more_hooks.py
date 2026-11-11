import json

from omniscience.sanitize import normalize

SECRETS = ("SECRET_PROMPT_TEXT", "SECRET_ARG_VALUE", "SECRET_ERROR_TEXT", "sk-SECRETKEY")


def _clean(result):
    blob = json.dumps(result, default=str)
    for secret in SECRETS:
        assert secret not in blob, secret


def test_aux_request_keeps_task_and_model_never_messages():
    out = normalize("pre_auxiliary_call", {
        "session_id": "s1", "turn_id": "t1", "api_request_id": "a1", "aux_task": "title_generation",
        "model": "GLM", "provider": "spark-lb", "retry_count": 0, "message_count": 3,
        "request_messages": [{"role": "user", "content": "SECRET_PROMPT_TEXT"}],
        "system_prompt": "SECRET_PROMPT_TEXT sk-SECRETKEY", "request": {"body": "SECRET_PROMPT_TEXT"},
    })
    kind, ids, status, attrs, key = out
    assert kind == "aux.request" and ids["session_id"] == "s1"
    assert attrs["aux_task"] == "title_generation" and attrs["model"] == "GLM"
    _clean(out)


def test_aux_response_status_and_no_error_text():
    ok = normalize("post_auxiliary_call", {"session_id": "s1", "api_request_id": "a1", "aux_task": "compression",
                                           "api_duration": 1.5, "usage": {"output_tokens": 9}, "retry_count": 0,
                                           "response": {"text": "SECRET_PROMPT_TEXT"}})
    bad = normalize("post_auxiliary_call", {"session_id": "s1", "api_request_id": "a1", "retry_count": 1,
                                            "error": "boom SECRET_ERROR_TEXT", "error_type": "TimeoutError"})
    assert ok[2] == "ok" and ok[3]["duration_s"] == 1.5 and ok[3]["usage"] == {"output_tokens": 9}
    assert bad[2] == "error" and bad[3]["error_type"] == "TimeoutError"
    assert ok[4] != bad[4]  # retries of one background call stay separate rows
    _clean(ok)
    _clean(bad)


def test_pre_tool_call_is_not_recorded():
    # D1: pre_tool_call blocks the tool if a plugin hangs, so Omniscience never subscribes to it.
    assert normalize("pre_tool_call", {"session_id": "s1", "tool_name": "terminal"}) is None


def test_tool_end_gets_mcp_server():
    out = normalize("post_tool_call", {"session_id": "s1", "tool_call_id": "c1", "tool_name": "mcp_github_x",
                                       "result": "SECRET_ARG_VALUE", "args": {"q": "SECRET_ARG_VALUE"}})
    assert out[3]["mcp_server"] == "github"
    _clean(out)


def test_skill_events_never_share_a_key():
    a = normalize("on_skill_lifecycle", {"session_id": "s1", "action": "used", "skill_name": "deploy", "use_count": 1})
    b = normalize("on_skill_lifecycle", {"session_id": "s1", "action": "used", "skill_name": "deploy", "use_count": 2})
    assert a[0] == "skill.event" and a[3]["skill_name"] == "deploy"
    assert a[4] is None and b[4] is None  # store falls back to boot_id|seq, so both rows are kept
