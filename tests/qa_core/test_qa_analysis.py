"""Regression tests for the pure anomaly-detection rules
(analysis/omniscience_analysis/rules.py).

Contract (module docstring + ARCHITECTURE.md §5):
  * pure: inputs never mutated, no wall clock, no I/O;
  * deterministic: output independent of input ordering — canonical sort by
    (ts, rowid, event_id, idx);
  * every Finding cites >=1 real event_id;
  * missing/invalid fields make a rule SKIP the event — never substitute 0.
"""

import copy
import itertools
import random

import pytest

from omniscience_analysis.rules import Config, detect

BASE_CFG = Config()
_ROWIDS = itertools.count(1)


def ev(kind, event_id, ts=0.0, session_id="S", **kw):
    row = {
        "rowid": kw.pop("rowid", next(_ROWIDS)),
        "event_id": event_id,
        "kind": kind,
        "ts": ts,
        "session_id": session_id,
        "attrs": kw.pop("attrs", {}),
    }
    for k in ("turn_id", "api_request_id", "tool_call_id", "status"):
        if k in kw:
            row[k] = kw.pop(k)
    assert not kw, f"unexpected fields {kw}"
    return row


def tool_end(eid, tool, ts=0.0, turn_id=None, arg_names=None, status=None,
             session_id="S", **extra):
    attrs = {"tool_name": tool}
    if arg_names is not None:
        attrs["arg_names"] = arg_names
    attrs.update(extra)
    return ev("tool.end", eid, ts=ts, session_id=session_id, turn_id=turn_id,
              status=status, attrs=attrs)


def llm_resp(eid, ts=0.0, session_id="S", duration_s=None, usage=None):
    attrs = {}
    if duration_s is not None:
        attrs["duration_s"] = duration_s
    if usage is not None:
        attrs["usage"] = usage
    return ev("llm.response", eid, ts=ts, session_id=session_id, attrs=attrs)


def tupled(findings):
    return [(f.rule, f.severity, f.session_id, f.message, tuple(f.event_ids))
            for f in findings]


# --------------------------------------------------------------------------
# basic contract
# --------------------------------------------------------------------------


def test_clean_session_produces_no_findings():
    events = [
        ev("session.start", "s1", ts=1.0),
        ev("llm.request", "r1", ts=2.0, api_request_id="a1"),
        llm_resp("r2", ts=5.0, duration_s=3.0, usage={"total_tokens": 100}),
        tool_end("t1", "read_file", ts=6.0, status="ok", turn_id="T1",
                 arg_names=["path"]),
        ev("session.end", "s9", ts=9.0),
    ]
    assert detect(events) == []


@pytest.mark.parametrize("events", [[], None])
def test_empty_and_none_inputs(events):
    assert detect(events) == []


def test_non_dict_entries_are_filtered():
    clean = ev("session.start", "s1", ts=1.0)
    sealed = ev("session.end", "s2", ts=2.0)
    polluted = [None, 42, "junk", {"kind": "session.start"}, clean, [], sealed]
    assert detect(polluted) == detect([clean, sealed]) == []  # paired: no stall


def test_input_never_mutated():
    events = RICH[:20]
    before = copy.deepcopy(events)
    detect(events)
    assert events == before, "detect() must be pure (no in-place normalisation)"


def test_attrs_may_be_json_string_or_dict_and_bad_json_is_empty_dict():
    e_dict = llm_resp("x", ts=90.1, duration_s=90.0)
    e_str = dict(e_dict, attrs='{"duration_s": 90.0}')
    e_bad = dict(e_dict, event_id="x2", attrs="{definitely not json")
    by_dict = tupled(detect([e_dict]))
    assert len(by_dict) == 1 and by_dict[0][0] == "slow_inference"
    assert tupled(detect([e_str])) == [
        (r, s, sid, msg, ("x",)) for (r, s, sid, msg, _) in by_dict
    ]
    assert detect([e_bad]) == []


