"""The Usage page's arithmetic, tested on rows rather than on a live database.

Every case here is a way the page could lie: a helper counted as its own chat, a title call
read as a compaction, a cache saving claimed for a model with no published rate, a dollar
figure invented when Hermes has none.
"""

import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

from omniscience_viewer import usage as U  # noqa: E402


def call(ts, sid, prompt, output=100, cache_read=0, model="deepseek-v4.1-flash-1017",
         duration=1.0, ttfb=0.2, parent=None, status=None):
    attrs = {
        "response_model": model,
        "duration_s": duration,
        "ttfb_s": ttfb,
        "usage": {
            "prompt_tokens": prompt,
            "input_tokens": max(0, prompt - cache_read),
            "cache_read_tokens": cache_read,
            "output_tokens": output,
        },
    }
    return (ts, "llm.response", sid, parent, status, json.dumps(attrs))


def aux(ts, sid, prompt, output=20):
    return (ts, "aux.response", sid, None, None,
            json.dumps({"aux_task": "titling", "usage": {"prompt_tokens": prompt,
                                                          "output_tokens": output}}))


def tool(ts, sid, name="terminal"):
    return (ts, "tool.end", sid, None, "ok", json.dumps({"tool_name": name, "duration_ms": 5}))


def test_totals_sum_prompt_cache_and_output():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1000, output=50, cache_read=600),
            call(now - 5, "s2", 2000, output=70, cache_read=1500)]
    out = U.summarise(rows, days=1, now=now)
    assert out["totals"]["calls"] == 2
    assert out["totals"]["prompt"] == 3000
    assert out["totals"]["cache_read"] == 2100
    assert out["totals"]["fresh"] == 900
    assert out["totals"]["output"] == 120


def test_fresh_never_goes_negative_when_cache_exceeds_prompt():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1000, cache_read=1400)]
    out = U.summarise(rows, days=1, now=now)
    assert out["totals"]["fresh"] == 0


def test_a_helper_rolls_up_into_the_chat_that_started_it():
    now = 1_800_000_000
    rows = [call(now - 30, "root", 5000, output=10),
            call(now - 20, "helper", 4000, output=10, parent="root"),
            call(now - 10, "grandchild", 3000, output=10, parent="helper")]
    out = U.summarise(rows, days=1, now=now)
    assert [c["id"] for c in out["chats"]] == ["root"]
    chat = out["chats"][0]
    assert chat["calls"] == 3
    assert chat["prompt"] == 12000
    assert out["totals"]["chats"] == 1


def test_an_aux_call_is_counted_but_never_reads_as_context():
    now = 1_800_000_000
    rows = [call(now - 60, "s1", 200_000), aux(now - 50, "s1", 300)]
    out = U.summarise(rows, days=1, now=now)
    assert out["totals"]["aux_calls"] == 1
    assert out["context"]["calls_with_context"] == 1, "the 300-token title call has no context"
    assert out["context"]["compactions"] == []


def test_compaction_needs_a_real_drop_and_is_not_triggered_by_a_small_one():
    now = 1_800_000_000
    rows = [call(now - 300, "s1", 300_000),
            call(now - 200, "s1", 290_000),   # a 10k drop, only 3%: no compaction
            call(now - 100, "s1", 60_000)]    # a 230k drop: compaction
    out = U.summarise(rows, days=1, now=now)
    comps = out["context"]["compactions"]
    assert len(comps) == 1
    assert comps[0]["before"] == 290_000 and comps[0]["after"] == 60_000


def test_cache_saving_uses_a_published_rate_and_only_where_one_exists():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1_000_000, cache_read=900_000, model="deepseek-v4.1-flash"),
            call(now - 5, "s1", 1_000_000, cache_read=900_000, model="some-unknown-model")]
    out = U.summarise(rows, days=1, now=now)
    # 900k cached tokens at (0.15 - 0.003) per million, for the known model only.
    assert out["cache"]["saved_usd"] == pytest.approx(0.1323, abs=1e-4)
    assert out["cache"]["priced_share"] == pytest.approx(0.5)
    unknown = [m for m in out["models"] if m["model"] == "some-unknown-model"][0]
    assert unknown["rates"] is None


