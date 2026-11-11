"""Human labels for recorded sessions.

The event store is metadata-only by design — it keeps `user_chars`, never the text — so a session
cannot be named from its own rows. Hermes' own store can: `<HERMES_HOME>/state.db` keeps every
message and the conversation title. Prefer the title, falling back to the first user message.

Chat titles are on by default; OMNISCIENCE_VIEWER_CONTENT_LABELS=0 turns them off, leaving only metadata
(source, archived) is exposed; the label field is set to the session id.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

NOISE = (
    '[OUT-OF-BAND USER MESSAGE',
    '<pasted_content',
    '<local-command-caveat>',
    '<task-notification>',
    '<command-name>',
)


def hermes_state_db() -> Path | None:
    home = os.environ.get('HERMES_HOME')
    candidates = []
    if home:
        candidates.append(Path(home) / 'state.db')
        candidates.append(Path(home) / 'profiles' / 'dev' / 'state.db')
    candidates.append(Path.home() / '.hermes' / 'profiles' / 'dev' / 'state.db')
    candidates.append(Path.home() / '.hermes' / 'state.db')
    for c in candidates:
        if c.is_file():
            return c
    return None


def _clean(text: str, limit: int = 64) -> str:
    line = ' '.join(text.split())
    for marker in NOISE:
        if line.startswith(marker):
            return ''
    if line.startswith('/') and len(line) < 40:
        return line  # a slash command is a fine label
    return line[:limit] + ('…' if len(line) > limit else '')


def session_metadata(session_ids: list[str]) -> dict[str, dict]:
    """Read known source and archive state without modifying the Hermes database."""
    db = hermes_state_db()
    if db is None or not session_ids:
        return {}
    try:
        conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
    except sqlite3.Error:
        return {}
    result = {}
    try:
        columns = {row[1] for row in conn.execute('pragma table_info(sessions)')}
        if 'id' not in columns:
            return {}
        source_col = 'source' if 'source' in columns else 'NULL'
        archive_col = 'archived' if 'archived' in columns else 'NULL'
        for sid in session_ids:
            row = conn.execute(f'select {source_col}, {archive_col} from sessions where id=?', (sid,)).fetchone()
            if row:
                result[sid] = {'source': row[0], 'archived': bool(row[1]) if row[1] is not None else None}
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    return result


def labels_for(session_ids: list[str]) -> dict[str, str]:
    """Return Hermes titles when present, otherwise the first usable user line.

    This function reads conversation content and should only be called when
    OMNISCIENCE_VIEWER_CONTENT_LABELS is explicitly enabled.
    """
    db = hermes_state_db()
    if db is None or not session_ids:
        return {}
    out: dict[str, str] = {}
    try:
        conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
    except sqlite3.Error:
        return {}
    try:
        for sid in session_ids:
            try:
                title_row = conn.execute('select title from sessions where id=?', (sid,)).fetchone()
                if title_row and isinstance(title_row[0], str) and title_row[0].strip():
                    out[sid] = ' '.join(title_row[0].split())
                    continue
            except sqlite3.Error:
                # Older Hermes databases may not have the sessions table or title column.
                pass
            try:
                row = conn.execute(
                    "select content from messages where session_id=? and role='user' "
                    "and content is not null and length(trim(content))>0 "
                    "order by timestamp asc limit 5",
                    (sid,),
                ).fetchall()
            except sqlite3.Error:
                continue
            for (content,) in row:
                label = _clean(content or '')
                if label:
                    out[sid] = label
                    break
    finally:
        conn.close()
    return out