# --------------------------------------------------------------------------
# thresholds, exact boundaries
# --------------------------------------------------------------------------


@pytest.mark.parametrize("dur, fires", [(59.9, False), (60.0, False), (60.1, True)])
def test_slow_inference_boundary_is_strictly_greater(dur, fires):
    got = detect([llm_resp("a", ts=1.0, duration_s=dur),
                  ev("session.end", "z", ts=2.0)])
    assert bool(got) is fires
    if fires:
        f = got[0]
        assert (f.rule, f.severity) == ("slow_inference", "low")
        assert "60.1s" in f.message and f.event_ids == ["a"]


def test_slow_inference_threshold_is_configurable():
    events = [llm_resp("a", ts=1.0, duration_s=11.0)]
    assert detect(events) == []
    got = detect([llm_resp("a", ts=1.0, duration_s=11.0)], Config(slow_s=10.0))
    assert [f.rule for f in got] == ["slow_inference"]


def test_slow_inference_skips_non_numeric_or_bool_duration():
    assert detect([llm_resp("a", duration_s="9000")]) == []
    assert detect([llm_resp("a", duration_s=True)]) == []      # bool is not a number
    assert detect([llm_resp("a", duration_s=None)]) == []      # missing -> skip


@pytest.mark.parametrize("n, fires", [(2, False), (3, True), (4, True)])
def test_repeated_tool_failure_threshold_inclusive(n, fires):
    events = [tool_end(f"t{i}", "bash", ts=float(i), status="error") for i in range(n)]
    events.append(ev("session.end", "z", ts=100.0))
    got = detect(events)
    assert bool(got) is fires
    if fires:
        f = got[0]
        assert (f.rule, f.severity, f.session_id) == ("repeated_tool_failure", "high", "S")
        assert f.event_ids == [f"t{i}" for i in range(n)]


def test_repeated_tool_failure_groups_by_session_and_tool():
    events = (
        [tool_end(f"a{i}", "bash", ts=float(i), status="error") for i in range(2)]
        + [tool_end(f"b{i}", "write_file", ts=float(i) + 10, status="error") for i in range(2)]
        + [tool_end(f"c{i}", "bash", ts=float(i) + 20, status="error", session_id="OTHER")
           for i in range(2)]
        + [tool_end("ok", "bash", ts=30.0, status="ok")]
    )
    assert detect(events) == []


def test_repeated_tool_failure_skips_events_missing_fields():
    no_sid = tool_end("a", "bash", status="error", session_id=None)
    no_tool = ev("tool.end", "b", status="error", attrs={})
    no_status = tool_end("c", "bash", status=None)
    assert detect([no_sid, no_tool, no_status]) == []


@pytest.mark.parametrize("run_len, n_findings", [(4, 0), (5, 1), (6, 1)])
def test_loop_needs_run_of_at_least_threshold(run_len, n_findings):
    stream = [tool_end(f"t{i}", "search", ts=float(i), turn_id="T1",
                       arg_names=["query"]) for i in range(run_len)]
    got = detect(stream)
    assert len(got) == n_findings
    if n_findings:
        f = got[0]
        assert f.rule == "loop" and f.severity == "high"
        assert f.event_ids == [f"t{i}" for i in range(run_len)]
        assert "search" in f.message and "['query']" in f.message


def test_loop_alternating_keys_never_fire_even_with_high_volume():
    stream = []
    for i in range(14):
        tool = "a" if i % 2 else "b"
        stream.append(tool_end(f"t{i}", tool, ts=float(i), turn_id="T",
                               arg_names=["x"]))
    assert detect(stream) == []


def test_loop_interleaved_runs_below_threshold_do_not_fire():
    stream = [tool_end(f"a{i}", "same", ts=float(i), turn_id="T",
                       arg_names=["x"]) for i in range(4)]
    stream.append(tool_end("divider", "other", ts=10.0, turn_id="T",
                           arg_names=["x"]))
    stream += [tool_end(f"b{i}", "same", ts=float(i) + 20, turn_id="T",
                        arg_names=["x"]) for i in range(4)]
    assert detect(stream) == []