def test_no_rate_means_no_dollar_claim_at_all():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1000, cache_read=900, model="mystery/model-1")]
    out = U.summarise(rows, days=1, now=now)
    assert out["cache"]["saved_usd"] is None


def test_cost_comes_only_from_hermes_and_is_absent_when_it_has_none():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1000), call(now - 9, "s2", 1000)]
    costs = [{"id": "s1", "started_at": now - 20, "model": "deepseek-v4.1-flash-1017",
              "estimated_cost_usd": 1.25}]
    out = U.summarise(rows, costs, days=1, now=now)
    assert out["totals"]["cost"] == pytest.approx(1.25)
    assert out["cost_available"] is True
    by_id = {c["id"]: c for c in out["chats"]}
    assert by_id["s1"]["cost"] == pytest.approx(1.25)
    assert by_id["s2"]["cost"] is None, "a chat Hermes did not price claims no money"

    bare = U.summarise(rows, [], days=1, now=now)
    assert bare["totals"]["cost"] == 0
    assert bare["cost_available"] is False


def test_a_cost_row_older_than_the_window_is_left_out():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1000)]
    costs = [{"id": "old", "started_at": now - 10 * 86400, "model": "m",
              "estimated_cost_usd": 99.0}]
    out = U.summarise(rows, costs, days=1, now=now)
    assert out["totals"]["cost"] == 0


def test_daily_buckets_use_the_local_day_and_carry_cost():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1000), call(now - 86400 - 10, "s1", 2000)]
    costs = [{"id": "s1", "started_at": now - 10, "model": "m", "estimated_cost_usd": 0.5}]
    out = U.summarise(rows, costs, days=3, now=now)
    days = {d["day"]: d for d in out["daily"]}
    assert len(days) == 2
    newest = max(days)
    assert days[newest]["calls"] == 1
    assert days[newest]["cost"] == pytest.approx(0.5)


def test_junk_attrs_do_not_break_the_page():
    now = 1_800_000_000
    rows = [
        (now - 10, "llm.response", "s1", None, None, "not json"),
        (now - 9, "llm.response", "s1", None, None, json.dumps({"usage": "nope"})),
        (now - 8, "llm.response", "s1", None, None,
         json.dumps({"usage": {"prompt_tokens": float("nan"), "output_tokens": 5}})),
        (now - 7, "llm.response", "s1", None, None,
         json.dumps({"usage": {"prompt_tokens": "1200", "output_tokens": None}})),
    ]
    out = U.summarise(rows, days=1, now=now)
    assert out["totals"]["prompt"] == 1200
    assert out["totals"]["output"] == 5
    assert out["totals"]["calls"] == 2


def test_model_latency_summaries_ignore_calls_without_a_duration():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1000, duration=2.0), call(now - 9, "s1", 1000, duration=0)]
    out = U.summarise(rows, days=1, now=now)
    row = out["models"][0]
    assert row["p50_s"] == 2.0
    assert row["p95_s"] == 2.0


def test_context_histogram_places_each_call_in_one_band():
    now = 1_800_000_000
    rows = [call(now - 40, "s1", 30_000), call(now - 30, "s1", 150_000),
            call(now - 20, "s1", 400_000)]
    out = U.summarise(rows, days=1, now=now)
    bands = {b["band"]: b["calls"] for b in out["context"]["histogram"]}
    assert bands["25k–50k"] == 1
    assert bands["100k–200k"] == 1
    assert bands["350k–500k"] == 1
    assert sum(bands.values()) == 3


def test_tool_calls_are_counted_per_chat_and_in_total():
    now = 1_800_000_000
    rows = [call(now - 10, "s1", 1000), tool(now - 9, "s1"), tool(now - 8, "s1")]
    out = U.summarise(rows, days=1, now=now)
    assert out["totals"]["tool_calls"] == 2
    assert out["chats"][0]["tools"] == 2


