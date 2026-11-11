"""Hypothesis property tests for plugin/omniscience/sanitize.py.

Contract under test (docs/ARCHITECTURE.md §3, docs/SECURITY.md):
  * normalize() tolerates arbitrary payload junk (nested dicts/lists, unicode,
    huge strings, bytes, None, odd scalar types) without raising;
  * whatever it returns is JSON-serialisable;
  * attrs keys per kind never escape the ARCHITECTURE.md §3 allowlist;
  * no free-text attrs value exceeds 200 chars;
  * credential-shaped strings injected anywhere in a payload never survive into
    the serialised output.

Secrets are assembled at runtime via concatenation so no literal key exists in
this source file.
"""

import copy
import json
import re

import pytest
from hypothesis import example, given
from hypothesis import strategies as st

from omniscience.sanitize import (
    HOOK_KINDS,
    SENSITIVE_KEY,
    USAGE_KEYS,
    host_only,
    normalize,
    redact,
)

# --------------------------------------------------------------------------
# strategies
# --------------------------------------------------------------------------

HEX_ID = "local-" + "ab12" * 16          # root session shape (HERMES_INTEGRATION §3)
TURN_ID = HEX_ID + ":" + HEX_ID + ":a870a1a2"
API_ID = TURN_ID + ":api:3"

# Values safe for EVERY payload position: the four `len(x or "")` fields
# (user_message, assistant_response, child_goal, tool_call_history) crash on
# numbers — see test_normalize_never_raises... (filed BUG).
LEN_SAFE = st.one_of(
    st.none(),
    st.text(max_size=400),
    st.binary(max_size=200),
    st.lists(st.none() | st.booleans() | st.integers(-5, 5) | st.text(max_size=10), max_size=3),
    st.dictionaries(st.text(max_size=6), st.none() | st.text(max_size=10), max_size=3),
)

JUNK_VALUE = st.recursive(
    st.none()
    | st.booleans()
    | st.integers(-10**12, 10**12)
    | st.floats(allow_nan=True, allow_infinity=True)
    | st.text(max_size=400)
    | st.binary(max_size=120),
    lambda children: st.one_of(
        st.lists(children, max_size=4),
        st.dictionaries(st.text(max_size=8), children, max_size=4),
    ),
    max_leaves=12,
)

KNOWN_KEYS = (
    "session_id parent_session_id turn_id task_id api_request_id tool_call_id "
    "platform model is_first_turn user_message assistant_response provider api_mode "
    "api_call_count retry_count message_count tool_count approx_input_tokens max_tokens "
    "started_at ended_at first_chunk_at api_duration finish_reason response_model usage "
    "assistant_tool_call_count status_code retryable reason error error_type error_message "
    "tool_name duration_ms args result status completed interrupted child_session_id "
    "child_subagent_id parent_turn_id child_role child_goal child_status tool_call_history "
    "base_url system_prompt conversation_history request headers env api_key token secret "
    "password authorization cookie credential error_body assistant_text"
).split()

JUNK_KEYS = st.text(max_size=8)


def _kwargs(hook, len_safe=True):
    """Build an arbitrary kwargs dict with plausible + junk keys."""

    @st.composite
    def build(draw):
        keys = draw(st.lists(st.one_of(st.sampled_from(KNOWN_KEYS), JUNK_KEYS), max_size=24))
        kwargs = {}
        for k in keys:
            if k in ("user_message", "assistant_response", "child_goal", "tool_call_history"):
                kwargs[k] = draw(LEN_SAFE if len_safe else JUNK_VALUE)
            else:
                kwargs[k] = draw(JUNK_VALUE)
        # Half the payloads carry a realistic session id so normalize() runs a
        # normalizer instead of short-circuiting on the missing id.
        if draw(st.booleans()):
            kwargs["session_id"] = draw(
                st.one_of(st.just(HEX_ID), st.text(min_size=1, max_size=40))
            )
        parent = draw(st.one_of(st.none(), st.just(HEX_ID)))
        if parent is not None:
            kwargs.setdefault("parent_session_id", parent)
        return kwargs

    return build()


@st.composite
def payloads(draw, hook=None, len_safe=True):
    h = draw(st.sampled_from(sorted(HOOK_KINDS)) if hook is None else st.just(hook))
    h = h if isinstance(h, str) else str(h)
    return h, draw(_kwargs(h, len_safe=len_safe))


