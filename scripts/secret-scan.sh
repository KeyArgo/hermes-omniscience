#!/usr/bin/env bash
#
# secret-scan.sh — last-line safety net for the omniscience events DB.
#
# The plugin sanitizes with an allowlist + redactor (docs/SECURITY.md), so an
# events.db should carry only IDs, timings, model/provider names, token COUNTS,
# statuses, tool names, argument NAMES and character/byte counts. This script
# treats the events.db as opaque bytes (via `strings`/grep) and greps for the
# secret shapes SECURITY.md promises to have redacted. If any survive, it prints
# them (masked) and exits 1 so an e2e gate can fail loudly.
#
# Usage: secret-scan.sh [path/to/events.db]
#   no arg -> ${OMNI_DEMO_HOME:-<repo>/.demo-home}/plugin-data/omniscience/events.db
#
# Exit codes: 0 clean | 1 secret-shaped content found | 2 usage / file missing.
#
# Why these patterns and not literal "long hex" matching: opaque correlation ids
# (event_id, session_id "local-<64hex>", turn/api ids, call_<hex>) are legitimately
# long hex and WILL appear in every DB. SECURITY.md's redactor targets long
# hex/base64 runs inside the *free-text* fields it keeps (error_message, reason),
# not the opaque ids — so a raw byte-scan flags high-signal secret FORMATS plus
# base64 (which contains + / or = that opaque hex ids never do), and deliberately
# does NOT flag bare hex so it stays usable as a real gate.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

db="${1:-}"
if [ -z "$db" ]; then
  dh="${OMNI_DEMO_HOME:-$REPO/.demo-home}"
  case "$dh" in "~") dh="$HOME";; "~/"*) dh="$HOME/${dh#\~/}";; esac
  dh="$(readlink -m -- "$dh")"
  db="$dh/plugin-data/omniscience/events.db"
fi

if [ ! -e "$db" ]; then
  printf '[secret-scan] ERROR: not found: %s\n' "$db" >&2
  exit 2
fi
if [ -d "$db" ]; then
  printf '[secret-scan] ERROR: expected a file, got a directory: %s\n' "$db" >&2
  exit 2
fi

# Read as bytes: prefer `strings`, fall back to grep -a on the raw file.
# Scan the DB and its WAL/SHM sidecars: un-checkpointed rows live in -wal.
corpus=""
for f in "$db" "$db-wal" "$db-shm"; do
  [ -f "$f" ] || continue
  if command -v strings >/dev/null 2>&1; then
    corpus+="$(LC_ALL=C strings -n 6 -- "$f" || true)"$'\n'
  else
    corpus+="$(LC_ALL=C grep -a '' -- "$f" || true)"$'\n'
  fi
done

# "desc|ERE" — one per line, patterns transcribed from docs/SECURITY.md.
PATTERNS=(
  'OpenAI-style API key (sk-...)|sk-[A-Za-z0-9_-]{20,}'
  'GitHub token (gh[pousr]_...)|\bgh[pousr]_[A-Za-z0-9]{36}\b'
  'GitHub fine-grained token|\bgithub_pat_[A-Za-z0-9_]{20,}'
  'AWS access key id (AKIA...)|\bAKIA[0-9A-Z]{16}\b'
  'Google API key (AIza...)|\bAIza[0-9A-Za-z_-]{35}\b'
  'Slack token (xox...)|\bxox[baprs]-[A-Za-z0-9-]{10,}\b'
  'Private key block|-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'Bearer / Basic auth value|(bearer|basic)[[:space:]]*[:=]?[[:space:]]*[A-Za-z0-9._~+/-]{20,}'
  'Secret-like key=value assignment|\b(password|passwd|secret|api[_-]?key|token|bearer|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?token|cookie|authorization)\b["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[^[:space:]",}]{6,}'
  'Base64 blob with + or / (opaque ids are hex, have neither)|[A-Za-z0-9+/]{20,}[+/][A-Za-z0-9+/]{4,}={0,2}'
  'URL credential in authority (user:pass@host)|[A-Za-z][A-Za-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]]+@'
  'URL query with secret parameter|[?&](api[_-]?key|access[_-]?token|token|password|secret|signature|sig|auth)([a-z0-9_-]*)='
)

mask() {
  # keep a hint of the shape, never echo the whole secret back
  local m="$1" n=${#1}
  if [ "$n" -le 12 ]; then
    printf '%s…(%d)' "$m" "$n"
  else
    printf '%s…%s(%d)' "${m:0:6}" "${m: -4}" "$n"
  fi
}

hits=0
found_lines=""
for entry in "${PATTERNS[@]}"; do
  desc="${entry%%|*}"
  ere="${entry#*|}"
  matches="$(printf '%s\n' "$corpus" | LC_ALL=C grep -aoEi -- "$ere" 2>/dev/null | LC_ALL=C sort -u | head -n 20 || true)"
  if [ -n "$matches" ]; then
    hits=$((hits + 1))
    printf '[secret-scan] HIT: %s\n' "$desc"
    while IFS= read -r m; do
      [ -n "$m" ] && printf '            - %s\n' "$(mask "$m")"
    done <<< "$matches"
    found_lines="${found_lines}${desc}\n"
  fi
done

printf '[secret-scan] scanned : %s\n' "$db"
if [ "$hits" -gt 0 ]; then
  printf '[secret-scan] VERDICT: FAIL — %d secret-shaped pattern(s) found. Do not ship this DB.\n' "$hits" >&2
  exit 1
fi
printf '[secret-scan] VERDICT: PASS — no secret-shaped content found.\n'
exit 0
