# Development

> **Applies to:** Omniscience 1.0.0 · written at commit f2109ab
> **Revised:** 2026-11-11 · **Body hash:** 36a7a2a6


How the repository is laid out, how to run each suite, and how CI and the documentation stamps work.

## Layout

| Path | What it is |
|---|---|
| `__init__.py` | Hermes plugin entry point: `register(ctx)`, hook callbacks, `/omni` command |
| `sanitize.py` | Allowlist normalizers, redaction and bounds for every hook |
| `schema.py` | `omni.v1` event dataclass, columns and kinds |
| `store.py` | Bounded queue, writer thread, SQLite schema, drop markers, purge |
| `prefs.py` | Shared `prefs.json` reader/writer used by the plugin and the viewer |
| `privacy.py` | Per-chat pause/resume and recording deletion |
| `command.py` | `/omni` triage and usage reports |
| `digest.py`, `reminder.py`, `notices.py` | In-chat turn summary, cost reminders and live notices |
| `backfill.py` | One-time import of earlier chat metadata from Hermes' `state.db` |
| `viewer_launcher.py` | Starts and checks the viewer on loopback |
| `viewer/omniscience_viewer/` | The development copy of the FastAPI viewer |
| `viewer_app/omniscience_viewer/` | The copy shipped to installed plugins; keep it in step with `viewer/` |
| `viewer_app/static/` | Prebuilt web bundle served by installed viewers |
| `web/` | Vite + React + TypeScript UI, React Flow, vitest tests |
| `dashboard/` | Hermes dashboard tab: `manifest.json`, `dist/index.js`, `plugin_api.py` |
| `desktop/plugin.js` | Hermes Desktop plugin surface |
| `analysis/omniscience_analysis/` | Deterministic rules and the `python -m omniscience_analysis` CLI |
| `demo/` | Synthetic event generator for the demo database |
| `tests/` | pytest suites, including `contract/`, `e2e/` and `qa_core/` |
| `scripts/` | Operator and helper scripts (test, demo, deploy, stamp, coverage) |
| `docs/` | Guides; see the [documentation index](README.md) |

`viewer/` and `viewer_app/` are two copies of the same package: one for development, one bundled
for installation. When you change one, change the other. The polling guard workflow checks that the
interval line matches in both.

## Run the suites

Python (the CI path):

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
PYTHONPATH=viewer python3 -m pytest tests -q -p no:cacheprovider
```

Front end:

```bash
cd web
npm ci
npm test
npm run typecheck
```

Useful single-file runs:

```bash
PYTHONPATH=viewer python3 -m pytest tests/test_sanitize.py -q
PYTHONPATH=viewer python3 -m pytest tests/contract -q
cd web && npx vitest run src/graph/reduce.test.ts
```

The counts for this commit are in [../TESTING.md](../TESTING.md).

## CI

`.github/workflows/tests.yml` runs the Python suite on Ubuntu, macOS and Windows for Python 3.11
and 3.12, with `PYTHONPATH=viewer`. Two guard workflows enforce the viewer's polling rule:
`polling-guard.yml` and `polling-interval-guard.yml`. There is no CI job for the front-end suite.

## Documentation stamps

Every living guide under `docs/` begins with a stamp carrying the version and a hash of its own body.
The Python suite runs `scripts/docs-stamp.py --check`, so an edited guide with a stale stamp fails
the suite.

```bash
python3 scripts/docs-stamp.py --check   # what is behind
python3 scripts/docs-stamp.py --write   # restamp changed guides with today's date
python3 scripts/docs-stamp.py --index   # rebuild docs/DOC-INDEX.md
python3 scripts/docs-stamp.py --all     # index, write, then check
```

`docs/UI-GUIDE.md` is generated from `web/src/help/guide.json` by
`web/scripts/gen-ui-guide.mjs`. Edit the JSON, not the guide.

Dated snapshots under `docs/handover/` and `docs/design/` are excluded from restamping by design.

## Build, install and deploy

- `cd web && npm run build` writes `web/dist` for local development.
- `scripts/bundle-viewer.sh` copies the viewer and its build into the shipped `viewer_app/`.
- `scripts/deploy.sh` builds, installs, stamps and restarts the installed plugin, then reports which
  build is live. Use it when you need the installed copy to match this checkout.
- `scripts/verify-served.py` proves the page the server returns is the page just built.
- `scripts/live-build.py` prints the build the running viewer reports.

The plugin is stdlib-only by design: it runs inside Hermes' Python. The viewer may use FastAPI and
uvicorn because Hermes ships both. New Python dependencies need an upper bound (`>=X,<Y`) and belong
in `requirements-dev.txt` only if they are test or development tools.

## Style

- Keep hook callbacks bounded: copy scalars, never stringify containers, never block.
- Keep the recorder allowlist explicit. Add a field only with a normalizer and a test.
- Keep `reduce` and the analysis rules pure and deterministic; a test should prove the same input
  gives the same output.
- Never weaken a test to make it pass.

See [../CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution flow.

## Related

- [ARCHITECTURE](ARCHITECTURE.md) — the design this layout implements.
- [REFERENCE](REFERENCE.md) — hooks, routes, commands and rules.
- [Documentation index](README.md)
