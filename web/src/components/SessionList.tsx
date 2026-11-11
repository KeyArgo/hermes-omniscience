import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMeta } from '../types';
import {
  ACTIVE_WINDOW_S,
  RECENT_WINDOW_S,
  formatNumber,
  relativeTime,
  sessionOutcome,
  sessionStartLabel,
  shortModel, formatTokens } from '../graph/format';
import { SESSION_SORTS, type SessionSort, sortSessions, workingSessionId } from '../graph/sessions';
import { heatLevel, heatSentence } from '../graph/heat';
import { GROUP_MODES, groupSessions, type GroupMode } from '../graph/grouping';

const SORT_KEY = 'omni.sessionSort';
const GROUP_KEY = 'omni.sessionGroup';

function readGroup(): GroupMode {
  try {
    const stored = window.localStorage.getItem(GROUP_KEY);
    if (stored && GROUP_MODES.some((option) => option.value === stored)) return stored as GroupMode;
  } catch {
    /* storage unavailable */
  }
  // Days by default: the rail stops being readable once it holds a week of chats.
  return 'day';
}

function readSort(): SessionSort {
  try {
    const raw = window.localStorage.getItem(SORT_KEY);
    if (raw === 'recent' || raw === 'oldest' || raw === 'busiest') return raw;
  } catch {
    // ignore
  }
  return 'recent';
}

