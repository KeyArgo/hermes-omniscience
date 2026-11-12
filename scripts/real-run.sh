#!/usr/bin/env bash
#
# real-run.sh — phase 1.7 acceptance: a REAL Hermes run inside the isolated demo
# home, then a summary of what the omniscience plugin recorded.
#
# It runs, under a 900 s timeout:
#     HERMES_HOME=<demo home> hermes -z "<prompt that runs one terminal command
#                                           and one delegate_task subagent>"
# Hermes' gateway loads the symlinked omniscience plugin and writes
# <demo home>/plugin-data/omniscience/events.db. We then print, from that DB:
#     * event counts per kind
#     * number of distinct sessions (and their ids)
#     * child sessions linked to their parent via parent_session_id
#
# Exit status is non-zero unless all of these kinds are present:
#     session.start turn.start llm.request llm.response tool.end subagent.start
#
# The plugin lane owns what gets written; this script only reads the DB. It never
# touches the real ~/.hermes (the demo-home guard in demo-home.sh enforces that).
set -uo pipefail   # intentionally NOT -e: we must always print the DB summary.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# Absolute, symlink-resolved path for $1. GNU `readlink -m` is not on macOS and BSD
# `readlink` has no -m/-f either; use Python when present, then a plain-cd fallback.
abspath() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
    return 0
  fi
  local p="$1" rest="" base
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  while [ ! -e "$p" ] && [ "$p" != "/" ]; do
    rest="/${p##*/}$rest"
    p="${p%/*}"
    [ -n "$p" ] || p="/"
  done
  base="$(cd -P -- "$p" 2>/dev/null && pwd -P)" || base="$p"
  printf '%s%s\n' "$base" "$rest"
}

DEMO_HOME="${OMNI_DEMO_HOME:-$REPO/.demo-home}"
case "$DEMO_HOME" in
  "~")   DEMO_HOME="$HOME" ;;
  "~/"*) DEMO_HOME="$HOME/${DEMO_HOME#\~/}" ;;
esac
DEMO_HOME="$(abspath "$DEMO_HOME")"