class TestTheChatCommand:
    """/omni tokens is the way in: the shape of the period, and a link to the page."""

    def _report(self):
        return {
            "days": 7,
            "totals": {"calls": 1234, "chats": 9, "prompt": 1_680_000_000,
                       "output": 5_900_000, "cost": 14.136},
            "cache": {"hit_rate": 0.97, "saved_usd": 242.29, "priced_share": 1.0},
            "models": [
                {"model": "deepseek/deepseek-v4.1-flash-1017", "calls": 1200,
                 "prompt": 1_600_000_000, "p95_s": 12.4, "cost": 13.93},
                {"model": "deepseek/deepseek-v4-flash-0731", "calls": 34,
                 "prompt": 80_000_000, "p95_s": 21.5, "cost": 0.09},
            ],
            "chats": [
                {"id": "local-f4a32d80a14a171f", "calls": 1328, "cost": 2.86,
                 "prompt_now": 186_967, "prompt_max": 473_934},
            ],
            "context": {"compactions": [{"session": "s", "before": 512251, "after": 55070}]},
        }

    def test_the_reply_shows_the_shape_of_the_period(self):
        from omniscience.command import tokens_report

        text = tokens_report(self._report(), "http://127.0.0.1:8797/?view=usage&days=7")
        assert "Usage — the last 7 days" in text
        assert "1,234 model calls" in text and "9 chats" in text
        assert "1.68B context" in text
        assert "97% of that context came from the cache" in text
        assert "$242.29" in text, "the cache saving is worth naming"
        assert "$14.14" in text, "Hermes' estimate, rounded to cents"

    def test_the_reply_names_the_models_and_chats_that_carry_the_cost(self):
        from omniscience.command import tokens_report

        text = tokens_report(self._report(), "link")
        assert "By model" in text
        assert "deepseek-v4.1-flash-1017" in text and "p95 12.4s" in text
        assert "Costliest chats" in text
        assert "187k now / 474k peak" in text

    def test_compaction_and_a_slow_tail_are_called_out(self):
        from omniscience.command import tokens_report

        text = tokens_report(self._report(), "link")
        assert "Compaction: 1 recorded; deepest 512k → 55k" in text
        assert "slow tail" in text and "21.5s" in text

    def test_the_reply_ends_with_the_way_to_the_page(self):
        from omniscience.command import tokens_report

        text = tokens_report(self._report(), "http://127.0.0.1:8797/?view=usage&days=7&t=k")
        assert text.rstrip().endswith("http://127.0.0.1:8797/?view=usage&days=7&t=k")

    def test_no_cost_figure_when_hermes_has_none(self):
        from omniscience.command import tokens_report

        report = self._report()
        report["totals"]["cost"] = 0
        report["cache"]["saved_usd"] = None
        text = tokens_report(report, None)
        assert "spend" not in text
        assert "viewer is not running" in text

    def test_an_empty_period_says_so_instead_of_printing_zeros(self):
        from omniscience.command import tokens_report

        text = tokens_report({"days": 1, "totals": {"calls": 0}}, None)
        assert "No model calls recorded in this period" in text

    def test_a_degraded_headline_still_renders(self):
        """If the bundled module cannot load, the fallback carries four numbers and nothing
        crashes in the chat."""
        from omniscience.command import tokens_report

        text = tokens_report(
            {"days": 7,
             "totals": {"days": 7, "calls": 5, "chats": 1, "prompt": 1000,
                        "cache_read": 900, "output": 10, "cost": 0.25},
             "cache": {}, "models": [], "chats": [], "context": {}},
            None,
        )
        assert "5 model calls" in text and "$0.25" in text

    def test_headline_reads_the_recording_and_the_cost_store(self, tmp_path):
        import sqlite3 as s3
        from omniscience.command import usage_headline

        events = tmp_path / "e.db"
        con = s3.connect(events)
        con.execute("CREATE TABLE events (ts REAL, kind TEXT, session_id TEXT,"
                    " parent_session_id TEXT, attrs TEXT)")
        con.execute("INSERT INTO events VALUES (?, 'llm.response', 's1', NULL, ?)",
                    (time.time() - 10, json.dumps({"usage": {
                        "prompt_tokens": 1000, "cache_read_tokens": 900, "output_tokens": 50}})))
        # A root row carries an empty string, not NULL, for "no parent": that must not
        # make every chat look like a helper.
        con.execute("INSERT INTO events VALUES (?, 'llm.response', 's2', '', ?)",
                    (time.time() - 8, json.dumps({"usage": {
                        "prompt_tokens": 10, "cache_read_tokens": 0, "output_tokens": 1}})))
        # A helper session's spend belongs to s1; the headline must not call it a second chat.
        con.execute("INSERT INTO events VALUES (?, 'llm.response', 'helper', 's1', ?)",
                    (time.time() - 9, json.dumps({"usage": {
                        "prompt_tokens": 100, "cache_read_tokens": 0, "output_tokens": 5}})))
        con.commit()
        con.close()

        state = tmp_path / "state.db"
        scon = s3.connect(state)
        scon.execute("CREATE TABLE sessions (id TEXT, started_at REAL, estimated_cost_usd REAL)")
        scon.execute("INSERT INTO sessions VALUES ('s1', ?, 0.25)", (time.time() - 10,))
        scon.commit()
        scon.close()

        out = usage_headline(str(events), str(state), days=1)
        assert (out["calls"], out["chats"]) == (3, 2), "s2 is a chat; the helper is part of s1"
        assert (out["prompt"], out["cache_read"]) == (1110.0, 900.0)
        assert out["cost"] == pytest.approx(0.25)

    def test_headline_survives_missing_databases(self, tmp_path):
        from omniscience.command import usage_headline

        out = usage_headline(str(tmp_path / "nope.db"), str(tmp_path / "nope-state.db"), days=1)
        assert out["calls"] == 0 and out["cost"] is None


