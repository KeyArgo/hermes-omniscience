"""e2e lane tests — scripts and install docs.

These cover the *scripts* that the orchestrator runs against a real Hermes, not a
live Hermes run (that would need the binary + the fleet endpoint, and it must never
touch the real ~/.hermes). We test the guarantees the scripts promise:

  * all three scripts parse (``bash -n``)
  * demo-home.sh refuses to write into a real ~/.hermes / any */.hermes path
  * demo-home.sh creates config.yaml + the plugin symlink and is idempotent
  * secret-scan.sh flags a planted secret and passes a clean DB

stdlib + pytest only; the venv has no third-party deps for these.
"""

import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "scripts"
DEMO_HOME_SH = SCRIPTS / "demo-home.sh"
REAL_RUN_SH = SCRIPTS / "real-run.sh"
SECRET_SCAN_SH = SCRIPTS / "secret-scan.sh"
INSTALL_MD = REPO / "docs" / "INSTALL.md"

SCRIPTS_UNDER_TEST = [DEMO_HOME_SH, REAL_RUN_SH, SECRET_SCAN_SH]

# Minimal stand-in for the events schema (ARCHITECTURE.md sec.3). secret-scan only
# greps bytes, but a real sqlite file is a more honest fixture.
EVENTS_DDL = """
CREATE TABLE events (
    rowid INTEGER PRIMARY KEY,
    event_id TEXT UNIQUE,
    schema TEXT,
    boot_id TEXT,
    seq INTEGER,
    ts REAL,
    kind TEXT,
    session_id TEXT,
    parent_session_id TEXT,
    turn_id TEXT,
    api_request_id TEXT,
    tool_call_id TEXT,
    subagent_id TEXT,
    status TEXT,
    attrs TEXT
);
"""

HEX64 = "a" * 64