export interface SessionListProps {
  sessions: SessionMeta[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  /** Tokens view: mark each chat by how large a context it re-sends on every call. */
  heat?: boolean;
}

export function SessionList({
  sessions,
  selectedId,
  loading,
  error,
  onSelect,
  heat = false,
}: SessionListProps) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [source, setSource] = useState('all');
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<SessionSort>(readSort);
  const [groupMode, setGroupMode] = useState<GroupMode>(readGroup);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem('omni.sessionCollapsed');
      const parsed = stored ? (JSON.parse(stored) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
    } catch {
      return [];
    }
  });
  // Nothing stored yet: last hour and today open, everything older folded. A reader who folds or
  // unfolds anything from then on owns the setting; this only decides the first view.
  const choseFolding = useRef<boolean>((() => {
    try {
      return window.localStorage.getItem('omni.sessionCollapsed') !== null;
    } catch {
      return false;
    }
  })());
  // Recomputed as `now` ticks: a viewer left open past midnight must not keep calling yesterday
  // "Today" and fold the real one.
  const todayKey = useMemo(() => {
    const d = new Date(now * 1000);
    d.setHours(0, 0, 0, 0);
    return `d${d.getTime()}`;
  }, [now]);

  const listRef = useRef<HTMLUListElement | null>(null);
  const visibleSessions = sortSessions(
    sessions.filter((session) =>
      (showArchived || session.archived !== true) &&
      (source === 'all' || (source === 'other'
        ? !['local', 'cron', 'oneshot'].includes(session.source ?? '')
        : session.source === source)),
    ),
    sort,
  );
  // The chat the agent is working on right now. It keeps the list honest: the top row is
  // whichever chat last received an event, and that row is marked while it is still active.
  const groups = useMemo(() => groupSessions(visibleSessions, groupMode, now), [visibleSessions, groupMode, now]);
  // Last hour and today open; everything older folded — but the newest bucket always stays open, so a
  // reader whose last chat was yesterday never lands on a list that looks empty.
  const foldKey = (key: string): boolean => {
    if (collapsed.includes(key)) return true;
    if (choseFolding.current) return false;
    return key !== 'hour' && key !== todayKey && key !== (groups[0]?.key ?? '');
  };
  // Headings are rendered for folded groups too, otherwise folding a bucket would remove the only
  // control that could open it again.
  const entries = useMemo(
    () =>
      groups.flatMap((group) => {
        const rows = foldKey(group.key)
          ? []
          : group.sessions.map((session) => ({ kind: 'row' as const, session }));
        return group.label
          ? [{ kind: 'group' as const, group }, ...rows]
          : rows;
      }),
    [groups, collapsed],
  );

  const workingId = workingSessionId(visibleSessions, now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  function changeSort(next: SessionSort) {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_KEY, next);
    } catch {
      // ignore
    }
  }

  // Keep the working chat in sight even when the rail is scrolled or the list is long.
  useEffect(() => {
    if (!workingId || !listRef.current) return;
    const row = listRef.current.querySelector<HTMLElement>(`[data-session-id="${workingId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [workingId]);

  return (
    <div className="session-list">
      <div className="rail-head">
        <span>sessions</span>
        <span className="rail-count mono">{visibleSessions.length} / {sessions.length}</span>
      </div>

      <div className="session-filters">
        <label>Show{' '}
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">All activity</option>
            <option value="local">Local chats</option>
            <option value="cron">Scheduled jobs</option>
            <option value="oneshot">One-shot runs</option>
            <option value="other">Other / unknown</option>
          </select>
        </label>
        <label>Sort{' '}
          <select
            value={sort}
            onChange={(event) => changeSort(event.target.value as SessionSort)}
            title="Which chat is at the top of the list. Most recent keeps the chat being worked on first."
          >
            {SESSION_SORTS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>Group{' '}
          <select
            value={groupMode}
            onChange={(event) => {
              const next = event.target.value as GroupMode;
              setGroupMode(next);
              try {
                window.localStorage.setItem(GROUP_KEY, next);
              } catch {
                /* storage unavailable */
              }
            }}
            title="Fold chats into the day, week or month they were last active. Folding is remembered per bucket."
          >
            {GROUP_MODES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
      </div>
      {!loading && sessions.length > 0 && visibleSessions.length === 0 ? <p className="rail-muted">No conversations match these filters.</p> : null}

      {error ? (
        <div className="rail-error">
          <b>Viewer offline.</b> The map can’t reach the viewer, so there is nothing to see yet.
          Start it with:
          <code>python -m omniscience_viewer --db &lt;DB&gt;</code>
        </div>
      ) : null}

      {loading && sessions.length === 0 ? <div className="rail-muted">Loading…</div> : null}

      {!loading && sessions.length === 0 && !error ? (
        <div className="rail-empty">
          <p>The viewer found 0 conversations in its database.</p>
          <p>No conversations recorded yet. To get data in:</p>
          <ol>
            <li>
              Install the plugin:
              <code>hermes plugins install KeyArgo/hermes-omniscience</code>
            </li>
            <li>
              Enable and restart:
              <code>hermes plugins enable omniscience</code> then restart the gateway.
            </li>
            <li>
              No agent around? Try demo data:
              <code>python demo/synth.py demo.db</code> and start the viewer with{' '}
              <code>--db demo.db</code>.
            </li>
          </ol>
        </div>
      ) : null}

      <ul ref={listRef}>
        {entries.map((entry) => {
          if (entry.kind === 'group') {
            const group = entry.group;
            const folded = foldKey(group.key);
            return (
              <li className="rail-group" key={`g${group.key}`}>
                <button
                  type="button"
                  className="rail-group-head"
                  aria-expanded={!folded}
                  onClick={() => {
                    // Materialise the default first: the first click must act on what is on screen,
                    // not on an empty stored list that only mirrors it by coincidence.
                    const current = groups.map((g) => g.key).filter((key) => foldKey(key));
                    const changed = folded
                      ? current.filter((key) => key !== group.key)
                      : Array.from(new Set([...current, group.key]));
                    // Keep folds saved under the other groupings: the keys are mode-specific (d…, w…,
                    // m…), and replacing the whole list lost them whenever the mode changed.
                    const otherModes = collapsed.filter((key) => !groups.some((g) => g.key === key));
                    const next = Array.from(new Set([...otherModes, ...changed]));
                    choseFolding.current = true;
                    try {
                      window.localStorage.setItem('omni.sessionCollapsed', JSON.stringify(next));
                    } catch {
                      /* storage unavailable */
                    }
                    setCollapsed(next);
                  }}
                  title="Fold or unfold this date range."
                >
                  <span className="rail-group-caret">{folded ? '▸' : '▾'}</span>
                  {group.label}
                  <span className="rail-group-count mono">{group.sessions.length}</span>
                </button>
              </li>
            );
          }
          const session = entry.session;
          const start = sessionStartLabel(session.first_ts, now);
          const outcome = sessionOutcome(session.status);
          const model = shortModel(session.model);
          const eventCount =
            typeof session.events === 'number' && Number.isFinite(session.events)
              ? `${formatNumber(session.events)} ev`
              : 'not reported';
          const working = session.id === workingId;
          const ageS = typeof session.last_ts === 'number' ? now - session.last_ts : null;
          const activeNow = ageS !== null && ageS >= 0 && ageS <= ACTIVE_WINDOW_S;
          const recent = ageS !== null && ageS >= 0 && ageS <= RECENT_WINDOW_S;
          const contextNow = session.prompt_now && session.prompt_now > 0 ? session.prompt_now : session.prompt_max;
          const level = heatLevel(contextNow);
          const showHeat = heat && typeof contextNow === 'number' && contextNow > 0;
          return (
            <li key={session.id} data-session-id={session.id}>
              <button
                type="button"
                className={`session-item ${session.id === selectedId ? 'is-active' : ''} ${
                  activeNow ? 'is-live' : recent ? 'is-recent' : ''
                } ${working ? 'is-working' : ''}`}
                onClick={() => onSelect(session.id)}
                // Everything the row has no room for: the same numbers, in full, with labels.
                title={[
                  working ? `${session.label || session.id} — working now` : session.label || session.id,
                  `${outcome} · started ${start}`,
                  typeof session.last_ts === 'number'
                    ? `last activity ${relativeTime(session.last_ts, now)} (${new Date(session.last_ts * 1000).toLocaleString()})`
                    : 'no recorded time',
                  `model ${session.model ?? model}`,
                  `${session.events ?? 0} steps recorded`,
                  showHeat ? heatSentence(contextNow, session.prompt_max) : null,
                  `${session.calls ?? 0} model calls · ${session.tools ?? 0} tools · ${session.mcp_calls ?? 0} MCP · ${session.skills ?? 0} skill loads · ${session.aux_calls ?? 0} outside calls · ${session.subagents ?? 0} helpers`,
                  `${session.compactions ?? 0} compactions · context now ${formatTokens(session.prompt_now ?? 0)} · peak ${formatTokens(session.prompt_max ?? 0)}`,
                  `${formatTokens((session.cached ?? 0) + (session.fresh ?? 0))} tokens in · ${formatTokens(session.output ?? 0)} out`,
                ].filter(Boolean).join('\n')}
              >
                <span className="session-main">
                  <span className="session-title" title={session.label ?? session.id}>
                    {showHeat ? <span className={`heat-dot heat-${level}`} aria-hidden="true" /> : null}
                    {working || recent ? <span className={`live-dot${recent && !activeNow ? ' is-faint' : ''}`} title={working ? 'Working now' : activeNow ? 'Event in the last minute' : 'Event in the last 5 minutes'} aria-label={working ? 'Working now' : activeNow ? 'Event in the last minute' : 'Event in the last 5 minutes'} /> : null}
                    {session.label || `${start} · ${model}`}
                  </span>
                  <span className="session-sub">
                    <span className="session-start">{start}</span>
                    <span className="session-sep">·</span>
                    <span className="session-outcome">{outcome}</span>
                    <span className="session-sep">·</span>
                    <span className="session-model" title={session.model ?? undefined}>
                      {model}
                    </span>
                    {typeof session.last_ts === 'number' ? (
                      <>
                        <span className="session-sep">·</span>
                        <span
                          className="session-age"
                          title={`Last recorded activity: ${new Date(session.last_ts * 1000).toLocaleString()} (system clock)`}
                        >
                          {relativeTime(session.last_ts, now)}
                        </span>
                      </>
                    ) : null}
                  </span>
                </span>
                <span
                  className="session-meta mono"
                  title="Number of recorded steps, including helper agents (what the recorder kept)."
                >
                  {eventCount}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
