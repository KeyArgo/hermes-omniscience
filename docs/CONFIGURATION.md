# Configuration

> **Applies to:** Omniscience 1.0.0 · written at commit f2109ab
> **Revised:** 2026-11-11 · **Body hash:** eeade3e2


Every setting Omniscience actually reads, where it lives, and what it does. The recorder reads
environment variables; the viewer reads them too, plus one small JSON preferences file next to the
database.

## Environment variables

| Variable | Default | Read by | Effect |
|---|---|---|---|
| `HERMES_HOME` | `~/.hermes` | plugin, viewer, dashboard | Profile home. The event database lives under `<HERMES_HOME>/plugin-data/omniscience/`. |
| `OMNISCIENCE_DB` | `<HERMES_HOME>/plugin-data/omniscience/events.db` | plugin, viewer, dashboard | Overrides the event database path. The preferences, token, usage database and bundles sit beside the resolved file. |
| `OMNISCIENCE_VIEWER_URL` | `http://127.0.0.1:8797` | plugin, launcher, dashboard | Where the viewer is expected. The launcher starts a viewer on this URL's port. |
| `OMNISCIENCE_DASHBOARD_URL` | `http://127.0.0.1:9120` | plugin, notices, dashboard | Base used for dashboard links in `/omni` replies and notices. |
| `OMNISCIENCE_VIEWER_AUTOSTART` | `1` | plugin, launcher | Set to `0`, `false`, `no` or `off` to stop the plugin starting the viewer. |
| `OMNISCIENCE_NOTICES` | `local` | plugin | `off` disables in-chat problem notices; `all` also allows messaging platforms; anything else keeps the local filter. |
| `OMNISCIENCE_IMPORT_HISTORY` | `1` | plugin | Set to `0`, `false`, `no` or `off` to skip the one-time import of earlier chat metadata from Hermes' `state.db`. |
| `OMNISCIENCE_DIGEST` | on | plugin, viewer | Hard off switch for the in-chat turn summary. `0`, `false`, `no` or `off` disables it regardless of `prefs.json`. |
| `OMNISCIENCE_COST_NOTICES` | `1` | plugin | Set to `0`, `false`, `no` or `off` to disable cost reminders. |
| `OMNISCIENCE_POLL_INTERVAL_S` | `1.0` | viewer | Seconds between live-feed polls while events are arriving. The guard workflows pin the default and the environment form. |
| `OMNISCIENCE_IDLE_POLL_INTERVAL_S` | `4.0` | viewer | Slower poll used after three empty polls. The first new row restores the normal interval. |
| `OMNISCIENCE_PARENT_PID` | unset | viewer | Set by the launcher. The viewer exits when that process is gone. |
| `OMNISCIENCE_VIEWER_CONTENT_LABELS` | `1` | viewer | Set to `0`, `false`, `no` or `off` to show session ids instead of chat titles from Hermes' `state.db`. |
| `OMNISCIENCE_STATE_DB` | `~/.hermes/state.db` | viewer | Hermes' own state database, used for chat titles and privacy-page labels. |
| `OMNISCIENCE_TENSORFOLD_HOSTS` | empty | viewer | Comma-separated `name=http://host:port` pairs for the optional DGX Sparks usage source. |
| `OMNISCIENCE_PORT` | `8797` | `scripts/omni.sh` | Port the pause/resume helper checks and stops. |

`HERMES_ROOT` and `HERMES_SOURCE` are used by the helper scripts, not by the plugin runtime.

## Stored preferences

`prefs.json` sits beside the event database (`<HERMES_HOME>/plugin-data/omniscience/prefs.json`, or
next to `OMNISCIENCE_DB`). The plugin and the viewer write the same file, so `/omni digest off` and
the Settings panel agree.

```json
{
  "version": 1,
  "digest": {
    "enabled": true,
    "detail": "standard"
  }
}
```

| Key | Values | Meaning |
|---|---|---|
| `digest.enabled` | `true` / `false` | Whether the turn summary is posted in chat. |
| `digest.detail` | `brief`, `standard`, `full` | How much the summary says. |

Unknown keys are preserved but ignored. A missing or broken file falls back to the defaults above.

## Viewer state files

All of these sit next to the resolved event database, normally under
`<HERMES_HOME>/plugin-data/omniscience/`:

| File | Written by | Purpose |
|---|---|---|
| `events.db` | plugin writer | The recording (SQLite WAL, mode `0600` where the platform supports it). |
| `events.db-wal`, `events.db-shm` | SQLite | Write-ahead log and shared-memory files. |
| `prefs.json` | plugin and viewer | The shared settings above. |
| `viewer-token` | viewer | Per-install key for `/api` requests, mode `0600`. Reused only while it is private to the current user. |
| `usage.db` | viewer | Token rows imported from other harnesses, if you switch a source on. |
| `viewer.log` | launcher | Viewer output. Created `0600`. |
| `viewer.lock`, `viewer.last-start` | launcher | Prevent duplicate starts and immediate retry loops. |
| `paused` | `scripts/omni.sh` | Present while the viewer is paused; recording continues. |
| `brake.json` | `scripts/brake.sh on` | URL and token for Hermes' own run-stop API. |
| `bundles/` | viewer | Redacted JSON problem bundles you choose to write. |
| `privacy-flags/` | viewer | Dossiers written by the privacy flag action. |

Chat titles are read live from Hermes' `state.db` and are never copied into `events.db`.

## Where settings live on the screen

The viewer's **Settings** panel writes browser-local layout choices (theme, default view, compact
text, titles, panel layout) and the shared digest setting through `POST /api/v1/prefs`. Layout
preferences stay in the browser; only the digest setting is stored beside the recording. **Reset
view** clears local layout keys but deliberately keeps the tour-seen flag and the privacy-alert
choice.

## Related

- [INSTALL](INSTALL.md) — install, upgrade, remove and where data is kept.
- [REFERENCE](REFERENCE.md) — routes, hooks, event kinds and CLI flags.
- [SECURITY](SECURITY.md) — what is stored and what is never stored.
- [Documentation index](README.md)
