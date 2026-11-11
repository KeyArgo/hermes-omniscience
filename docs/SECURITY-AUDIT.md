# Security audit — module by module

> **Applies to:** Omniscience 1.0.0 · written at commit 95e0c82
> **Revised:** 2026-11-11 · **Body hash:** 233ce86b



**Date:** 2026-11-09 · **Tree:** `fdaeeb5` + the export fix · **Method:** read the module, then prove
the claim with a command. Every row below has the check that decided it, so it can be re-run rather
than believed.

The threat model is narrow and stated once: the viewer is a **localhost service**, protected by a
per-launch key; the dashboard runs behind Hermes' own auth; the recorder is a plugin inside the Hermes
process. The attacker we defend against is **another process or page on this machine** (a browser
page reaching 127.0.0.1, a local user reading files, a crafted event that reaches an export or a page).
We do not defend against the account owner, who can read the database directly.

| # | Module | Checked | Evidence | Verdict |
|---|---|---|---|---|
| S1 | `viewer/omniscience_viewer/auth.py` | Key comparison is constant-time; the key file cannot be written through a symlink and is 0600 | `hmac.compare_digest` (auth.py:77); `os.open(..., O_EXCL \| O_NOFOLLOW, 0o600)` (auth.py:30-31); `os.chmod(path, 0o600)` (:37) | **clear** |
| S2 | `viewer/omniscience_viewer/app.py` | Host allowlist, websocket origin check, key never injected into a non-loopback page, query-string keys rejected | `TrustedHostMiddleware(allowed_hosts=LOCAL_HOSTS)` (:183); `_origin_allowed` on every websocket (:423); `if _is_loopback_client(...)` before injecting the key (:542); `?t=` returns 401 (proven live, see S9) | **clear** |
| S3 | all viewer SQL (`db.py`, `export.py`, `usage.py`, `labels.py`) | No value is ever formatted into SQL — only the `?,?,?` placeholder string and a constant column tuple | the only f-strings in SQL are `({placeholders})` and `{', '.join(_EVENT_COLUMNS)}` (db.py:461, 532-533, 603-604); values are bound; connections use `mode=ro` | **clear** |
| S4 | `viewer/omniscience_viewer/export.py` | CSV formula injection, header injection, and the export filename | `_defuse()` prefixes `= + - @` and control characters; `_FILENAME_UNSAFE` keeps the caller's `root` to `[A-Za-z0-9._-]`; both have regression tests | **clear** |
| S5 | `sanitize.py` | Nothing but allowlisted metadata reaches the database; containers are dropped, never stringified | allowlist + a "never" key list (`sanitize.py:17`); `_put` drops dict/list/object (:190); tests `test_a_container_value_never_reaches_attrs`, `test_ids_in_attrs_still_lose_credential_shapes` | **clear** |
| S6 | `store.py` | Every database file is 0600 on every open, not only on create; WAL and shm too | `_chmod_private()` called from `_open_db()`; test `test_existing_db_is_reprivatised_on_open` | **clear** |
| S7 | `viewer/omniscience_viewer/sources.py` | Reads only fixed roots under `$HOME`; writes only `usage.db` beside the recorder's database; keeps metadata only | roots are the five `_root(...)` constants (:351-371); the only connection opened for write is `usage_db_path()`; parsers return token counts, never message text | **clear** |
| S8 | `dashboard/plugin_api.py` | Read-only, no write endpoint, does not create the database as a side effect | `sqlite3.connect("file:…?mode=ro")`; tests `test_reading_health_never_creates_the_database`, `test_health_reports_a_locked_database_instead_of_zero_events` | **clear** |
| S9 | the running service | No token, key header, query key, websocket forms, and a foreign origin, all against a real launch | live probe 2026-11-09 on 127.0.0.1:8797: `/sessions`, `/export/chats.csv` (7.3 s), `/diagnose?root=…`, `/prefs` each answer **401** without a key, **200** with `x-omni-token`, **401** with `?t=<key>`; WS **101** with `omni.<key>`, **403** with `?t=`, a wrong subprotocol, no auth, or `Origin: http://evil.example` | **clear** |
| S10 | every module | No shell execution, and the only file write outside SQLite is the preferences file | `grep -rn "shell=True"` → no match; one `os.fdopen(fd, "w")` in `prefs.py:103` | **clear** |

## Residual risks (accepted, with the reason)

1. **`OMNISCIENCE_DB` decides which directory the key is read from** (`dashboard/plugin_api.py:87`).
   Reported as a path traversal; **rejected** — whoever sets a process's environment already controls
   that process and could read the file directly. It is not reachable through a request.
2. **The dashboard's `/viewer` endpoint hands the viewer key to the page.** It sits behind Hermes'
   dashboard auth, and the key is a localhost-only capability for a read-only viewer.
3. **`POST /api/v1/usage/sources` can switch a harness on and trigger a scan** of that harness'
   directory. It requires the key, it is loopback-only, and the scan reads only the five known roots —
   but a key holder can make the server touch those directories. Accepted: that is the feature.
4. **Imported rows carry a `project` name** (the first path component under the harness root, cut to
   80 characters). It is a directory name, not content. Documented in `sources.py`'s docstring.
5. **No rate limiting.** The service is loopback-only and token-gated; a local flood is a self-inflicted
   denial of service, not an escalation.
6. **The recorder trusts the hook payload** it is given. A malicious plugin in the same process could
   feed it anything; the allowlist then limits what is stored, which is the boundary we control.

## What this audit does not claim

It does not claim the absence of bugs elsewhere in these modules — behaviour defects are tracked in
`docs/BUG-LOG.md`. It claims that each security property above was checked against this tree and holds,
and that the two findings raised by reviewers were examined and resolved (one rejected with the reason,
one fixed: the token-file symlink, S1).

## Re-run

```bash
cd hermes-omniscience
PYTHONPATH=viewer:viewer_app:. .venv/bin/python -m pytest -q tests/test_viewer_security.py \
    tests/test_viewer_token.py tests/test_export.py tests/test_dashboard_viewer_link.py
```