def test_a_helper_link_from_outside_the_window_still_rolls_up():
    """The link rides a turn.start row that can be days older than the period being read.
    Without it the helper is counted as a chat of its own — a phantom row in the list."""
    now = 1_800_000_000
    rows = [call(now - 10, "helper", 5000)]
    out = U.summarise(rows, days=1, now=now, parent_of={"helper": "root"})
    assert [c["id"] for c in out["chats"]] == ["root"]
    assert out["chats"][0]["calls"] == 1


def test_a_link_arriving_after_the_helpers_first_event_does_not_leave_a_phantom():
    now = 1_800_000_000
    link = (now - 5, "turn.start", "helper", "root", None, "{}")
    rows = [call(now - 10, "helper", 5000), link]
    out = U.summarise(rows, days=1, now=now)
    assert [c["id"] for c in out["chats"]] == ["root"]


def test_a_deep_helper_chain_lands_on_the_top_chat():
    now = 1_800_000_000
    out = U.summarise(
        [call(now - 10, "grandchild", 1000)],
        days=1,
        now=now,
        parent_of={"grandchild": "helper", "helper": "root"},
    )
    assert [c["id"] for c in out["chats"]] == ["root"]


def test_a_chat_that_started_before_the_window_still_shows_its_cost():
    """The period is windowed; a chat row is not.

    A session started eight days ago and still ran today: its tokens land inside a seven-day
    window while its estimate was dropped, so the row showed calls and tokens but cost None.
    """
    now = time.time()
    rows = [call(now - 60, "old-chat", 1000)]
    costs = [{"id": "old-chat", "started_at": now - 8 * 86400, "model": "m",
              "estimated_cost_usd": 1.25}]
    out = U.summarise(rows, costs, days=7, now=now)
    chat = next(c for c in out["chats"] if c["id"] == "old-chat")
    assert chat["cost"] == 1.25, chat
    # the period total stays windowed: this session's money belongs to last week
    assert out["totals"]["cost"] == 0.0, out["totals"]