def test_loop_arg_names_compared_sorted_as_strings():
    stream = [tool_end(f"t{i}", "f", ts=float(i), turn_id="T",
                       arg_names=["b", "a"] if i % 2 else ["a", "b"])
              for i in range(5)]
    got = detect(stream)
    assert [f.rule for f in got] == ["loop"]
    assert "['a', 'b']" in got[0].message


def test_loop_one_finding_per_turn():
    stream = []
    for tid in ("T1", "T2"):
        stream += [tool_end(f"{tid}{i}", "x", ts=float(i), turn_id=tid,
                            arg_names=["p"]) for i in range(5)]
    got = detect(stream)
    assert [f.rule for f in got] == ["loop", "loop"]
    assert {m for _, _, _, m, _ in tupled(got)} == {
        f"tool 'x' called 5x consecutively with identical arg_names ['p'] in turn {t}"
        for t in ("T1", "T2")
    }


@pytest.mark.parametrize("age, fires", [(240.0, False), (300.0, False), (340.0, True)])
def test_stall_boundary_is_strictly_greater_than_threshold(age, fires):
    # anchor pins max_ts at 700; the open session.start sits `age` seconds older
    events = [ev("session.start", "open", ts=700.0 - age, session_id="Z"),
              llm_resp("anchor", ts=700.0)]
    got = detect(events)
    assert [f.rule for f in got] == (["stall"] if fires else [])
    if fires:
        f = got[0]
        assert f.severity == "medium" and f.session_id == "Z"
        assert f.event_ids == ["open"] and "340.0s" in f.message


def test_stall_paired_lifecycle_never_fires_however_old():
    events = [
        ev("session.start", "ss", ts=0.0, session_id="Z"),
        ev("llm.request", "rq", ts=1.0, session_id="Z", api_request_id="a1"),
        ev("llm.response", "rp", ts=2.0, session_id="Z", api_request_id="a1"),
        ev("llm.request", "rq2", ts=3.0, session_id="Z", api_request_id="a2"),
        ev("llm.error", "er", ts=4.0, session_id="Z", api_request_id="a2"),
        ev("session.end", "se", ts=5.0, session_id="Z"),
        llm_resp("anchor", ts=4000.0),
    ]
    assert detect(events) == []


@pytest.mark.parametrize(
    "kind, end_kind",
    [("llm.request", "llm.response"), ("llm.request", "llm.error")],
)
def test_stall_llm_request_closes_on_both_response_and_error(kind, end_kind):
    anchor = llm_resp("anchor", ts=400.0, session_id="Z")  # pins max_ts
    open_case = [ev(kind, "rq", ts=0.0, session_id="Z", api_request_id="a1"), anchor]
    assert [f.rule for f in detect(open_case)] == ["unanswered_request"]
    closed = open_case + [ev(end_kind, "end", ts=1.0, session_id="Z",
                             api_request_id="a1")]
    assert detect(closed) == []


def test_stall_pops_oldest_open_request_first_fifo():
    events = [
        ev("llm.request", "rq1", ts=0.0, session_id="Z", api_request_id="a1"),
        ev("llm.request", "rq2", ts=5.0, session_id="Z", api_request_id="a2"),
        ev("llm.response", "rp1", ts=400.0, session_id="Z", api_request_id="a1"),
    ]
    got = detect(events)
    assert [f.event_ids for f in got] == [["rq2"]]


def test_unanswered_request_any_later_event_in_session():
    # No llm.response/llm.error, but the session visibly carried on: cancelled,
    # not stuck. Reported as unanswered_request, never with an age or duration.
    events = [
        ev("llm.request", "rq", ts=0.0, session_id="Z", api_request_id="a1"),
        ev("turn.start", "t1", ts=900.0, session_id="Z"),
        llm_resp("anchor", ts=1000.0, session_id="Z"),
    ]
    got = detect(events)
    assert [(f.rule, f.severity) for f in got] == [("unanswered_request", "low")]
    f = got[0]
    assert f.event_ids == ["rq"] and f.session_id == "Z"
    assert "older than" not in f.message
    for token in f.message.split():
        assert not token.endswith("s") or not token[:-1].replace(".", "").isdigit()


