# Testing Omniscience

Applies to **Omniscience 1.0.0** · revised **2026-11-11**.

This page lists every suite in the repo, how to run it, what CI runs, and the counts measured at
this commit. Test counts come from a run, not from a badge.

## What CI runs

The main workflow is [`.github/workflows/tests.yml`](.github/workflows/tests.yml). It runs one
job per matrix entry:

| Matrix | Values |
|---|---|
| OS | `ubuntu-latest`, `macos-latest`, `windows-latest` |
| Python | `3.11`, `3.12` |

Each job installs `requirements-dev.txt`, sets `PYTHONPATH=viewer`, and runs:

```bash
python -m pytest tests -q -p no:cacheprovider
```

Two additional workflows guard one design rule each and do not run the suite:

- [`polling-guard.yml`](.github/workflows/polling-guard.yml) checks that the live feed interval is
  environment-based with a 1.0 s default.
- [`polling-interval-guard.yml`](.github/workflows/polling-interval-guard.yml) checks that both
  viewer copies agree on the interval.

The platform badge says Linux, macOS and Windows because those are the CI matrix entries. This
local run was made on Linux only; macOS and Windows are covered by the CI jobs above, not by a
local measurement here.

## Suites

| Suite | What it covers | Command | Result at this commit |
|---|---|---|---|
| Python | Plugin hooks and sanitizers, store and writer, viewer REST/WS, contract and e2e tests, QA core, docs currency | `PYTHONPATH=viewer python3 -m pytest tests -q -p no:cacheprovider` | **805 passed**, 1 warning in 77.72 s |
| Front end | Graph reduction, views, panels, help layer, privacy and problem state (vitest) | `cd web && npm test` | **56 files passed**, **595 tests passed** in 22.09 s |
| Total | | | **1400 passed** |

Environment for the counts above: Linux, Python 3.13.13, Node 26.5.1, 2026-11-11. The Python
suite contains no skips or expected failures in that run.

Exact final lines:

```text
805 passed, 1 warning in 77.72s (0:01:17)
```

```text
 Test Files  56 passed (56)
      Tests  595 passed (595)
```

The warning is a `StarletteDeprecationWarning` from the installed FastAPI test client
(`httpx`/`starlette.testclient`), not a test failure.

## First run

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
PYTHONPATH=viewer python3 -m pytest tests -q -p no:cacheprovider
cd web && npm ci && npm test
```

`npm ci` installs the locked front-end dependencies. `requirements-dev.txt` is the only Python
dependency file; CI uses it too.

## What is in `tests/`

| Path | Contents |
|---|---|
| `tests/test_*.py` | Unit and integration tests for recording, sanitizing, storage, viewer routes, commands, privacy, export, usage, bundle, brake and versioning |
| `tests/contract/` | Hermes hook and source-contract tests |
| `tests/e2e/` | The live-path test and the helper-script tests |
| `tests/qa_core/` | QA analysis, sanitizer, store and viewer checks |
| `tests/fixtures/hermes/` | Recorded Hermes hook payloads used by the contract tests |

## Other checks

- `python3 scripts/docs-stamp.py --check` verifies every guide in `docs/` still matches the build
  it claims to describe. The Python suite runs this as `tests/test_docs_currency.py`, so an edited
  doc with a stale stamp fails the suite. Fix with `python3 scripts/docs-stamp.py --write`.
- `scripts/test.sh` (Linux/macOS) and `scripts/test-windows.ps1` (Windows) run each `tests`
  directory and write `RESULT.txt`. They are convenience wrappers for another machine, not the CI
  path.
- `dev/desktop-plugin-harness.test.mjs` is a manual harness for the desktop plugin. Its header
  names `dev/vitest.harness.config.mjs`, which is not present in the repo, so it was **not run**
  for these counts. CI does not run it either.

## Reporting a result

If you run the suite on another machine, send the exact final summary line and the commit. Do not
paraphrase it, and do not report a pass you did not see. See [docs/INSTALL.md](docs/INSTALL.md) for
install steps and [VERIFY.md](VERIFY.md) for a quick install check.