# Safety rail (same rules as demo-home.sh), enforced on EVERY run — not only when the home is new.
refuse() { printf '[real-run] REFUSED: %s\n' "$*" >&2; exit 2; }
[ -n "${HOME:-}" ] || refuse "\$HOME is unset — cannot verify the ~/.hermes guard."
[ "$DEMO_HOME" = "$HOME/.hermes" ] && refuse "refusing to run in the real Hermes home: $DEMO_HOME"
case "$DEMO_HOME" in /.hermes|*/.hermes|*/.hermes/profiles/*) refuse "refusing a real Hermes home/profile: $DEMO_HOME" ;; esac
[ "$DEMO_HOME" = "/" ] && refuse "target resolves to /"
[ "$DEMO_HOME" = "$HOME" ] && refuse "target resolves to \$HOME"

DB="$DEMO_HOME/plugin-data/omniscience/events.db"
PROMPT='This is a scripted end-to-end smoke test. Do exactly these two things, nothing else: (1) use your terminal tool to run the single command `echo omniscience-e2e-parent` and report its output; (2) use the delegate_task tool to start exactly one subagent whose only job is to use its terminal tool to run `echo omniscience-e2e-child` and report what it printed. When both commands have run, write a one-line summary and stop.'

REQUIRED=(session.start turn.start llm.request llm.response tool.end subagent.start)

log()  { printf '[real-run] %s\n' "$*"; }
warn() { printf '[real-run] WARN: %s\n' "$*" >&2; }
hr()   { printf '%s\n' '----------------------------------------------------------------------'; }

# The demo home must exist. Create it if needed (idempotent, guarded).
if [ ! -f "$DEMO_HOME/config.yaml" ]; then
  log "demo home not ready — running demo-home.sh for $DEMO_HOME"
  if ! "$SCRIPT_DIR/demo-home.sh"; then
    warn "demo-home.sh failed; aborting before invoking hermes."
    exit 2
  fi
fi

if ! command -v hermes >/dev/null 2>&1; then
  warn "hermes binary not found on PATH — cannot perform a real run."
  warn "install Hermes or re-run from an environment that provides it."
  exit 127
fi

hermes_bin="$(command -v hermes)"
log "hermes      : $hermes_bin"
log "HERMES_HOME : $DEMO_HOME"
log "events.db   : $DB"
log "timeout     : 900s"
hr
log "launching: hermes -z \"<prompt>\""
hr

# Never delete data: remember the last rowid and summarise only rows this run adds.
BASE_ROWID=0
if [ -f "$DB" ]; then
  BASE_ROWID="$(python3 -c 'import sqlite3,sys; c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro",uri=True); print(c.execute("select coalesce(max(rowid),0) from events").fetchone()[0])' "$DB" 2>/dev/null || echo 0)"
fi
log "existing rows kept; summarising rows after rowid $BASE_ROWID"

HERMES_HOME="$DEMO_HOME" timeout 900 "$hermes_bin" -z "$PROMPT"
hermes_rc=$?
hr
if [ "$hermes_rc" -eq 124 ]; then
  warn "hermes timed out after 900s."
else
  log "hermes exited with status $hermes_rc"
fi

# -------------------------------------------------------------- DB summary
PY="${OMNI_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x "$REPO/.venv/bin/python" ]; then PY="$REPO/.venv/bin/python";
  elif command -v python3 >/dev/null 2>&1; then PY="$(command -v python3)";
  elif command -v python >/dev/null 2>&1; then PY="$(command -v python)";
  fi
fi

if [ -z "$PY" ]; then
  warn "no python interpreter found for the summary."
  exit 1
fi
if [ ! -f "$DB" ]; then
  warn "events DB was not created: $DB"
  warn "the omniscience plugin did not run (check gateway logs / the plugin symlink)."
  hr
  printf '[real-run] VERDICT: FAIL (no events database)\n'
  exit 1
fi

hr
log "events DB summary"
hr
"$PY" - "$DB" "$BASE_ROWID" "${REQUIRED[@]}" <<'PYEOF'
import sqlite3
import sys

db = sys.argv[1]
base = int(sys.argv[2])
required = sys.argv[3:]

try:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
except sqlite3.Error as exc:
    print(f"[real-run] could not open DB read-only: {exc}", file=sys.stderr)
    sys.exit(1)

cur = con.cursor()
try:
    cur.execute("SELECT 1 FROM events LIMIT 1")
except sqlite3.OperationalError as exc:
    print(f"[real-run] DB has no usable events table: {exc}", file=sys.stderr)
    print(f"[real-run] VERDICT: FAIL (schema missing)")
    sys.exit(1)

cur.execute("CREATE TEMP VIEW run AS SELECT * FROM main.events WHERE rowid > ?".replace("?", str(base)))
rows = cur.execute("SELECT kind, COUNT(*) FROM run GROUP BY kind ORDER BY kind").fetchall()
present = {}
print("counts per kind:")
if not rows:
    print("  (no events recorded)")
for kind, n in rows:
    present[kind] = n
    print(f"  {kind:<16} {n}")

total = cur.execute("SELECT COUNT(*) FROM run").fetchone()[0]
sessions = cur.execute(
    "SELECT session_id, COUNT(*), MIN(ts), MAX(ts) FROM run "
    "GROUP BY session_id ORDER BY MIN(ts)"
).fetchall()

print(f"\ndistinct sessions: {len(sessions)}  (total events: {total})")
for sid, n, first, last in sessions:
    span = (last - first) if (first is not None and last is not None) else 0.0
    print(f"  {sid}  events={n}  span={span:.2f}s")

children = cur.execute(
    "SELECT DISTINCT session_id, parent_session_id FROM run "
    "WHERE parent_session_id IS NOT NULL AND parent_session_id <> '' "
    "ORDER BY parent_session_id, session_id"
).fetchall()
roots = [sid for sid, _, _, _ in sessions
         if not any(sid == c for c, _ in children)]

print(f"\nchild sessions linked by parent_session_id: {len(children)}")
for child, parent in children:
    print(f"  {parent}  ->  {child}")
print(f"root sessions (no recorded parent): {len(roots)}")
for sid in roots:
    print(f"  {sid}")

missing = [k for k in required if present.get(k, 0) == 0]
child_ids = [r[0] for r in cur.execute(
    "SELECT DISTINCT json_extract(attrs, '$.child_session_id') FROM run WHERE kind='subagent.start'")]
child_tools = cur.execute(
    "SELECT COUNT(*) FROM run WHERE kind='tool.end' AND session_id IN (%s)" % ",".join("?" * len(child_ids)),
    child_ids).fetchone()[0] if child_ids else 0
print(f"tool calls inside helper-agent sessions: {child_tools}")
if child_tools == 0:
    missing.append("tool.end in a subagent session")
print()
print("required kinds:")
for k in required:
    mark = "ok" if present.get(k, 0) else "MISSING"
    print(f"  [{mark:<7}] {k}")

con.close()
if missing:
    print(f"\n[real-run] VERDICT: FAIL (missing kinds: {', '.join(missing)})")
    sys.exit(1)
print("\n[real-run] VERDICT: PASS (all required kinds present)")
sys.exit(0)
PYEOF
verdict_rc=$?

if [ "$verdict_rc" -ne 0 ]; then
  warn "verification failed (verdict_rc=$verdict_rc)."
  exit 1
fi
if [ "$hermes_rc" -ne 0 ]; then
  warn "hermes exited non-zero ($hermes_rc$( [ "$hermes_rc" -eq 124 ] && echo ', timeout')) — treating the run as FAILED."
  exit 1
fi
log "verification passed."
exit 0