def test_unanswered_request_needs_later_activity_same_session():
    later_elsewhere = [
        ev("llm.request", "rq", ts=0.0, session_id="Z", api_request_id="a1"),
        ev("turn.start", "t1", ts=900.0, session_id="OTHER"),
        llm_resp("anchor", ts=1000.0, session_id="OTHER"),
    ]
    assert [f.rule for f in detect(later_elsewhere)] == ["stall"]


def test_unanswered_request_message_shape_is_stable():
    events = [
        ev("llm.request", "rq", ts=0.0, session_id="Z", api_request_id="a1"),
        ev("turn.start", "t1", ts=900.0, session_id="Z"),
    ]
    (f,) = detect(events)
    assert f.message == "llm.request a1 got no answer, but the session carried on afterwards"


def test_stall_missing_fields_never_flagged_never_crash():
    assert detect([ev("session.start", "a", ts=0.0, session_id=None)]) == []
    assert detect([ev("llm.request", "b", ts=0.0, api_request_id=None)]) == []
    assert detect([ev("session.end", "c", ts=0.0, session_id=None)]) == []
    assert detect([ev("llm.response", "d", ts=0.0, api_request_id=None,
                      session_id="Z")]) == []
    # open session whose start has no usable ts (string) -> cannot age -> skip
    assert detect([dict(ev("session.start", "e", session_id="Z"), ts="0.0"),
                   llm_resp("now", ts=9999.0)]) == []


@pytest.mark.parametrize(
    "tokens_list, n_findings",
    [
        ([100, 100, 100], 0),       # flat
        ([100, 100, 300], 0),       # exactly 3x median -> not strictly greater
        ([100, 100, 301], 1),       # just over
        ([100, 3000], 0),           # below spike_min_samples
        ([3000, 100, 100, 100], 1), # order shouldn't matter (median of 4 = 100)
        ([100, 100, 100, 301, 400], 2), # median 100 -> both spikes cited
    ],
)
def test_token_spike_median_and_factor(tokens_list, n_findings):
    events = [llm_resp(f"r{i}", ts=float(i), session_id="Z",
                       usage={"total_tokens": t}) for i, t in enumerate(tokens_list)]
    got = [f for f in detect(events) if f.rule == "token_spike"]
    assert len(got) == n_findings
    for f in got:
        assert f.severity == "medium" and f.session_id == "Z"


def test_token_spike_skips_bad_usage_samples_without_crashing():
    events = [llm_resp(f"r{i}", ts=float(i), session_id="Z", usage=u)
              for i, u in enumerate([{"total_tokens": 10}, "nope", None,
                                     {"total_tokens": "3000"}, {},
                                     {"total_tokens": True}])]
    # only ONE usable sample -> below min_samples
    assert [f for f in detect(events) if f.rule == "token_spike"] == []


def test_token_spike_is_per_session():
    # the huge sample only makes sense against OTHER sessions' tokens; pooled
    # across sessions it would still be < 3x the pooled median -> the rule
    # must aggregate per session, and 2-sample sessions are below min_samples
    events = [
        llm_resp("a0", ts=1.0, session_id="A", usage={"total_tokens": 100}),
        llm_resp("a1", ts=2.0, session_id="A", usage={"total_tokens": 100}),
        llm_resp("b0", ts=3.0, session_id="B", usage={"total_tokens": 100}),
        llm_resp("b1", ts=4.0, session_id="B", usage={"total_tokens": 5000}),
    ]
    assert [f for f in detect(events) if f.rule == "token_spike"] == []


@pytest.mark.parametrize("count_txt", [("has count", {"count": 7}),
                                       ("count unknown", {}),
                                       ("count unknown", {"count": None})])
