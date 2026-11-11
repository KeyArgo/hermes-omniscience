"""Ask a model: finding an endpoint, and sending it nothing private.

The feature is only as good as its two promises: every model it offers is one this machine can
actually call, and the digest it sends carries counts and timings, never a prompt. Both are
testable without a network.
"""

import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import insight  # noqa: E402

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir()
    (home / "auth.json").write_text(
        json.dumps(
            {
                "active_provider": "nous",
                "providers": {},
                "credential_pool": {
                    "nous": [
                        {
                            "id": "n1",
                            "label": "someone@example.com",
                            "access_token": "token-from-pool",
                            "inference_base_url": "https://inference.example.com/v1",
                        }
                    ],
                    "other": [{"id": "o1", "label": "OTHER_API_KEY", "base_url": "https://other.example/v1"}],
                },
            }
        )
    )
    (home / "config.yaml").write_text(
        "model:\n"
        "  default: \"chosen/one\"\n"
        "  provider: \"nous\"\n"
        "  base_url: \"https://default.example/v1\"\n"
        "\n"
        "providers:\n"
        "  nous:\n"
        "    base_url: \"https://inference.example.com/v1\"\n"
        "  other:\n"
        "    base_url: \"https://other.example/v1\"\n"
        "    key_env: \"OTHER_API_KEY\"\n"
    )
    (home / ".env").write_text("OTHER_API_KEY=secret-from-env\n")
    monkeypatch.setattr(insight, "HERMES_HOME", home)
    monkeypatch.setattr(insight, "_models_cache", {"at": 0.0, "items": [], "unavailable": []})
    return home


def test_an_endpoint_is_built_from_the_credential_pool(hermes_home):
    rows = insight.endpoints()
    nous = next(row for row in rows if row["provider"] == "nous")
    assert nous["base_url"] == "https://inference.example.com/v1"
    assert nous["key"] == "token-from-pool"
    assert nous.get("default") is True


def test_a_key_is_found_by_the_env_name_the_pool_names(hermes_home):
    rows = insight.endpoints()
    other = next(row for row in rows if row["provider"] == "other")
    assert other["key"] == "secret-from-env"
    assert other["base_url"] == "https://other.example/v1"


def test_the_configured_default_model_is_offered_first(hermes_home, monkeypatch):
    monkeypatch.setattr(
        insight,
        "_models_from_endpoint",
        lambda endpoint: ["zeta", "chosen/one", "alpha"] if endpoint["provider"] == "nous" else [],
    )
    report = insight.list_models(refresh=True)
    top = report["models"][0]
    assert (top["provider"], top["model"], top.get("default")) == ("nous", "chosen/one", True)
    assert [row["model"] for row in report["models"][:3]] == ["chosen/one", "alpha", "zeta"]


def test_a_provider_that_does_not_list_models_is_reported_not_hidden(hermes_home, monkeypatch):
    def listing(endpoint):
        return ["only-one"] if endpoint["provider"] == "nous" else []

    monkeypatch.setattr(insight, "_models_from_endpoint", listing)
    report = insight.list_models(refresh=True)
    assert [row["provider"] for row in report["models"]] == ["nous"]
    assert any(item["provider"] == "other" for item in report["unavailable"])


def _events_db(path: Path) -> None:
    con = sqlite3.connect(str(path))
    con.execute(f"CREATE TABLE events ({COLUMNS})")
    rows = [
        (1.0, "llm.response", "s1", json.dumps({"response_model": "m", "duration_s": 2.0,
                                                "usage": {"prompt_tokens": 1000, "output_tokens": 10}})),
        (2.0, "llm.error", "s1", json.dumps({"reason": "rate_limit", "status_code": 429})),
        (3.0, "llm.error", "s1", json.dumps({"reason": "timeout"})),
    ]
    con.executemany(
        "INSERT INTO events (ts, kind, session_id, attrs) VALUES (?, ?, ?, ?)", rows
    )
    con.commit()
    con.close()


def test_the_digest_carries_counts_and_reasons(tmp_path):
    db = tmp_path / "events.db"
    _events_db(db)
    text = insight.build_digest(str(db), None, days=0)
    assert "TOTALS" in text
    assert "rate_limit: 1" in text
    assert "timeout: 1" in text
    assert "metadata only" in text.lower()


def test_the_digest_never_asks_for_or_carries_a_prompt(tmp_path):
    db = tmp_path / "events.db"
    _events_db(db)
    text = insight.build_digest(str(db), None, days=7)
    # The recorder stores no prompt text, so the digest cannot contain one; the note says so
    # rather than letting the model assume it is reading a transcript.
    assert "never stores prompts" in text


