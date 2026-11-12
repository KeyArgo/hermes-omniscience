# Troubleshooting

> **Applies to:** Omniscience 1.0.0 · written at commit f2109ab
> **Revised:** 2026-11-11 · **Body hash:** d66a3037


Real failure modes this code produces or handles, and the shortest way to check each one. Start with
`GET /api/v1/health` and the viewer log; both answer most questions.

## The viewer page says "No page bundle is installed"

The viewer is running but `index.html` is not in the static directory it was given.

- If you run from the repository with `PYTHONPATH=viewer`, the default looks for `web/dist` and then
  `viewer/static`, which is not where the shipped bundle lives. Pass it explicitly:

  ```bash
  PYTHONPATH=viewer python3 -m omniscience_viewer --db "$OMNISCIENCE_DB" --static viewer_app/static
  ```

- For the demo, `PYTHONPATH=viewer_app python3 -m omniscience_viewer --demo` finds the shipped
  bundle without a flag.
- For development, `cd web && npm ci && npm run build` creates `web/dist`.

## The viewer exits with "no events database at …"

The resolved path does not exist yet. The plugin creates the file on its first event, so a fresh
profile has no database until Hermes records something.

- Check which path was resolved: the message names the source (`--db`, `OMNISCIENCE_DB`, or the
  `HERMES_HOME` default).
- To look at synthetic data instead, run with `--demo`.
- To start an isolated demo home, run `scripts/demo-home.sh`.

## The viewer does not start when Hermes loads the plugin

The launcher returns a reason and writes it to `<HERMES_HOME>/plugin-data/omniscience/viewer.log`.
Common reasons from `viewer_launcher.py`:

| Reason | Check |
|---|---|
| `autostart off` | `OMNISCIENCE_VIEWER_AUTOSTART` is set to `0`/`false`/`no`/`off`. |
| `paused (recording continues)` | The `paused` marker exists. Run `scripts/omni.sh resume`. |
| `non-local URL, refusing to auto-start` | `OMNISCIENCE_VIEWER_URL` points at a non-loopback host. Start the viewer yourself if that is intended. |
| `port in use by another Omniscience viewer` | Another viewer answers on the port but with a different database fingerprint. Stop it or change `OMNISCIENCE_VIEWER_URL`. |
| `spawned but did not become ready within 5s` | Read `viewer.log`; the interpreter may lack FastAPI or uvicorn. |
| `a start was attempted less than a minute ago` | The launcher refuses to retry immediately. Fix the cause, then wait or delete `viewer.last-start`. |

Only one start runs at a time thanks to `viewer.lock`.

## The top bar says OFFLINE

Either the viewer is not running, no WebSocket library is installed, or the chat is idle with no
live events. Install `websockets` or `uvicorn[standard]` in the environment that runs the viewer.
REST routes can still work while the live badge says OFFLINE.

## The page says its key is out of date

The page and the viewer disagree about `viewer-token`. Reload the page; the viewer injects the
current key when it serves `/` to a loopback client. The key is reused across restarts only while
the file is mode `0600` and owned by the current user; otherwise a new key is written. `/omni` and
the dashboard page read the same file.

## A chat is missing or the list is empty

- Confirm the plugin is enabled and the gateway has been restarted since you enabled it. Hermes
  discovers plugins once per process.
- Check the database path. Each profile has its own `events.db`; `OMNISCIENCE_DB` overrides it.
- A session that ran before the plugin was loaded is not in the recording. The plugin imports
  earlier chat metadata once from Hermes' `state.db` unless `OMNISCIENCE_IMPORT_HISTORY=0`.
- A deleted or archived chat is removed or hidden by `on_session_delete` by design.

## Events were lost

The recorder uses a bounded queue of 10,000 events. If the writer cannot keep up — the database is
locked, the disk is full, or a burst is large — events are dropped and counted, and an
`omni.dropped` row marks the gap. The map draws a `GAP` box and the header counts lost records.

- Check free disk space and that the database is writable by the Hermes user.
- A busy database is retried once per batch; repeated failures are visible as lost records.
- This is a deliberate trade-off: the agent is never blocked.

## A box stays blue ("running") after the run ended

Blue means a start event arrived without a matching end event. The end may have been dropped, or
the process may have been killed before writing it. Check the lost-record count and the session's
last event. Replay will show the same state because it only redraws recorded rows.

## The Usage page shows tokens but no money

Money comes from Hermes' own `state.db` estimate, never from the recorder. If that database is not
found at `OMNISCIENCE_STATE_DB` or `~/.hermes/state.db`, the page still shows measured tokens.
A dollar figure is always labelled as Hermes' estimate, not a bill.

## "Ask a Model" fails

The endpoint returns HTTP 502 with a reason. It needs credentials Hermes already has
(`auth.json`, `config.yaml`, `.env`) and a provider that answers its model list. The request carries
a metadata-only digest; prompts and tool results are not stored, so none can be sent. See
`GET /api/v1/insight/models` for what was discovered.

## The brake refuses to stop a run

The brake is off until `scripts/brake.sh on` enables Hermes' run API and writes `brake.json`. With
it off, the viewer says so instead of pretending. The API can stop a run; it cannot skip one tool
call inside a run. If the API is on but unreachable, the failure says that too.

## Windows

- `scripts/demo-home.sh`, `scripts/real-run.sh`, `scripts/omni.sh` and `scripts/brake.sh` are
  POSIX shell scripts. Use the Python viewer and the Windows test script instead.
- The `0600` mode on `events.db` is not applied on Windows. Privacy depends on the folder's ACLs.
- Run the suite with `powershell -ExecutionPolicy Bypass -File .\scripts\test-windows.ps1`.

## A documentation check fails

The Python suite includes `tests/test_docs_currency.py`, which fails when a guide was edited without
being restamped. Stamp the changed guides and regenerate the index:

```bash
python3 scripts/docs-stamp.py --write
python3 scripts/docs-stamp.py --index
```

## The page is still showing old code

The page is served no-cache and hashed assets are immutable. If an update was installed while a tab
was open, the page notices the build id changed and offers a reload. `scripts/verify-served.py`
proves the server is serving the bundle just built.

## Related

- [INSTALL](INSTALL.md) — install and removal steps.
- [CONFIGURATION](CONFIGURATION.md) — every variable and state file.
- [FAQ](FAQ.md) — short answers.
- [Documentation index](README.md)
