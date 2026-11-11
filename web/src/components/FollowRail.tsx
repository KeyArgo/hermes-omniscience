import { useEffect, useMemo, useState } from "react";
import type { OmniEvent } from "../types";
import {
  DEFAULT_WATCHERS,
  WATCHER_PRESETS,
  buildWatchReport,
  watchCandidates,
  watcherLabel,
  type Watcher,
  type WatcherKind,
  type WatchResult,
} from "../graph/follow";
import { buildTokenReport } from "../graph/tokens";
import { advisePressure } from "../graph/pressure";
import { Tip } from "./Tip";
import "./FollowRail.css";

const STORAGE_KEY = "omni.follow";

function readWatchers(): Watcher[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const clean: Watcher[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const kind = (item as Watcher).kind;
      if (typeof kind !== "string") continue;
      const id = typeof (item as Watcher).id === "string" ? (item as Watcher).id : kind;
      const target = typeof (item as Watcher).target === "string" ? (item as Watcher).target : undefined;
      const threshold = typeof (item as Watcher).threshold === "number" ? (item as Watcher).threshold : undefined;
      clean.push({ id, kind: kind as WatcherKind, target, threshold });
    }
    return clean;
  } catch {
    return null;
  }
}

function writeWatchers(watchers: Watcher[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(watchers));
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}

