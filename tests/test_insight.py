"""The writeup is Hermes' model, not this viewer's credential files.

Two promises are testable without a network. The digest carries counts and timings and never a
prompt — the recorder does not store one. And producing the writeup opens no credential file:
the call goes through the host's own ``ctx.llm`` facade (``agent/plugin_llm.py``), so no key is
read here, held here, or sent from here.

The regression this file guards: the first version of ``insight.py`` read ``auth.json``,
``config.yaml`` and ``.env`` to find an endpoint and a token. Every test below fails on that
module, and passes on one that asks the host instead.
"""

import builtins
import io
import json
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "viewer"))

from omniscience_viewer import insight  # noqa: E402

INSIGHT_SOURCE = ROOT / "viewer" / "omniscience_viewer" / "insight.py"

COLUMNS = (
    "rowid INTEGER PRIMARY KEY, event_id TEXT, schema TEXT, boot_id TEXT, seq INTEGER, ts REAL, "
    "kind TEXT, session_id TEXT, parent_session_id TEXT, turn_id TEXT, api_request_id TEXT, "
    "tool_call_id TEXT, subagent_id TEXT, status TEXT, attrs TEXT"
)

CREDENTIAL_NAMES = ("auth.json", ".env", "config.yaml")
CANARY = "CANARY-SECRET-DO-NOT-READ"


def test_the_insight_module_never_names_a_credential_file():
    """No credential file may be opened, so none may be named in the code that ships."""
    source = INSIGHT_SOURCE.read_text(encoding="utf-8")
    for name in CREDENTIAL_NAMES:
        assert name not in source, f"insight.py refers to Hermes' credential file {name}"


@pytest.fixture()
def credential_canary(tmp_path, monkeypatch):
    """A Hermes home full of files the writeup must never open; opening one is an assertion."""
    home = tmp_path / "hermes"
    home.mkdir()
    (home / "auth.json").write_text(
        json.dumps({"active_provider": "canary", "credential_pool": {"canary": [
            {"access_token": CANARY, "base_url": "https://canary.example/v1"}]}}),
        encoding="utf-8",
    )
    (home / "config.yaml").write_text(
        f"model:\n  provider: canary\n  base_url: https://canary.example/v1\n", encoding="utf-8"
    )
    (home / ".env").write_text(f"CANARY_API_KEY={CANARY}\n", encoding="utf-8")
    monkeypatch.setattr(insight, "HERMES_HOME", home, raising=False)

    opened: list[str] = []
    real_open = io.open

    def guarded(file, *args, **kwargs):
        path = Path(str(file))
        if path.name in CREDENTIAL_NAMES and path.parent == home:
            opened.append(str(path))
            raise AssertionError(f"the writeup opened a credential file: {path}")
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", guarded)
    monkeypatch.setattr(Path, "open", lambda self, *a, **k: guarded(self, *a, **k))
    return home, opened


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


def _host(text="## Head\n- one", model="chosen/one", provider="nous"):
    calls = []

    def complete(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            text=text,
            model=model,
            provider=provider,
            agent_id="main",
            usage=SimpleNamespace(input_tokens=1200, output_tokens=300, total_tokens=1500, cost_usd=0.01),
        )

    complete.calls = calls  # type: ignore[attr-defined]
    return complete


def test_the_writeup_never_opens_a_credential_file(credential_canary, tmp_path):
    _home, opened = credential_canary
    db = tmp_path / "events.db"
    _events_db(db)
    digest = insight.build_digest(str(db), None, days=7)
    report = insight.writeup(digest, _host(), days=7)
    assert report["markdown"] == "## Head\n- one"
    assert opened == []
    assert CANARY not in json.dumps(report)


def test_the_writeup_asks_the_host_for_the_completion(tmp_path):
    db = tmp_path / "events.db"
    _events_db(db)
    digest = insight.build_digest(str(db), None, days=7)
    complete = _host()
    report = insight.writeup(digest, complete, days=7)
    assert len(complete.calls) == 1
    sent = complete.calls[0]
    assert [row["role"] for row in sent["messages"]] == ["system", "user"]
    assert sent["messages"][0]["content"] == insight.SYSTEM_PROMPT
    assert sent["messages"][1]["content"] == digest
    assert sent["max_tokens"] > 0
    assert report["model"] == "chosen/one"
    assert report["provider"] == "nous"
    assert report["days"] == 7
    assert report["digest_chars"] == len(digest)


def test_a_completion_returning_plain_text_is_still_an_answer(tmp_path):
    """A host facade that hands back a bare string (older Hermes) must not break the writeup."""
    db = tmp_path / "events.db"
    _events_db(db)
    digest = insight.build_digest(str(db), None, days=7)
    report = insight.writeup(digest, lambda **kwargs: "plain text answer", days=7)
    assert report["markdown"] == "plain text answer"


def test_an_empty_answer_says_why_instead_of_lying(tmp_path):
    db = tmp_path / "events.db"
    _events_db(db)
    digest = insight.build_digest(str(db), None, days=7)
    with pytest.raises(RuntimeError) as exc:
        insight.writeup(digest, _host(text="   "), days=7)
    assert "empty" in str(exc.value).lower()


def test_the_writeup_is_saved_beside_the_recording_and_read_back(tmp_path):
    db = tmp_path / "events.db"
    _events_db(db)
    report = {"markdown": "## Head", "model": "m", "provider": "p", "days": 7.0,
              "took_s": 1.2, "generated_at": 1700000000.0, "digest_chars": 12}
    path = insight.save(str(db), report)
    assert Path(path).parent == db.parent
    assert Path(path).name == "insight.json"
    saved = insight.load(str(db))
    assert saved is not None
    assert {key: saved[key] for key in report} == report
    # A report belongs to the recording it describes: another database in the same folder is
    # not handed this one.
    assert insight.load(str(tmp_path / "nothing.db")) is None


def test_the_saved_writeup_is_readable_after_a_restart(tmp_path):
    """The file is the hand-off between Hermes (which has the model) and the viewer (which does not)."""
    db = tmp_path / "events.db"
    _events_db(db)
    insight.save(str(db), {"markdown": "# From the host", "days": 7})
    reloaded = json.loads(Path(insight.writeup_path(str(db))).read_text(encoding="utf-8"))
    assert reloaded["markdown"] == "# From the host"


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


def test_the_viewer_serves_the_saved_writeup_and_offers_no_credential_route(tmp_path):
    """The viewer can show a writeup Hermes wrote; it cannot ask a model itself."""
    from fastapi.testclient import TestClient

    from omniscience_viewer.app import create_app

    db = tmp_path / "events.db"
    _events_db(db)
    client = TestClient(create_app(str(db), token="k"), base_url="http://127.0.0.1")
    headers = {"x-omni-token": "k"}

    empty = client.get("/api/v1/insight", headers=headers).json()
    assert empty["available"] is False
    assert "omni insight" in empty["hint"]

    insight.save(str(db), {"markdown": "## From Hermes", "model": "m", "provider": "p",
                           "days": 7.0, "generated_at": 1700000000.0})
    body = client.get("/api/v1/insight", headers=headers).json()
    assert body["available"] is True
    assert body["report"]["markdown"] == "## From Hermes"

    # The route that used to read Hermes' credentials is gone.
    assert client.get("/api/v1/insight/models", headers=headers).status_code == 404
    assert client.post("/api/v1/insight", json={"provider": "p", "model": "m"},
                       headers=headers).status_code in (404, 405)