# --------------------------------------------------------------------------
# fake secrets, concatenated at runtime
# --------------------------------------------------------------------------

_A, _B, _C = "Zx9Q", "Wm7L", "Rt2K"
_ALNUM20 = _A + _B + _C + _A + _B


def _secret(kind):
    return {
        "openai_sk": lambda: "s" + "k-" + _A + _B + _C,
        "anthropic_sk_ant": lambda: "s" + "k-" + "a" + "nt-" + _A + _B + _C,
        "github_pat_classic": lambda: "g" + "hp_" + _ALNUM20,
        "github_pat_fine": lambda: "github_" + "pat_" + _ALNUM20 + "_1",
        "aws_akia": lambda: "AK" + "IA" + "A1B2" + "C3D4" + "E5F6" + "G7H8",
        "slack_xoxb": lambda: "xo" + "xb-" + _A + _B + "-7",
        "bearer": lambda: "B" + "earer " + _A + _B,
        "password_eq": lambda: "pass" + "word=" + _A + _B + _C,
        "url_userinfo": lambda: "htt" + "ps://" + "ad" + "min:" + _A + _B + "@pri" + "vate.example/v1",
        "query_token": lambda: "/v1/mod" + "els?" + "tok" + "en=" + _A + _B + _C,
    }[kind]()


# Keys that (a) are allowlisted and (b) pass through the redactor or the
# ID sanitizer for every hook — the meaningful injection targets.
INJECT_TARGETS = {
    "on_session_start": ["platform", "model"],
    "on_session_end": ["completed", "interrupted"],
    "pre_llm_call": ["platform", "model", "turn_id"],
    "post_llm_call": ["model", "turn_id"],
    "pre_api_request": ["model", "provider", "api_mode", "api_request_id", "turn_id"],
    "post_api_request": ["finish_reason", "response_model", "started_at", "api_request_id"],
    "api_request_error": ["reason", "error_type", "api_request_id"],
    "post_tool_call": ["tool_name", "status", "tool_call_id", "api_request_id", "turn_id"],
    "subagent_start": ["child_role", "child_session_id", "child_subagent_id", "parent_turn_id"],
    "subagent_stop": ["child_status", "duration_ms", "child_session_id"],
}

# Base payloads: realistic shells so normalize() returns a result.
BASE = {
    "on_session_start": dict(session_id=HEX_ID, platform="cli", model="m1"),
    "on_session_end": dict(session_id=HEX_ID, completed=True, interrupted=False),
    "pre_llm_call": dict(session_id=HEX_ID, task_id=HEX_ID, turn_id=TURN_ID,
                         parent_session_id="", platform="cli", model="m1",
                         is_first_turn=True, user_message="hi"),
    "post_llm_call": dict(session_id=HEX_ID, task_id=HEX_ID, turn_id=TURN_ID,
                          model="m1", assistant_response="yo"),
    "pre_api_request": dict(session_id=HEX_ID, task_id=HEX_ID, turn_id=TURN_ID,
                            api_request_id=API_ID, model="m1", provider="custom",
                            api_mode="chat", api_call_count=1, retry_count=0,
                            message_count=2, tool_count=1, approx_input_tokens=10,
                            max_tokens=100, started_at=1.0),
    "post_api_request": dict(session_id=HEX_ID, task_id=HEX_ID, turn_id=TURN_ID,
                             api_request_id=API_ID, api_duration=1.5, started_at=1.0,
                             ended_at=2.5, first_chunk_at=1.2, finish_reason="stop",
                             response_model="m1", usage={"input_tokens": 5, "total_tokens": 9},
                             assistant_tool_call_count=0),
    "api_request_error": dict(session_id=HEX_ID, task_id=HEX_ID, turn_id=TURN_ID,
                              api_request_id=API_ID, api_duration=1.0, status_code=500,
                              retryable=True, reason="boom",
                              error={"type": "E", "message": "bad"}),
    "post_tool_call": dict(session_id=HEX_ID, task_id=HEX_ID, turn_id=TURN_ID,
                           api_request_id=API_ID, tool_call_id="call_1", tool_name="term",
                           duration_ms=5, status="ok", args={"cmd": "x"}, result="done"),
    "subagent_start": dict(parent_session_id=HEX_ID, parent_turn_id=TURN_ID,
                           child_session_id="sub-1", child_subagent_id="sa-0-abc",
                           child_role="researcher", child_goal="dig"),
    "subagent_stop": dict(parent_session_id=HEX_ID, child_session_id="sub-1",
                          child_subagent_id="sa-0-abc", child_status="completed",
                          duration_ms=50, tool_call_history=[]),
}

