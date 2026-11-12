# Verify — Hermes Omniscience

Applies to **Omniscience 1.0.0** · revised **2026-11-11**.

## One command

```bash
hermes plugins list --plain | grep -i omniscience
```

Expected: `enabled      git      1.0.0    omniscience` (the exact columns depend on your Hermes
version; the important parts are `enabled` and `1.0.0`).

## Full check

With the plugin installed at `<HERMES_HOME>/plugins/omniscience/`:

```bash
cd "${HERMES_HOME:-$HOME/.hermes}/plugins/omniscience"
python3 -c "import command, digest, schema"
```

Expected: no output, exit 0.

## Check it is recording

Run any Hermes turn that uses a tool, then read the database without modifying it:

```bash
sqlite3 "${HERMES_HOME:-$HOME/.hermes}/plugin-data/omniscience/events.db" \
  "SELECT kind, COUNT(*) FROM events GROUP BY kind ORDER BY kind;"
```

Expected: at least `session.start`, `turn.start`, `llm.request`, `llm.response` and usually
`tool.end`. An empty result means the plugin has not recorded anything in this profile yet.

## Check the viewer

```bash
curl -s http://127.0.0.1:8797/api/v1/health
curl -s http://127.0.0.1:8797/api/v1/version
```

`/api/v1/health` needs the key from `viewer-token`; `/api/v1/ping` does not. If the viewer is not
running, start it with `PYTHONPATH=viewer_app python3 -m omniscience_viewer`.

## Run the suite

The counts and the exact command are in [TESTING.md](TESTING.md).