def test_a_successful_answer_is_returned_as_markdown(hermes_home, tmp_path, monkeypatch):
    db = tmp_path / "events.db"
    _events_db(db)

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps(
                {
                    "model": "chosen/one",
                    "choices": [{"message": {"content": "## Head\n- one"}, "finish_reason": "stop"}],
                    "usage": {"completion_tokens": 5},
                }
            ).encode()

    monkeypatch.setattr(insight.urllib.request, "urlopen", lambda request, timeout=0: FakeResponse())
    out = insight.ask("nous", "chosen/one", 7, str(db), None)
    assert out["markdown"] == "## Head\n- one"
    assert out["provider"] == "nous"
    assert out["finish_reason"] == "stop"


def test_an_empty_answer_says_why_instead_of_lying(hermes_home, tmp_path, monkeypatch):
    db = tmp_path / "events.db"
    _events_db(db)

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps(
                {"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}
            ).encode()

    monkeypatch.setattr(insight.urllib.request, "urlopen", lambda request, timeout=0: FakeResponse())
    with pytest.raises(RuntimeError) as exc:
        insight.ask("nous", "chosen/one", 7, str(db), None)
    assert "length" in str(exc.value)


def test_an_unknown_provider_is_refused_before_any_request(hermes_home, tmp_path, monkeypatch):
    db = tmp_path / "events.db"
    _events_db(db)
    monkeypatch.setattr(
        insight.urllib.request, "urlopen", lambda *a, **k: pytest.fail("no request should be sent")
    )
    with pytest.raises(RuntimeError):
        insight.ask("nowhere", "m", 7, str(db), None)


def test_the_picker_recommends_a_free_model_that_has_answered(hermes_home, monkeypatch):
    monkeypatch.setattr(
        insight,
        "_models_from_endpoint",
        lambda endpoint: ["deepseek/deepseek-v4.1-flash-1017", "deepseek-v4.1-flash-free"]
        if endpoint["provider"] == "nous"
        else [],
    )
    monkeypatch.setattr(
        insight,
        "_proven_models",
        lambda db_path: {
            ("nous", "deepseek/deepseek-v4.1-flash-1017"): {"calls": 900, "rate_limited": 0},
            ("nous", "deepseek-v4.1-flash-free"): {"calls": 40, "rate_limited": 0},
        },
    )
    report = insight.list_models(refresh=True)
    assert report["models"][0]["model"] == "deepseek-v4.1-flash-free"
    assert report["models"][0]["recommended"] is True
    assert "free" in report["models"][0]["why"]


def test_a_route_that_is_mostly_refusals_is_never_recommended(hermes_home, monkeypatch):
    # opencode-zen's free route: 0 successful calls against 10 rate limits. Cheap is not the same
    # as working, so it is offered but not suggested.
    monkeypatch.setattr(
        insight, "_models_from_endpoint", lambda endpoint: ["deepseek-v4.1-flash-free"] if endpoint["provider"] == "nous" else []
    )
    monkeypatch.setattr(insight, "_proven_models", lambda db_path: {})
    report = insight.list_models(refresh=True)
    assert not any(row.get("recommended") for row in report["models"])


def test_a_fraction_of_a_day_is_not_rounded_to_everything(tmp_path):
    """The routes take float days: "the last hour" is 1/24, and int() used to turn it into 0,
    which this API means as "everything ever recorded"."""
    from fastapi.testclient import TestClient

    from omniscience_viewer.app import create_app

    db = tmp_path / "events.db"
    _events_db(db)
    client = TestClient(create_app(str(db)), base_url="http://127.0.0.1")

    report = client.get("/api/v1/usage", params={"days": 1 / 24}).json()
    assert 0 < report["days"] < 1
    assert report["since"] == pytest.approx(report["generated_at"] - 3600, abs=5)


def test_a_provider_that_cannot_list_its_models_still_offers_what_ran(hermes_home, monkeypatch):
    """opencode-go answers no /v1/models, yet the owner has used two of its models. Offering them
    from the recording is what makes "any model you have access to" true."""
    monkeypatch.setattr(insight, "_models_from_endpoint", lambda endpoint: [])
    monkeypatch.setattr(
        insight,
        "_proven_models",
        lambda db_path: {("nous", "deepseek/deepseek-v4.1-flash-1017"): {"calls": 50, "rate_limited": 0}},
    )
    report = insight.list_models(refresh=True)
    offered = {(row["provider"], row["model"]) for row in report["models"]}
    assert ("nous", "deepseek/deepseek-v4.1-flash-1017") in offered
    assert any(row.get("from_recording") for row in report["models"])
    assert any("recordings show" in item["reason"] for item in report["unavailable"])
