"""Human labels for recorded sessions.

The event store is metadata-only by design — it keeps `user_chars`, never the text — so a session
cannot be named from its own rows. Hermes' own store can: `<HERMES_HOME>/state.db` keeps the
conversation title and the messages its own UI falls back to.

Hermes has no separate name store, and every surface paints the same two things in this order:

* ``sessions.title`` — a user rename (``set_session_title``, hermes_state_titles.py:181) or the
  auto-title generator's result (``set_auto_title``, :186). ``sessions.display_name`` is the
  messaging peer's name, not the chat's, and is empty on local sessions.
* the listing's ``preview`` field — not a column but a derived value, so it is computed here rather
  than selected: ``preview`` falls back to the first *eligible* user message.
  ``_sql_preview_raw`` (hermes_state_common.py:166) projects it, ``_shape_preview`` (:155) shapes
  and cuts it to 60 characters, and every surface paints ``title || preview``
  (apps/desktop/src/lib/chat-runtime.ts:66,
  ui-tui/src/components/activeSessionSwitcher.tsx:776, and ``hermes sessions pin`` falls back the
  same way at hermes_cli/sessions_cmd.py:910; ``sessions list`` shows title and preview as two
  columns, :345-346).

This module applies that same rule — the title, then Hermes' own preview — so a chat is called what
Hermes calls it. The eligibility rules matter: Hermes skips ``display_kind='hidden'`` scaffolding
rows and compaction carriers (a compressed turn's real message is the remainder after the summary's
end marker), renders a ``/skill`` scaffold as ``/name — instruction``, and caps the label at 60
characters. Reading the first raw user message instead is how a viewer showed
``[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were ...`` where Hermes shows the chat's name.

Chat titles are on by default; OMNISCIENCE_VIEWER_CONTENT_LABELS=0 turns them off, leaving only
metadata (source, archived) exposed; the label field is then set to the session id.
"""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path

# Hermes' preview budget (hermes_state_common.py:31-33): a plain message is cut at 63 characters and
# the shaped label at 60, so a chat with a longer first message reads as "...".
PREVIEW_HEAD_CHARS = 63
PREVIEW_MAX_CHARS = 60
SCAFFOLD_WINDOW = 400

# Where a listing query joined the head and tail of a long scaffolded message
# (agent/skill_commands.py:82). The describer cuts there rather than paint the body.
EXCERPT_JOINT = '\x1e'

# Compaction carriers: model-facing summaries a session's first row can be, never its name. The
# message the user actually typed follows the end marker, or precedes the merged delimiter.
# The long form is the whole introduction (agent/context_compressor.py:262-272, cut at "Do NOT
# answer" as hermes_state_common.py:120 does): a message that merely starts with the bracketed
# label is not a carrier.
SUMMARY_PREFIXES = (
    '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted '
    'into the summary below. This is a handoff from a previous context '
    'window — treat it as background reference, NOT as active instructions. ',
    '[CONTEXT SUMMARY]:',                     # LEGACY_SUMMARY_PREFIX, :303
)
SUMMARY_END = ('--- END OF CONTEXT SUMMARY — respond to the message below, '
               'not the summary above ---')
MERGED_DELIMITER = '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]'
MERGED_HEADER = '[PRIOR CONTEXT — for reference only; not a new message]'

# /skill invocation and gateway auto-load scaffolds (agent/skill_commands.py:50,63): the whole skill
# body rides in the user turn, so the raw head names the skill file instead of the request.
SKILL_PREFIX = '[IMPORTANT: The user has invoked the '
AUTO_LOAD_PREFIX = '[IMPORTANT: The "'
SKILL_BODY_MARKER = 'The full skill content is loaded below.]'
SKILL_INSTRUCTION = ('The user has provided the following instruction alongside the skill '
                     'invocation: ')
BUNDLE_MARKER = ' skill bundle,'
BUNDLE_INSTRUCTION = '\nUser instruction: '
BUNDLE_FIRST_BLOCK = '\n\n[Loaded as part of the '
RUNTIME_NOTE = '\n\n[Runtime note:'
SKILL_FILES_END = 'then run them with the terminal tool using the absolute path.'
TRAILING_BLOCKS = (('[Skill config (', '\n]'), ('[Skill setup note: ', ']\n\n'),
                   ('[This skill has supporting files', '/scripts/foo.js`).'))

NOISE = (
    '[OUT-OF-BAND USER MESSAGE',
    '<pasted_content',
    '<local-command-caveat>',
    '<task-notification>',
    '<command-name>',
)