def test_a_helpers_cost_lands_on_the_chat_that_started_it():
    """Helper calls are grouped under the root chat; their dollar estimate must follow them."""
    now = time.time()
    rows = [call(now - 60, "root", 1000), call(now - 50, "helper", 200)]
    costs = [
        {"id": "root", "started_at": now - 120, "model": "m", "estimated_cost_usd": 1.0},
        {"id": "helper", "started_at": now - 100, "model": "m", "estimated_cost_usd": 2.0},
    ]
    out = U.summarise(rows, costs, days=7, now=now, parent_of={"helper": "root"})
    root = next(c for c in out["chats"] if c["id"] == "root")
    assert root["cost"] == 3.0, root
    assert out["totals"]["cost"] == 3.0, out["totals"]


# --- the harness merge, and the six ways it could lie -------------------------------------------

def imp(source, ts, inp, out=100, cache_read=0, cache_write=0, sid="s1",
        model="model-x"):
    """One call as the importer hands it over (already-normalised token counts)."""
    return {"source": source, "session_id": sid, "ts": ts, "model": model,
            "input": inp, "output": out, "cache_read": cache_read,
            "cache_write": cache_write, "reasoning": 0, "project": None}


NOW = 1_800_000_000


def test_codex_input_already_contains_its_cached_tokens():
    # Real row: input_tokens 12820, cached_input_tokens 9984, total_tokens 12835.
    out = U.summarise([], imported=[imp("codex", NOW - 10, 12820, 15, cache_read=9984)],
                      days=1, now=NOW)
    assert out["totals"]["prompt"] == 12820
    assert out["totals"]["fresh"] == 12820 - 9984
    assert out["cache"]["hit_rate"] == pytest.approx(9984 / 12820, abs=1e-3)


def test_a_cache_warming_call_counts_its_write_tokens():
    # Real Claude row: input 2, cache_creation 19431, cache_read 12900 -> 32,333 sent.
    out = U.summarise([], imported=[imp("claude-code", NOW - 10, 2, 384,
                                        cache_read=12900, cache_write=19431)],
                      days=1, now=NOW)
    assert out["totals"]["prompt"] == 2 + 12900 + 19431


def test_two_one_call_chats_are_running_at_once():
    rows = [imp("codex", NOW - 10, 1000, sid="a"), imp("codex", NOW - 10, 1000, sid="b")]
    out = U.summarise([], imported=rows, days=1, now=NOW)
    assert out["time_metrics"]["peak_concurrent"] == 2


def test_a_cost_on_a_day_with_no_calls_still_gets_a_day():
    cost_rows = [{"id": "s1", "started_at": NOW - 4 * 86400, "model": "m",
                  "estimated_cost_usd": 5.0}]
    out = U.summarise([call(NOW - 10, "s1", 1000)], cost_rows, days=7, now=NOW)
    assert out["totals"]["cost"] == pytest.approx(5.0)
    assert sum(d["cost"] for d in out["daily"]) == pytest.approx(5.0)


def test_hermes_keeps_its_row_beside_the_imported_harnesses():
    out = U.summarise([call(NOW - 10, "s1", 1000)], imported=[imp("codex", NOW - 9, 1000)],
                      days=1, now=NOW)
    by_source = {h["source"]: h for h in out["harnesses"]}
    assert "hermes" in by_source and by_source["hermes"]["calls"] == 1
    # Hermes carried half the tokens, so its share must not be zero.
    assert by_source["hermes"]["prompt"] == 1000


def test_a_drop_to_a_small_context_is_still_a_compaction():
    rows = [call(NOW - 20, "s1", 300_000), call(NOW - 10, "s1", 800)]
    out = U.summarise(rows, days=1, now=NOW)
    assert out["context"]["compactions"], "a 300k -> 800 drop is the clearest compaction there is"
