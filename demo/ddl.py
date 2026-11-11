"""Canonical events DB DDL (ARCHITECTURE.md §3).

Kept in one place so the synthetic generator and any local tooling create the
exact same schema. The viewer only ever reads this database.
"""

DDL = """
CREATE TABLE IF NOT EXISTS events (
    rowid INTEGER PRIMARY KEY,
    event_id TEXT UNIQUE,
    schema TEXT,
    boot_id TEXT,
    seq INTEGER,
    ts REAL,
    kind TEXT,
    session_id TEXT,
    parent_session_id TEXT NULL,
    turn_id TEXT NULL,
    api_request_id TEXT NULL,
    tool_call_id TEXT NULL,
    subagent_id TEXT NULL,
    status TEXT NULL,
    attrs TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session_rowid ON events(session_id, rowid);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_turn_id ON events(turn_id);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""