# Paddings must not glue word chars onto the secret (regexes rely on \b):
# a left pad may not END in a word char, a right pad may not START with one.
PADS_L = ["", " ", "err:", "= ", "]", "'", "/", ",", "(", "\t", "!"]
PADS_R = ["", " ", "= ", "]", "'", "/", ",", "(", "\t", "!", "?"]

ALLOWLIST = {
    "session.start": {"platform", "model"},
    "session.end": {"completed", "interrupted"},
    "turn.start": {"platform", "model", "is_first_turn", "user_chars"},
    "turn.end": {"model", "assistant_chars"},
    "llm.request": {"model", "provider", "api_mode", "api_call_count", "retry_count",
                    "message_count", "tool_count", "approx_input_tokens", "max_tokens",
                    "started_at"},
    "llm.response": {"duration_s", "started_at", "ended_at", "ttfb_s", "finish_reason",
                     "response_model", "usage", "tool_call_count"},
    # error_message_chars is the implemented metadata-only stand-in for the
    # documented `error_message` (see test_error_message_documented_behaviour).
    "llm.error": {"duration_s", "status_code", "retryable", "reason", "error_type",
                  "error_message_chars"},
    "tool.end": {"tool_name", "duration_ms", "started_at", "error_type",
                 "error_message_chars", "arg_names", "result_chars", "mcp_server"},
    "aux.request": {"aux_task", "model", "provider", "api_mode", "retry_count", "message_count",
                    "tool_count", "approx_input_tokens", "plugin_id"},
    "aux.response": {"aux_task", "model", "provider", "finish_reason", "response_model", "error_type",
                     "duration_s", "started_at", "ended_at", "usage"},
    "skill.event": {"action", "skill_name", "use_count", "reused"},
    "subagent.start": {"child_session_id", "child_subagent_id", "parent_turn_id",
                       "role", "goal_chars"},
    "subagent.stop": {"child_session_id", "child_status", "duration_ms", "tool_count"},
}

# attrs keys that deliberately skip the 200-char cap so IDs can still join
# (sanitize.py _put_id comment: "no hex/base64 or length rules").
ID_ATTR_KEYS = {"child_session_id", "child_subagent_id", "parent_turn_id"}


def _blob(result):
    kind, ids, status, attrs, natural = result
    return json.dumps([kind, ids, status, attrs, natural], ensure_ascii=False)


