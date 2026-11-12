# Contributing to Omniscience

Thanks for helping. Bug reports, small focused fixes and new ideas are all welcome.

## Report a bug or ask for a feature

Open an issue with the template. For a bug, include your OS, your Hermes Agent version
(`hermes --version`), the Omniscience version shown in the plugin, the steps, and what you expected.

For a security problem, do not open a public issue; use [SECURITY.md](SECURITY.md).

## Development setup

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
```

The plugin itself is standard-library only. The viewer may use FastAPI and uvicorn because Hermes
ships them. New Python dependencies need an upper bound (`>=X,<Y`).

## Run the checks

Run these before you push:

```bash
PYTHONPATH=viewer python3 -m pytest tests -q -p no:cacheprovider
cd web && npm ci && npm test
```

The Python command is what CI runs, on Linux, macOS and Windows for Python 3.11 and 3.12. If you
edit a guide in `docs/`, restamp it:

```bash
python3 scripts/docs-stamp.py --write
python3 scripts/docs-stamp.py --index
```

See [TESTING.md](TESTING.md) for the suite table and current counts, and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the repository layout.

## Send a change

1. Fork, then branch from `main`.
2. Keep the pull request to one logical change, with a test that fails before it and passes after.
   Never weaken a test to make it pass.
3. Describe what changed and why. If the change touches privacy, network calls or capabilities,
   say so in the description; those are reviewed first.
4. Use a clear commit message (`fix: …`, `feat: …`, `docs: …`, `ci: …`).

## Ground rules

- Plugins extend Hermes only through public hooks, `ctx.register_*` APIs and the Desktop SDK.
- Keep the recorder metadata-only: add a field only with an allowlist normalizer and a test.
- Keep `reduce` and the analysis rules pure and deterministic.
- By contributing you agree your work is released under this repository's MIT licence.
- Be kind; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
