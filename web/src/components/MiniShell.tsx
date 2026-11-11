import React, { useCallback, useRef } from 'react';
import type { SessionMeta } from '../types';
import './MiniShell.css';

export type MiniView = 'live' | 'context' | 'tools' | 'tokens' | 'time';

export function sessionsNewestFirst(list: SessionMeta[]): SessionMeta[] {
  const withTs: Array<{ item: SessionMeta; ts: number; idx: number }> = [];
  const withoutTs: Array<{ item: SessionMeta; idx: number }> = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const ts = s.last_ts;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      withTs.push({ item: s, ts, idx: i });
    } else {
      withoutTs.push({ item: s, idx: i });
    }
  }
  withTs.sort((a, b) => b.ts - a.ts || a.idx - b.idx);
  withoutTs.sort((a, b) => a.idx - b.idx);
  const out: SessionMeta[] = [];
  for (const e of withTs) out.push(e.item);
  for (const e of withoutTs) out.push(e.item);
  return out;
}

const VIEWS: ReadonlyArray<{ id: MiniView; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'context', label: 'Context' },
  { id: 'tools', label: 'Tools' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'time', label: 'Time' },
];

function shortId(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 10) + '…';
}

function sessionLabel(s: SessionMeta, nowTs: number): string {
  const base = s.label && s.label.length > 0 ? s.label : shortId(s.id);
  const ts = s.last_ts;
  const live =
    typeof ts === 'number' &&
    Number.isFinite(ts) &&
    nowTs - ts >= 0 &&
    nowTs - ts <= 60_000;
  return (live ? '● ' : '') + base;
}

export function MiniShell(props: {
  sessions: SessionMeta[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  view: MiniView;
  onView: (v: MiniView) => void;
  nowTs: number;
  children: React.ReactNode;
}): JSX.Element {
  const { sessions, selectedId, onSelectSession, view, onView, nowTs, children } =
    props;

  const ordered = React.useMemo(() => sessionsNewestFirst(sessions), [sessions]);

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const setTabRef = useCallback((i: number, el: HTMLButtonElement | null) => {
    tabRefs.current[i] = el;
  }, []);

  const focusTab = useCallback((i: number) => {
    const el = tabRefs.current[i];
    if (el) el.focus();
  }, []);

  const onTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
      const n = VIEWS.length;
      let next: number | null = null;
      if (e.key === 'ArrowRight') next = (idx + 1) % n;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + n) % n;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = n - 1;
      if (next !== null) {
        e.preventDefault();
        focusTab(next);
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onView(VIEWS[idx].id);
      }
    },
    [onView, focusTab],
  );

  return (
    <div className="ms-root">
      <div className="ms-head">
        <select
          className="ms-select"
          value={selectedId ?? ''}
          onChange={(e) => onSelectSession(e.target.value)}
          aria-label="Chat"
        >
          {selectedId !== null && !ordered.some((s) => s.id === selectedId) ? (
            <option value={selectedId}>{shortId(selectedId)}</option>
          ) : null}
          {ordered.map((s) => (
            <option key={s.id} value={s.id}>
              {sessionLabel(s, nowTs)}
            </option>
          ))}
        </select>
      </div>

      <div className="ms-tabs" role="tablist" aria-label="Mini views">
        {VIEWS.map((v, i) => {
          const active = v.id === view;
          return (
            <button
              key={v.id}
              ref={(el) => setTabRef(i, el)}
              type="button"
              role="tab"
              id={'ms-tab-' + v.id}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={'ms-tab' + (active ? ' is-active' : '')}
              onClick={() => onView(v.id)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
            >
              {v.label}
            </button>
          );
        })}
      </div>

      <div className="ms-body">{children}</div>
    </div>
  );
}

export default MiniShell;