def _walk_values(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k, v
            yield from _walk_values(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _walk_values(v)


def _all_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _all_keys(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _all_keys(v)


# --------------------------------------------------------------------------
# never raises / never mutates input
# --------------------------------------------------------------------------


@given(payloads(len_safe=False))
@example(("pre_llm_call", {"session_id": HEX_ID, "user_message": 5}))
@example(("post_llm_call", {"session_id": HEX_ID, "assistant_response": 2.5}))
@example(("subagent_start", {"parent_session_id": HEX_ID, "child_goal": 7}))
@example(("subagent_stop", {"parent_session_id": HEX_ID, "tool_call_history": 9}))
def test_normalize_never_raises_for_any_kwargs(case):
    hook, kwargs = case
    snapshot = copy.deepcopy(kwargs)
    normalize(hook, kwargs)  # must not raise
    assert kwargs == snapshot  # must not mutate the caller's payload


@pytest.mark.parametrize(
    "hook,key,field",
    [
        ("pre_llm_call", "user_message", "user_chars"),
        ("post_llm_call", "assistant_response", "assistant_chars"),
        ("subagent_start", "child_goal", "goal_chars"),
        ("subagent_stop", "tool_call_history", "tool_count"),
    ],
)
def test_numeric_len_fields_are_omitted_not_raised(hook, key, field):
    kwargs = dict(BASE[hook])
    kwargs[key] = 7
    result = normalize(hook, kwargs)
    assert result is not None
    assert field not in result[3]


@given(st.one_of(
    st.none(), st.text(), st.lists(st.integers()), st.integers(),
    st.integers().map(lambda i: [i]),
    st.builds(object), st.builds(set), st.builds(tuple),
))
def test_normalize_rejects_non_dict_kwargs(payload):
    assert not isinstance(payload, dict)
    assert normalize("pre_llm_call", payload) is None


@pytest.mark.parametrize(
    "hook", [None, "", "no_such_hook", 42, "Post_Tool_Call", "post tool call"]
)
def test_normalize_unknown_hook_returns_none(hook):
    assert normalize(hook, dict(BASE["post_tool_call"])) is None


def test_normalize_requires_session_id():
    assert normalize("on_session_start", {"platform": "cli"}) is None
    assert normalize("on_session_start", {}) is None
    assert normalize("on_session_start", {"session_id": None}) is None
    assert normalize("on_session_start", {"session_id": b"sid-bytes"}) is not None


# --------------------------------------------------------------------------
# structural properties over the allowlisted payloads
# --------------------------------------------------------------------------


@given(payloads(len_safe=True))
def test_result_shape_and_json_serialisable(case):
    hook, kwargs = case
    result = normalize(hook, kwargs)
    if result is None:
        return
    kind, ids, status, attrs, natural = result
    assert kind == HOOK_KINDS[hook]
    assert isinstance(ids, dict) and isinstance(attrs, dict)
    assert status is None or isinstance(status, str)
    assert natural is None or isinstance(natural, str)
    assert all(v is None or isinstance(v, str) for v in ids.values())
    assert ids["session_id"] is not None
    json.dumps([kind, ids, status, attrs, natural], ensure_ascii=False)


@given(payloads(len_safe=True))
def test_attrs_keys_respect_kind_allowlist(case):
    hook, kwargs = case
    result = normalize(hook, kwargs)
    if result is None:
        return
    kind, _ids, _status, attrs, _nat = result
    assert set(attrs) <= ALLOWLIST[kind], f"{kind} got {set(attrs) - ALLOWLIST[kind]}"
    if "usage" in attrs:
        assert set(attrs["usage"]) <= set(USAGE_KEYS)
    if "arg_names" in attrs:
        assert isinstance(attrs["arg_names"], list)
        assert all(isinstance(a, str) for a in attrs["arg_names"])


@given(payloads(len_safe=True))
def test_no_free_text_value_exceeds_200_chars(case):
    hook, kwargs = case
    result = normalize(hook, kwargs)
    if result is None:
        return
    _kind, _ids, _status, attrs, _nat = result
    for key, value in _walk_values(attrs):
        if isinstance(value, str) and key not in ID_ATTR_KEYS:
            assert len(value) <= 200, f"attrs[{key!r}] is {len(value)} chars"


@given(payloads(len_safe=True))
def test_sensitive_key_names_never_appear_as_attr_keys(case):
    hook, kwargs = case
    result = normalize(hook, kwargs)
    if result is None:
        return
    _kind, _ids, _status, attrs, _nat = result
    for key in _all_keys(attrs):
        assert not (SENSITIVE_KEY.search(key) and not key.endswith("_tokens")), key


# --------------------------------------------------------------------------
# secret redaction: injected credential shapes never survive
# --------------------------------------------------------------------------


@st.composite
def injection_cases(draw, secret_kind):
    hook = draw(st.sampled_from(sorted(INJECT_TARGETS)))
    key = draw(st.sampled_from(INJECT_TARGETS[hook]))
    head = draw(st.sampled_from(PADS_L))
    tail = draw(st.sampled_from(PADS_R))
    extra_junk = draw(st.text(max_size=30))
    kwargs = dict(BASE[hook])
    kwargs[key] = head + _secret(secret_kind) + tail
    # Sprinkle the credential-shaped junk into unrelated (denylisted) keys too.
    kwargs["conversation_history"] = [
        {"role": "user", "content": _secret(secret_kind)},
        _secret(secret_kind),
    ]
    kwargs["system_prompt"] = _secret(secret_kind) + extra_junk
    kwargs["headers"] = {"Authorization": _secret(secret_kind)}
    kwargs["base_url"] = "https://u:p@host.example/v1?token=" + _A + _B
    return hook, kwargs


SECRET_KINDS = [
    "openai_sk", "anthropic_sk_ant", "github_pat_classic", "github_pat_fine",
    "aws_akia", "slack_xoxb", "bearer", "password_eq", "url_userinfo", "query_token",
]


@pytest.mark.parametrize("secret_kind", SECRET_KINDS)
@given(data=st.data())
def test_injected_secret_never_reaches_output(secret_kind, data):
    hook, kwargs = data.draw(injection_cases(secret_kind))
    result = normalize(hook, kwargs)
    assert result is not None, "baseline payload must normalize"
    blob = _blob(result)
    token = _secret(secret_kind)
    # For composite secrets assert the credential *core* too (Bearer <tok>,
    # scheme://user:tok@, ?token=tok — the redactor may keep shape markers).
    core = {
        "bearer": _A + _B,
        "url_userinfo": _A + _B,
        "query_token": _A + _B + _C,
    }.get(secret_kind, token)
    assert token not in blob
    assert core not in blob
    assert ("u:" + "p@host.example") not in blob


# --------------------------------------------------------------------------
# ID preservation and targeted behaviour
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw_id",
    [
        HEX_ID,
        "20261105_234903_b11152",
        TURN_ID,
        API_ID,
        "call_" + "7132ab" * 7 + "cd",
    ],
)
def test_realistic_ids_survive_sanitization(raw_id):
    result = normalize(
        "post_tool_call",
        dict(BASE["post_tool_call"], tool_call_id=raw_id, api_request_id=raw_id),
    )
    assert result is not None
    _kind, ids, _status, _attrs, natural = result
    assert ids["tool_call_id"] == raw_id
    assert ids["api_request_id"] == raw_id
    assert natural == raw_id


def test_subagent_child_ids_are_allowlisted_and_preserved():
    result = normalize("subagent_start", dict(BASE["subagent_start"]))
    _kind, _ids, _status, attrs, natural = result
    assert attrs["child_session_id"] == "sub-1"
    assert attrs["child_subagent_id"] == "sa-0-abc"
    assert attrs["parent_turn_id"] == TURN_ID
    assert natural == "sub-1"


def test_subagent_id_only_when_task_differs_from_session():
    r_same = normalize("pre_llm_call", dict(BASE["pre_llm_call"], task_id=HEX_ID))
    assert r_same[1]["subagent_id"] is None
    r_diff = normalize("pre_llm_call", dict(BASE["pre_llm_call"], task_id="sa-0-2ad31b82"))
    assert r_diff[1]["subagent_id"] == "sa-0-2ad31b82"


def test_llm_natural_key_uses_retry_count_when_present():
    r0 = normalize("pre_api_request", dict(BASE["pre_api_request"], retry_count=0))
    r2 = normalize("pre_api_request", dict(BASE["pre_api_request"], retry_count=2))
    assert r0[4] == f"{API_ID}|0"
    assert r2[4] == f"{API_ID}|2"
    r_no = normalize("pre_api_request", {k: v for k, v in BASE["pre_api_request"].items()
                                         if k != "retry_count"})
    assert r_no[4] == API_ID
    # id-less call must fall back (store substitutes boot|seq), never a shared key
    r_none = normalize("pre_api_request",
                       {k: v for k, v in BASE["pre_api_request"].items()
                        if k not in ("api_request_id", "retry_count")})
    assert r_none[4] is None


def test_session_end_status_mapping():
    for completed, interrupted, expected in [
        (True, False, "completed"),
        (False, True, "interrupted"),
        (False, False, None),
        (True, True, "completed"),
    ]:
        r = normalize("on_session_end", dict(BASE["on_session_end"],
                                             completed=completed, interrupted=interrupted))
        assert r[2] == expected, (completed, interrupted)
        assert r[4].startswith(HEX_ID + "|")


def test_turn_char_counts_are_lengths_not_content():
    secret = _secret("password_eq")
    r = normalize("pre_llm_call", dict(BASE["pre_llm_call"], user_message=secret * 3))
    assert r[3]["user_chars"] == len(secret) * 3
    assert secret not in _blob(r)
    r2 = normalize("post_llm_call", dict(BASE["post_llm_call"], assistant_response=secret))
    assert r2[3]["assistant_chars"] == len(secret)
    assert secret not in _blob(r2)


def test_tool_result_char_count_only():
    secret = _secret("openai_sk")
    r = normalize("post_tool_call", dict(BASE["post_tool_call"], result=secret))
    assert r[3]["result_chars"] == len(secret)
    assert "result" not in r[3]
    assert secret not in _blob(r)


def test_error_message_kept_as_length_only():
    secret = _secret("aws_akia")
    r = normalize("api_request_error",
                  dict(BASE["api_request_error"], error={"type": "E", "message": secret * 4}))
    assert r[3]["error_message_chars"] == len(secret) * 4
    assert secret not in _blob(r)


def test_error_message_documented_behaviour():
    secret = _secret("openai_sk")
    r = normalize("api_request_error",
                  dict(BASE["api_request_error"], error={"type": "E", "message": secret}))
    attrs = r[3]
    assert "error_message" not in attrs
    assert attrs["error_message_chars"] == len(secret)
    assert secret not in _blob(r)


def test_error_message_text_is_never_stored():
    secret = _secret("aws_akia")
    r = normalize("api_request_error",
                  dict(BASE["api_request_error"], error_message=secret * 2))
    attrs = r[3]
    assert "error_message" not in attrs
    assert attrs["error_message_chars"] == len(secret) * 2
    assert secret not in _blob(r)


def test_usage_filtered_to_numeric_allowlist_keys():
    usage = {"input_tokens": 5, "total_tokens": "9", "reasoning_tokens": True,
             "leak_key_secret": 1, "cache_read_tokens": 2.5, None: 7}
    r = normalize("post_api_request", dict(BASE["post_api_request"], usage=usage))
    assert r[3]["usage"] == {"input_tokens": 5, "cache_read_tokens": 2.5}
    json.loads(_blob(r))


def test_ttfb_only_when_both_bounds_numeric():
    r = normalize("post_api_request",
                  dict(BASE["post_api_request"], started_at=1.0, first_chunk_at=1.75))
    assert abs(r[3]["ttfb_s"] - 0.75) < 1e-9
    r2 = normalize("post_api_request",
                   dict(BASE["post_api_request"], started_at="1.0", first_chunk_at=1.75))
    assert "ttfb_s" not in r2[3]
    r3 = normalize("post_api_request",
                   dict(BASE["post_api_request"], started_at=1.0, first_chunk_at=None))
    assert "ttfb_s" not in r3[3]


def test_arg_names_are_redacted_strings_sorted():
    secret = _secret("github_pat_classic")
    r = normalize("post_tool_call",
                  dict(BASE["post_tool_call"], args={secret: "v", "zeta": 1, "alpha": None}))
    names = r[3]["arg_names"]
    assert names == sorted(names)
    assert any(n.startswith("alpha") for n in names)
    assert secret not in _blob(r)


def test_token_count_keys_are_not_treated_as_credentials():
    r = normalize("pre_api_request",
                  dict(BASE["pre_api_request"], approx_input_tokens=12971, max_tokens=4096))
    assert r[3]["approx_input_tokens"] == 12971
    assert r[3]["max_tokens"] == 4096


# --------------------------------------------------------------------------
# redact / host_only unit behaviour
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, must_not_contain",
    [
        ("key " + _secret("openai_sk"), _A + _B + _C),
        ("see " + _secret("aws_akia") + " now", "A1B2C3D4E5F6G7H8"),
        ("Be" + "arer " + _A + "." + _B + " trailing", _B),
        ("pass" + "word=" + _A + _B, _A + _B),
        ("htt" + "ps://" + "ro" + "bot:s3cret@int.example/x", "s3cret"),
        ("/v1?" + "token=" + _A + _B + "#frag", _A + _B),
    ],
)
def test_redact_removes_credential_shapes(text, must_not_contain):
    out = redact(text)
    assert must_not_contain not in out
    assert len(out) <= 200


def test_redact_bounds_length_and_types():
    filler = "a.-é" * 3000  # cannot match any token/hex/base64 pattern
    assert redact(filler) == filler[:200]
    assert redact(None) == ""
    assert redact(12345) == "12345"
    assert len(redact(filler, limit=None)) == len(filler)  # unbounded when limit is None


def test_redact_is_idempotent_on_clean_text():
    clean = "plain error: connection reset by peer"
    assert redact(clean) == clean


@pytest.mark.parametrize(
    "url, expected",
    [
        ("https://api.example.com:8443/v1/chat?api_key=abc", "https://api.example.com:8443"),
        ("http://user:pw@host.example/path", "http://host.example"),
        ("https://[::1]:9000/x", "https://[::1]:9000"),
        ("https://example.com", "https://example.com"),
        ("not a url", None),
        ("", None),
        (None, None),
        (42, None),
        ("//host/path", None),
        ("https://", None),
    ],
)
def test_host_only(url, expected):
    assert host_only(url) == expected