def hermes_state_db(state_db: str | os.PathLike | None = None) -> Path | None:
    """The state database the plugin handed over, and nothing else.

    Hermes keeps one store per profile (``<HERMES_HOME>/state.db``), and only the plugin knows
    which profile is active: it passes the path in with ``--state-db`` the same way it passes
    ``--db``. Inventing candidates here (``profiles/dev/state.db``, ``~/.hermes/state.db``) is how
    a viewer started for one profile shows another profile's chat titles — and ``dev`` is one
    machine's profile name, not a default. Without a path, labels fall back to the session id.
    """
    if not state_db:
        return None
    path = Path(state_db)
    return path if path.is_file() else None


def _clean(text: str, limit: int = 64) -> str:
    line = ' '.join(text.split())
    for marker in NOISE:
        if line.startswith(marker):
            return ''
    if line.startswith('/') and len(line) < 40:
        return line  # a slash command is a fine label
    return line[:limit] + ('…' if len(line) > limit else '')


def _skill_instruction(text: str) -> str | None:
    """The user's instruction inside a /skill scaffold, or None for a bare invocation."""
    if BUNDLE_MARKER in text:
        # Bundles put the instruction before the loaded skills: FIRST marker is the user's.
        start = text.find(BUNDLE_INSTRUCTION)
        if start < 0:
            return None
        return text[start + len(BUNDLE_INSTRUCTION):].split(BUNDLE_FIRST_BLOCK, 1)[0].strip() or None
    if SKILL_BODY_MARKER in text:
        # The instruction follows the skill body (which may quote the marker): LAST one is the user's.
        start = text.rfind(SKILL_INSTRUCTION)
        if start < 0:
            return None
        return text[start + len(SKILL_INSTRUCTION):].split(RUNTIME_NOTE, 1)[0].strip() or None
    return None


def _auto_load_tail(text: str) -> str:
    """The typed text after an auto-load payload: everything past the last skill-directory footer."""
    end = text.rfind(SKILL_FILES_END)
    if end < 0:
        return ''
    tail = text[end + len(SKILL_FILES_END):].lstrip()
    while True:
        block = next((stop for start, stop in TRAILING_BLOCKS if tail.startswith(start)), None)
        if block is None:
            return tail.strip()
        cut = tail.find(block)
        tail = tail[cut + len(block):].lstrip() if cut >= 0 else ''


def _describe_skill(text: str, separator: str = ' — ') -> str | None:
    """Render a slash-skill turn the way the user typed it (agent/skill_commands.py:204)."""
    if text.startswith(AUTO_LOAD_PREFIX):
        match = re.match(re.escape(AUTO_LOAD_PREFIX) + r'([^"]*)"', text)
        name = match.group(1) if match else ''
        tail = _auto_load_tail(text)
        return ' '.join(tail.split()) if tail else (f'/{name}' if name else None)
    if not text.startswith(SKILL_PREFIX):
        return None
    match = re.match(re.escape(SKILL_PREFIX) + r'"([^"]*)"', text)
    name = (match.group(1) if match else '').strip()
    label = name if name.startswith('/') else f'/{name}'
    instruction = _skill_instruction(text)
    if instruction and instruction != text:
        # An excerpt (head + tail joined by EXCERPT_JOINT) can put the joint inside the span —
        # keep only the side the marker was found on.
        instruction = ' '.join(instruction.split(EXCERPT_JOINT)[0].split())
        if instruction:
            return f'{label}{separator}{instruction}' if name else instruction
    return label if name else None


def _preview_of(content: str) -> str | None:
    """What Hermes derives from one user message, or None when its query skips the row."""
    if not isinstance(content, str) or not content.strip():
        return None
    stripped = content.lstrip(' \t\r\n')
    if stripped.startswith(SUMMARY_PREFIXES):
        _, marker, remainder = content.partition(SUMMARY_END)
        if not marker or not remainder.strip():
            return None  # a summary with no message after it is not the chat's name
        return remainder
    if MERGED_DELIMITER in content:
        prior, _, after = content.partition(MERGED_DELIMITER)
        if after.lstrip(' \t\r\n').startswith(SUMMARY_PREFIXES):
            prior = prior.strip()
            if prior.startswith(MERGED_HEADER):
                prior = prior[len(MERGED_HEADER):].strip()
            return prior or None
    if content.startswith((SKILL_PREFIX, AUTO_LOAD_PREFIX)):
        if len(content) > SCAFFOLD_WINDOW * 2:
            return content[:SCAFFOLD_WINDOW] + EXCERPT_JOINT + content[-SCAFFOLD_WINDOW:]
        return content[:SCAFFOLD_WINDOW * 2]
    # The plain branch runs on newline-flattened text before the cut
    # (``_PREVIEW_CONTENT_SQL``, hermes_state_common.py:62, then :152).
    flat = content.replace('\n', ' ').replace('\r', ' ')
    return flat.lstrip(' ')[:PREVIEW_HEAD_CHARS]