function clock(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function Spark({ counts, tone }: { counts: number[]; tone: WatchResult["tone"] }) {
  const max = counts.reduce((m, c) => Math.max(m, c), 1);
  return (
    <span className={`fr-spark fr-spark-${tone}`} aria-hidden="true">
      {counts.map((count, i) => (
        <span
          key={i}
          className="fr-spark-bar"
          style={{ height: `${Math.max(1, Math.round((count / max) * 14))}px`, opacity: count === 0 ? 0.22 : 1 }}
        />
      ))}
    </span>
  );
}

function Row({
  result,
  onSelectEvent,
}: {
  result: WatchResult;
  onSelectEvent: (eventId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasHits = result.hits.length > 0;

  return (
    <div className={`fr-row fr-${result.tone}`}>
      <div className="fr-row-head">
        <span className={`fr-dot fr-dot-${result.tone}`} />
        <Tip text={result.tip} side="left" wide>
          <button
            type="button"
            className="fr-label"
            onClick={() => {
              if (!hasHits) return;
              if (open) setOpen(false);
              else if (result.hits.length === 1) onSelectEvent(result.hits[0].eventId);
              else setOpen(true);
            }}
            aria-expanded={hasHits ? open : undefined}
            disabled={!hasHits}
          >
            {result.label}
          </button>
        </Tip>
        <span className="fr-summary">{result.summary}</span>
      </div>
      <Spark counts={result.spark} tone={result.tone} />
      {hasHits ? (
        <button
          type="button"
          className="fr-last"
          onClick={() => onSelectEvent(result.lastEventId ?? result.hits[result.hits.length - 1].eventId)}
          title="Jump to the most recent one"
        >
          {clock(result.lastAt)} · {result.hits[result.hits.length - 1].text}
        </button>
      ) : result.watcher.kind === "fresh_tokens" ? (
        <span className="fr-last fr-last-empty">total for this chat</span>
      ) : (
        <span className="fr-last fr-last-empty">nothing found</span>
      )}
      {open && hasHits ? (
        <ul className="fr-hits">
          {result.hits.slice(-6).map((hit, i) => (
            <li key={`${hit.eventId}-${i}`}>
              <button type="button" onClick={() => onSelectEvent(hit.eventId)}>
                <span className="fr-hit-time">{clock(hit.at)}</span>
                <span>{hit.text}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The follow frame: a narrow rail that tracks only what the user asked for.
 *
 * It never shows a whole recording — one row per watched thing, for the chat you
 * are looking at, so a 300px column stays scannable.
 */
export function FollowRail({
  events,
  rootSessionId,
  onSelectEvent,
}: {
  events: OmniEvent[];
  rootSessionId: string | null;
  onSelectEvent: (eventId: string) => void;
}) {
  const [watchers, setWatchers] = useState<Watcher[]>(() => readWatchers() ?? DEFAULT_WATCHERS);
  const [editing, setEditing] = useState(false);
  const [newTarget, setNewTarget] = useState("");

  useEffect(() => {
    writeWatchers(watchers);
  }, [watchers]);

  const pressure = useMemo(
    () => advisePressure(buildTokenReport(events, rootSessionId).calls),
    [events, rootSessionId]
  );

  const candidates = useMemo(() => watchCandidates(events, watchers).slice(0, 10), [events, watchers]);

  const results = useMemo(() => {
    const report = buildWatchReport(events, watchers);
    // Things that actually happened come first, newest first; quiet watchers sink
    // to the bottom without disappearing, so "nothing found" is still visible.
    return [...report].sort((a, b) => {
      const aQuiet = a.count === 0 ? 1 : 0;
      const bQuiet = b.count === 0 ? 1 : 0;
      if (aQuiet !== bQuiet) return aQuiet - bQuiet;
      return (b.lastAt ?? 0) - (a.lastAt ?? 0);
    });
  }, [events, watchers]);

  const add = (watcher: Watcher) => {
    setWatchers((current) => (current.some((w) => w.id === watcher.id) ? current : [...current, watcher]));
  };

  const addTarget = (kind: "tool" | "skill") => {
    const target = newTarget.trim();
    if (!target) return;
    add({ id: `${kind}:${target}`, kind, target });
    setNewTarget("");
  };

  return (
    <section className="fr-root" aria-label="Follow">
      <div className="fr-head">
        <span className="fr-title">Watching</span>
        <span className="fr-chat" title={rootSessionId ?? "no chat"}>
          {rootSessionId ? "this chat" : "no chat"}
        </span>
        <button
          type="button"
          className={`fr-edit${editing ? " is-on" : ""}`}
          onClick={() => setEditing((value) => !value)}
          aria-pressed={editing}
          title="Choose what to follow"
        >
          {editing ? "done" : "edit"}
        </button>
      </div>

      {watchers.length === 0 && !editing ? (
        <p className="fr-empty">Nothing followed yet. Press edit to pick what to watch.</p>
      ) : null}

      <button
        type="button"
        className={`fr-pressure is-${pressure.level}`}
        onClick={() => {
          const newest = [...events]
            .filter((event) => event.kind === "llm.response")
            .sort((a, b) => a.ts - b.ts)
            .pop();
          if (newest) onSelectEvent(newest.event_id);
        }}
        title="What this chat costs to keep talking to, and whether compacting would help"
      >
        <span className="fr-pressure-label">
          cost per message{pressure.level === "compact" ? " · compact this chat" : ""}
        </span>
        <span className="fr-pressure-line">{pressure.headline}</span>
        {pressure.level !== "ok" ? (
          <span className="fr-pressure-hint">
            {pressure.projectedSavePct}% of that would go away after compacting.
          </span>
        ) : (
          <span className="fr-pressure-hint">Nothing to do yet.</span>
        )}
      </button>

      <div className="fr-list" key={rootSessionId ?? "none"}>
        {results.map((result) => (
          <Row key={result.watcher.id} result={result} onSelectEvent={onSelectEvent} />
        ))}
      </div>

      {editing ? (
        <div className="fr-editor">
          <p className="fr-editor-hint">
            Watched things apply to whichever chat you open. Nothing is recorded or sent anywhere.
          </p>
          <ul className="fr-presets">
            {WATCHER_PRESETS.filter((p) => !p.needsTarget).map((preset) => {
              const id = preset.threshold ? `${preset.kind}:${preset.threshold}` : preset.kind;
              const on = watchers.some((w) => w.id === id);
              return (
                <li key={preset.kind}>
                  <label>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        if (e.target.checked) {
                          add({
                            id,
                            kind: preset.kind,
                            threshold: preset.threshold,
                          });
                        } else {
                          setWatchers((current) => current.filter((w) => !(w.kind === preset.kind && !w.target)));
                        }
                      }}
                    />
                    <span>{preset.label}</span>
                  </label>
                </li>
              );
            })}
          </ul>

          {candidates.length > 0 ? (
            <div className="fr-pick">
              <p className="fr-pick-head">In this chat</p>
              <ul>
                {candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() =>
                        add({
                          id: candidate.id,
                          kind: candidate.kind,
                          target: candidate.target,
                        })
                      }
                      title={`Watch ${candidate.label} in every chat you open`}
                    >
                      <span className="fr-pick-plus" aria-hidden="true">
                        +
                      </span>
                      <span className="fr-pick-name">{candidate.label}</span>
                      <span className="fr-pick-kind">
                        {candidate.kind === "mcp" ? "mcp" : candidate.kind}
                      </span>
                      <span className="fr-pick-count">{candidate.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="fr-add">
            <input
              type="text"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTarget("tool");
              }}
              placeholder="tool or skill name"
              aria-label="Tool or skill name to follow"
            />
            <button type="button" onClick={() => addTarget("tool")}>
              + tool
            </button>
            <button type="button" onClick={() => addTarget("skill")}>
              + skill
            </button>
          </div>

          {watchers.some((w) => w.target) ? (
            <ul className="fr-targets">
              {watchers
                .filter((w) => w.target)
                .map((w) => (
                  <li key={w.id}>
                    <span>{watcherLabel(w)}</span>
                    <button
                      type="button"
                      onClick={() => setWatchers((current) => current.filter((item) => item.id !== w.id))}
                      aria-label={`Stop following ${watcherLabel(w)}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
            </ul>
          ) : null}

          <button
            type="button"
            className="fr-reset"
            onClick={() => setWatchers(DEFAULT_WATCHERS)}
            title="Go back to the six defaults"
          >
            Reset to defaults
          </button>
        </div>
      ) : null}

      {!editing && watchers.length > 0 ? (
        <p className="fr-foot">
          <Tip text="Click a row to see its steps; the time jumps to the newest one." side="left" wide>
            <span>click a row to jump</span>
          </Tip>
        </p>
      ) : null}
    </section>
  );
}