def run(script, *args, env=None):
    proc = subprocess.run(
        ["bash", str(script), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc


def make_events_db(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    con.executescript(EVENTS_DDL)
    con.executemany(
        "INSERT INTO events (event_id, schema, boot_id, seq, ts, kind, session_id, "
        "parent_session_id, attrs) VALUES (?,?,?,?,?,?,?,?,?)",
        rows,
    )
    con.commit()
    con.close()


# ------------------------------------------------------------------ script syntax
@pytest.mark.parametrize("script", SCRIPTS_UNDER_TEST, ids=lambda p: p.name)
def test_bash_syntax(script):
    assert script.exists(), f"missing {script}"
    proc = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
    assert proc.returncode == 0, f"bash -n failed for {script.name}:\n{proc.stderr}"


@pytest.mark.parametrize("script", SCRIPTS_UNDER_TEST, ids=lambda p: p.name)
def test_scripts_are_executable(script):
    assert os.access(script, os.X_OK), f"{script.name} is not executable (chmod +x)"


# ------------------------------------------------------------ demo-home: refusals
def test_demo_home_refuses_real_hermes_home(tmp_path):
    # Simulate the user profile dir without touching the real one.
    fake_home = tmp_path / "fakehome"
    protected = fake_home / ".hermes"
    env = {**os.environ, "HOME": str(fake_home),
           "OMNI_DEMO_HOME": str(protected)}
    proc = run(DEMO_HOME_SH, env=env)
    assert proc.returncode != 0, "expected refusal for $HOME/.hermes"
    assert "REFUSED" in (proc.stderr + proc.stdout)
    assert not protected.exists(), "script must not create the protected dir"


def test_demo_home_refuses_nested_dot_hermes(tmp_path):
    protected = tmp_path / "some" / "place" / ".hermes"
    env = {**os.environ, "OMNI_DEMO_HOME": str(protected)}
    proc = run(DEMO_HOME_SH, env=env)
    assert proc.returncode != 0, "expected refusal for a path ending in /.hermes"
    assert "REFUSED" in (proc.stderr + proc.stdout)
    assert not protected.exists(), "script must not create the protected dir"


@pytest.mark.skipif(os.name == "nt", reason="Linux shell script and symlinks — demo-home.sh needs bash and symlink support")
def test_demo_home_refuses_home_root(tmp_path):
    fake_home = tmp_path / "fakehome"
    fake_home.mkdir()
    env = {**os.environ, "HOME": str(fake_home), "OMNI_DEMO_HOME": str(fake_home)}
    proc = run(DEMO_HOME_SH, env=env)
    assert proc.returncode != 0, "expected refusal when target == $HOME"


# --------------------------------------------------------- demo-home: happy path
@pytest.mark.skipif(os.name == "nt", reason="Linux shell script and symlinks — demo-home.sh needs bash and symlink support")
def test_demo_home_creates_config_and_symlink(tmp_path):
    home = tmp_path / "demo-home"
    env = {**os.environ, "OMNI_DEMO_HOME": str(home)}
    proc = run(DEMO_HOME_SH, env=env)
    assert proc.returncode == 0, proc.stderr

    cfg = home / "config.yaml"
    assert cfg.is_file(), "config.yaml was not created"
    text = cfg.read_text()
    for needle in (
        "provider: fleet",
        "base_url: http://127.0.0.1:8890/v1",
        "api_key: no-key-required",
        "model: DeepSeek-V4.1-Flash-1017",
        "context_length: 524288",
        "omniscience",
        "completed: true",
    ):
        assert needle in text, f"config.yaml missing {needle!r}"

    link = home / "plugins" / "omniscience"
    assert link.is_symlink(), "plugins/omniscience must be a symlink"
    assert os.readlink(link) == str(REPO)

    # idempotent: a second run is a no-op success and does not clobber config
    proc2 = run(DEMO_HOME_SH, env=env)
    assert proc2.returncode == 0, proc2.stderr
    assert cfg.read_text() == text, "second run must not rewrite an existing config.yaml"


@pytest.mark.skipif(os.name == "nt", reason="Linux shell script and symlinks — demo-home.sh needs bash and symlink support")
def test_demo_home_default_location_is_repo_demo_home(tmp_path):
    # With no OMNI_DEMO_HOME it targets <repo>/.demo-home (guarded dir, gitignored).
    env = dict(os.environ)
    env.pop("OMNI_DEMO_HOME", None)
    env["HOME"] = str(tmp_path)  # keep the ~/.hermes guard satisfied
    proc = run(DEMO_HOME_SH, env=env)
    assert proc.returncode == 0, proc.stderr
    assert (REPO / ".demo-home" / "config.yaml").is_file()
    assert (REPO / ".demo-home" / "plugins" / "omniscience").is_symlink()
    shutil.rmtree(REPO / ".demo-home", ignore_errors=True)


# --------------------------------------------------------------- secret-scan
def test_secret_scan_flags_planted_secret(tmp_path):
    db = tmp_path / "events.db"
    planted = [
        ("e1", "omni.v1", "b1", 1, 1.0, "llm.error", "local-" + HEX64, None,
         '{"error_message":"auth failed header=Bearer abcdef0123456789abcdef012345"}'),
        ("e2", "omni.v1", "b1", 2, 2.0, "tool.end", "local-" + HEX64, None,
         '{"result_preview":"aws_key=AKIA0123456789ABCDEF leaked"}'),
        ("e3", "omni.v1", "b1", 3, 3.0, "tool.end", "local-" + HEX64, None,
         '{"note":"password=hunter2supersecret in body"}'),
        ("e4", "omni.v1", "b1", 4, 4.0, "tool.end", "local-" + HEX64, None,
         '{"note":"key sk-abcdefghij0123456789ABCDEFGHIJ was used"}'),
    ]
    make_events_db(db, planted)
    proc = run(SECRET_SCAN_SH, str(db))
    assert proc.returncode == 1, f"expected exit 1, got {proc.returncode}\n{proc.stdout}"
    out = proc.stdout + proc.stderr
    assert "HIT" in out and "FAIL" in out


def test_secret_scan_passes_clean_db(tmp_path):
    # Realistic sanitized rows: opaque hex ids + token COUNTS + tool/arg names.
    db = tmp_path / "events.db"
    clean = [
        ("e1", "omni.v1", "boot0001", 1, 1.0, "session.start", "local-" + HEX64, None,
         '{"platform":"cli","model":"DeepSeek-V4.1-Flash-1017"}'),
        ("e2", "omni.v1", "boot0001", 2, 2.0, "llm.request", "local-" + HEX64, None,
         '{"provider":"fleet","api_mode":"chat","max_tokens":8192,'
         '"approx_input_tokens":1287,"tool_count":3,"started_at":1.0}'),
        ("e3", "omni.v1", "boot0001", 3, 3.0, "llm.response", "local-" + HEX64, None,
         '{"usage":{"input_tokens":1287,"output_tokens":203,"cache_read_tokens":0,'
         '"reasoning_tokens":41,"total_tokens":1490},"finish_reason":"tool_calls"}'),
        ("e4", "omni.v1", "boot0001", 4, 4.0, "tool.end", "local-" + HEX64, None,
         '{"tool_name":"terminal","arg_names":["command","cwd"],"result_chars":18,'
         '"duration_ms":42,"status":"ok"}'),
        ("e5", "omni.v1", "boot0001", 5, 5.0, "subagent.start", "20261106_000000_ab12cd",
         "local-" + HEX64,
         '{"child_session_id":"20261106_000000_ab12cd","child_subagent_id":"sa-0-2ad3",'
         '"child_role":"worker","goal_chars":96}'),
        # an argument literally NAMED password must NOT trip the key=value rule
        ("e6", "omni.v1", "boot0001", 6, 6.0, "tool.end", "local-" + HEX64,
         None, '{"tool_name":"auth","arg_names":["password","username"],"status":"ok"}'),
    ]
    make_events_db(db, clean)
    proc = run(SECRET_SCAN_SH, str(db))
    assert proc.returncode == 0, (
        f"clean DB flagged as secret (false positive), exit {proc.returncode}\n"
        f"{proc.stdout}\n{proc.stderr}"
    )
    assert "PASS" in proc.stdout


def test_secret_scan_missing_file(tmp_path):
    proc = run(SECRET_SCAN_SH, str(tmp_path / "nope.db"))
    assert proc.returncode == 2


# ------------------------------------------------------------------ install docs
def test_install_doc_covers_required_sections():
    assert INSTALL_MD.is_file(), "docs/INSTALL.md missing"
    text = INSTALL_MD.read_text().lower()
    for needle in (
        "keyargo/hermes-omniscience",
        "subdirectory",
        "plugins enable",
        "gateway",
        "restart",
        "viewer",
        "plugins disable",
        "plugins remove",
        "plugin-data",
    ):
        assert needle in text, f"INSTALL.md missing required mention: {needle!r}"


# --- regression tests for the cross-family (GLM) review findings ------------------------------
import os as _os
import sqlite3 as _sqlite3
import subprocess as _sp
from pathlib import Path as _P

_SCRIPTS = _P(__file__).resolve().parents[2] / "scripts"


def _sandbox_env(tmp_path, **extra):
    # Fake HOME and a PATH without hermes: even a broken guard can never reach the real ~/.hermes.
    env = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin"}
    env.update(extra)
    return env


def test_real_run_refuses_hermes_home_even_when_config_exists(tmp_path):
    real = tmp_path / ".hermes"
    real.mkdir()
    (real / "config.yaml").write_text("model: {}\n")
    r = _sp.run(["bash", str(_SCRIPTS / "real-run.sh")], env=_sandbox_env(tmp_path, OMNI_DEMO_HOME=str(real)),
                capture_output=True, text=True, timeout=60)
    assert r.returncode == 2 and "REFUSED" in r.stderr


def test_real_run_refuses_profile_dirs(tmp_path):
    prof = tmp_path / ".hermes" / "profiles" / "coder"
    prof.mkdir(parents=True)
    (prof / "config.yaml").write_text("model: {}\n")
    r = _sp.run(["bash", str(_SCRIPTS / "real-run.sh")], env=_sandbox_env(tmp_path, OMNI_DEMO_HOME=str(prof)),
                capture_output=True, text=True, timeout=60)
    assert r.returncode == 2 and "REFUSED" in r.stderr


def test_real_run_never_deletes_existing_db():
    assert "rm -f" not in (_SCRIPTS / "real-run.sh").read_text()


def _scan(tmp_path, text, into="db"):
    db = tmp_path / "events.db"
    con = _sqlite3.connect(db)
    con.execute("create table events(x text)")
    con.commit()
    con.close()
    target = db if into == "db" else _P(str(db) + "-wal")
    with open(target, "ab") as f:
        f.write(("\n" + text + "\n").encode())
    return _sp.run(["bash", str(_SCRIPTS / "secret-scan.sh"), str(db)], capture_output=True, text=True, timeout=60)


def test_secret_scan_catches_fine_grained_github_and_bearer_colon(tmp_path):
    assert _scan(tmp_path, "github_" + "pat_" + "A1" * 20).returncode == 1


def test_secret_scan_catches_bearer_colon_form(tmp_path):
    assert _scan(tmp_path, "Bea" + "rer: " + "abcdefghij" * 3).returncode == 1


def test_secret_scan_reads_wal_sidecar(tmp_path):
    assert _scan(tmp_path, "AK" + "IA" + "ABCDEFGHIJKLMNOP", into="wal").returncode == 1


def test_secret_scan_passes_clean_ids(tmp_path):
    assert _scan(tmp_path, "local-" + "ab12" * 16 + " call_713285d6 omni.v1").returncode == 0