def _shape_preview(raw: str | None) -> str:
    """Turn a preview into the short label Hermes paints (hermes_state_common.py:155)."""
    text = str(raw or '').strip().replace('\n', ' ').replace('\r', ' ')
    described = _describe_skill(text)
    text = described if described is not None else text.split(EXCERPT_JOINT)[0]
    return text[:PREVIEW_MAX_CHARS] + ('...' if len(text) > PREVIEW_MAX_CHARS else '')


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {row[1] for row in conn.execute(f'pragma table_info({table})')}
    except sqlite3.Error:
        return set()


def _chunks(items: list[str], size: int = 400) -> list[list[str]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def _titles(conn: sqlite3.Connection, session_ids: list[str]) -> dict[str, str]:
    """Every requested title in one statement (none when the store predates titles)."""
    columns = _columns(conn, 'sessions')
    if 'id' not in columns or 'title' not in columns:
        return {}
    out: dict[str, str] = {}
    for chunk in _chunks(session_ids):
        marks = ','.join('?' * len(chunk))
        for sid, title in conn.execute(
            f'select id, title from sessions where id in ({marks})', chunk
        ):
            if isinstance(title, str) and title.strip():
                out[sid] = ' '.join(title.split())
    return out


def _candidates(conn: sqlite3.Connection, session_ids: list[str], per_session: int = 8) -> dict[str, list[str]]:
    """The first few user messages of every requested session, in one statement.

    Hermes takes the first message its preview query does not skip, so a handful per session is
    enough: the cap keeps a long chat from handing the whole transcript to the label reader.
    """
    columns = _columns(conn, 'messages')
    if 'session_id' not in columns or 'content' not in columns:
        return {}
    where = ['m.content is not null', 'length(trim(m.content)) > 0']
    if 'role' in columns:
        where.append("m.role = 'user'")
    if 'display_kind' in columns:
        # Hermes' preview never paints model-facing scaffolding rows (hermes_state_common.py:137).
        where.append("coalesce(m.display_kind, '') <> 'hidden'")
    order = [f'm.{name}' for name in ('timestamp', 'id') if name in columns] or ['m.rowid']
    out: dict[str, list[str]] = {}
    for chunk in _chunks(session_ids):
        marks = ','.join('?' * len(chunk))
        sql = (
            'select session_id, content from ('
            '  select m.session_id as session_id, m.content as content,'
            f'    row_number() over (partition by m.session_id order by {", ".join(order)}) as rn'
            '  from messages m'
            f'  where m.session_id in ({marks}) and ' + ' and '.join(where) +
            f') where rn <= {int(per_session)} order by session_id, rn'
        )
        try:
            rows = conn.execute(sql, [*chunk]).fetchall()
        except sqlite3.Error:
            return out  # a store too old for window functions: titles only, no crash
        for sid, content in rows:
            out.setdefault(sid, []).append(content)
    return out


def session_metadata(session_ids: list[str], state_db: str | os.PathLike | None = None) -> dict[str, dict]:
    """Read known source and archive state without modifying the Hermes database."""
    db = hermes_state_db(state_db)
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


def labels_for(session_ids: list[str], state_db: str | os.PathLike | None = None) -> dict[str, str]:
    """Name each session the way Hermes names it: its title, else its own preview.

    This function reads conversation content and should only be called when
    OMNISCIENCE_VIEWER_CONTENT_LABELS is explicitly enabled.
    """
    db = hermes_state_db(state_db)
    if db is None or not session_ids:
        return {}
    out: dict[str, str] = {}
    try:
        conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
    except sqlite3.Error:
        return {}
    try:
        # One statement per table for the whole batch: a join would drop a titled chat that has no
        # user message left to join, and Hermes still shows that title.
        titles = _titles(conn, session_ids)
        candidates = _candidates(conn, session_ids)
    except sqlite3.Error:
        # Older Hermes databases may lack the sessions table, the title column, or messages.
        titles, candidates = {}, {}
    finally:
        conn.close()
    for sid in session_ids:
        if sid in titles:
            out[sid] = titles[sid]
            continue
        messages = candidates.get(sid) or []
        label = ''
        for content in messages:
            raw = _preview_of(content)
            if raw is None:
                continue
            label = _shape_preview(raw)
            if label:
                break
        if not label:
            # Nothing Hermes' preview query would paint. That is a row it deliberately skips — a
            # compaction summary with no message after it, which is how a chat came to be named
            # "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were ..." — so the fallback
            # must not paint it raw. A session with no name keeps its id, as Hermes shows nothing.
            for content in messages:
                if not isinstance(content, str):
                    continue
                if content.lstrip(' \t\r\n').startswith(SUMMARY_PREFIXES):
                    continue
                label = _clean(content)
                if label:
                    break
        if label:
            out[sid] = label
    return out