def test_lost_events_markers(count_txt):
    _, attrs = count_txt
    got = detect([ev("omni.dropped", "m1", ts=1.0, attrs=attrs)])
    assert len(got) == 1
    f = got[0]
    assert (f.rule, f.severity) == ("lost_events", "high")
    assert ("count=7" if "count" in attrs and attrs["count"] is not None
            else "count unknown") in f.message
    assert f.event_ids == ["m1"]


def test_lost_events_marker_without_event_id_cannot_be_cited():
    assert detect([dict(ev("omni.dropped", "x", ts=1.0), event_id="")]) == []
    assert detect([dict(ev("omni.dropped", "x", ts=1.0), event_id=None)]) == []


# --------------------------------------------------------------------------
# determinism & purity
# --------------------------------------------------------------------------


def _mark(i):
    return ev("omni.dropped", f"lost{i}", ts=300.0 + i, attrs={"count": 1})


RICH = (
    [ev("session.start", "sA", ts=1.0, session_id="A")]
    + [tool_end(f"f{i}", "bash", ts=2.0 + i, status="error", session_id="A")
       for i in range(3)]
    + [tool_end(f"L{i}", "search", ts=10.0 + i, turn_id="T9", session_id="A",
                arg_names=["query"]) for i in range(5)]
    + [ev("session.start", "sB", ts=0.0, session_id="B")]
    + [ev("llm.request", "uq", ts=3.0, session_id="A", api_request_id="a9")]
    + [llm_resp(f"h{i}", ts=800.0 + i, session_id="A", duration_s=90.0,
                usage={"total_tokens": t})
       for i, t in enumerate([100, 100, 301])]
    + [_mark(0), _mark(1)]
)


def test_rich_corpus_triggers_every_rule():
    rules = {f.rule for f in detect(RICH)}
    assert rules == {"repeated_tool_failure", "loop", "stall", "unanswered_request",
                     "slow_inference", "token_spike", "lost_events"}


def test_findings_deterministic_under_input_order():
    baseline = tupled(detect(RICH))
    assert baseline, "corpus must trigger findings"
    seen_same = 0
    for seed in range(8):
        shuffled = list(RICH)
        random.Random(seed).shuffle(shuffled)
        assert tupled(detect(shuffled)) == baseline, f"non-deterministic for seed {seed}"
        seen_same += 1
    assert seen_same == 8


def test_equal_timestamps_do_not_leak_input_order():
    twin = [tool_end("x", "bash", ts=5.0, status="error"),
            tool_end("y", "bash", ts=5.0, status="error"),
            tool_end("z", "bash", ts=5.0, status="error")]
    assert tupled(detect(twin)) == tupled(detect(list(reversed(twin))))


def test_every_finding_cites_real_nonempty_event_ids():
    valid = {e["event_id"] for e in RICH}
    for f in detect(RICH):
        assert f.event_ids, f"finding {f.rule} cites nothing"
        assert set(f.event_ids) <= valid


def test_findings_sorted_by_rule_then_keys():
    rules = [f.rule for f in detect(RICH)]
    assert rules == sorted(rules)


def test_findings_immutable_snapshot_not_shared_with_input():
    events = [tool_end(f"t{i}", "bash", ts=float(i), status="error")
              for i in range(3)]
    f = detect(events)[0]
    f.event_ids.append("injected")  # mutate a returned Finding's list...
    assert detect(events)[0].event_ids == ["t0", "t1", "t2"]  # ...does not poison next run


@pytest.mark.parametrize("cfg", [
    Config(),
    Config(repeated_tool_failure_threshold=2, loop_threshold=2, stall_s=1.0,
           slow_s=0.5, spike_factor=1.5, spike_min_samples=2),
])
def test_custom_config_consistency_under_shuffle(cfg):
    baseline = tupled(detect(RICH, cfg))
    for seed in range(3):
        shuffled = list(RICH)
        random.Random(seed).shuffle(shuffled)
        assert tupled(detect(shuffled, cfg)) == baseline
