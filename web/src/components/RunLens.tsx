import { useEffect, useMemo, useState } from 'react';
import type { OmniEvent } from '../types';
import {
  buildLensGroups,
  lensTypeText,
  replayPrefixCount,
  seekIndexForGroup,
  selectLensView,
  type LensCategory,
  type LensGroup,
  type LensReplayState,
  type LensTone,
} from '../graph/lens';
import './RunLens.css';

/**
 * One user-initiated announcement, plus the state it was computed for. The state travels with the
 * text so a later render can tell whether the sentence still describes what is on screen.
 */
interface LensAnnouncement {
  text: string;
  eventId: string | null;
  /** The replay index the seek asked for, in the same normalised form `selectLensView` reports. */
  replayIndex: number | null;
  /** Identity of the loaded events the sentence was computed from (a chat switch replaces it). */
  events: OmniEvent[];
}

export interface RunLensProps {
  events: OmniEvent[];
  /** The replay prefix length; `null` means live (all loaded steps are in view). */
  replayIndex: number | null;
  selectedEventId: string | null;
  /** Move replay. `null` means live; an index is the prefix length, as ReplayBar uses it. */
  onSeek: (index: number | null) => void;
  /** Select a recorded event for the inspector and the rest of the viewer. */
  onSelectEvent: (eventId: string) => void;
  loading?: boolean;
  /** True when only the newest loaded window is present (earlier activity is not loaded). */
  partial?: boolean;
  /** False when no chat is selected, so the empty state does not imply the recorder is empty. */
  hasChat?: boolean;
  /** Fixed clock offset for deterministic tests; defaults to the device's timezone. */
  timezoneOffsetMinutes?: number;
}

const CATEGORY_GLYPH: Record<LensCategory, string> = {
  model: 'M',
  tool: 'T',
  session: 'S',
  turn: '↳',
  helper: 'H',
  background: 'B',
  lost: '!',
  other: '?',
};

const CATEGORY_NAME: Record<LensCategory, string> = {
  model: 'Model',
  tool: 'Tool',
  session: 'Session',
  turn: 'Turn',
  helper: 'Helper',
  background: 'Background',
  lost: 'Lost records',
  other: 'Other',
};

const REPLAY_TEXT: Record<LensReplayState, string> = {
  all: 'in replay',
  partial: 'partly in replay',
  none: 'after replay position',
};

const TONE_NAME: Record<LensTone, string> = {
  ok: 'ok',
  error: 'explicit error',
  running: 'running',
  stopped: 'stopped',
  unknown: 'status not recorded or not recognised',
};

function stepCount(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'step' : 'steps'}`;
}

/**
 * Keep the centre readout inside the eye on very large streams; the header keeps exact counts.
 * Rounded thousands never spill into a four-digit "1,000k" — that becomes "1.0M" instead.
 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 10_000) return value.toLocaleString('en-US');
  if (value < 1_000_000) {
    const thousands = Math.round(value / 1000);
    if (thousands < 1000) return `${thousands.toLocaleString('en-US')}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * "step 4 of 1,234" for the whole recording, or "step 4 of 1,234 loaded" when earlier activity has
 * not been loaded, so a loaded-window number is never read as a run total.
 */
function rangeText(group: LensGroup, totalEvents: number, loadedWindow = false): string {
  const first = group.firstIndex + 1;
  const last = group.lastIndex + 1;
  const total = `${totalEvents.toLocaleString('en-US')}${loadedWindow ? ' loaded' : ''}`;
  return group.count === 1 ? `step ${first} of ${total}` : `steps ${first}–${last} of ${total}`;
}

function accessibleName(group: LensGroup, totalEvents: number, loadedWindow: boolean): string {
  const time = group.timeRangeLabel;
  const type = lensTypeText(group);
  const status = group.status === null ? 'status not recorded' : `status ${group.statusLabel}`;
  const missing = group.missingTimeCount > 0 ? ` time missing for ${group.missingTimeCount}.` : '';
  return `${time}. ${type}. ${status}.${missing} ${stepCount(group.count)}. ${rangeText(
    group,
    totalEvents,
    loadedWindow,
  )}. ${REPLAY_TEXT[group.replayState]}.`;
}

function polar(cx: number, cy: number, radius: number, angleDegrees: number): { x: number; y: number } {
  const radians = (angleDegrees * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function arcPath(cx: number, cy: number, radius: number, fraction: number): string {
  const start = polar(cx, cy, radius, -90);
  const end = polar(cx, cy, radius, -90 + 360 * Math.min(1, Math.max(0, fraction)));
  const large = fraction > 0.5 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/** A marker shape that changes with recorded status, so status is never carried by colour alone. */
function MarkerShape({ tone, radius }: { tone: LensTone; radius: number }) {
  if (tone === 'error') {
    return (
      <rect
        className="lens-shape"
        x={-radius * 0.78}
        y={-radius * 0.78}
        width={radius * 1.56}
        height={radius * 1.56}
        rx={1}
        transform="rotate(45)"
      />
    );
  }
  if (tone === 'stopped') {
    return <rect className="lens-shape" x={-radius} y={-radius} width={radius * 2} height={radius * 2} rx={2} />;
  }
  if (tone === 'running') {
    return (
      <>
        <circle className="lens-shape lens-shape-running-outer" r={radius + 3.5} />
        <circle className="lens-shape" r={radius} />
      </>
    );
  }
  return <circle className="lens-shape" r={radius} />;
}

export function RunLens({
  events,
  replayIndex,
  selectedEventId,
  onSeek,
  onSelectEvent,
  loading = false,
  partial = false,
  hasChat = true,
  timezoneOffsetMinutes,
}: RunLensProps) {
  const allGroups = useMemo(
    () => buildLensGroups(events, timezoneOffsetMinutes),
    [events, timezoneOffsetMinutes],
  );
  // Grouping is the expensive half. Each replay tick and selection change only rescans the
  // pre-built groups (and, with a selection, the loaded event ids) instead of regrouping them.
  const view = useMemo(
    () => selectLensView(allGroups, events.length, { replayIndex, selectedEventId }),
    [allGroups, events.length, replayIndex, selectedEventId],
  );

  const groups = view.groups;
  const selectedIndex = view.selectedGroupIndex;
  const cursorIndex = view.cursorGroupIndex;
  const isLive = view.replayIndex === null;
  /**
   * Where the viewer steps from. When replay is not live — a slider drag, playback, the ReplayBar,
   * or a moment activated earlier — the replay cursor outranks a selection that was left behind,
   * so Previous/Next step from the position the rest of the viewer is showing. When replay is live
   * the whole recording is in view, so a selection (from the list, or from the map) is the natural
   * place to step from; the nav note below says which of the two is in charge, so a Next after
   * pressing Live is never a surprise rewind.
   */
  const currentIndex =
    view.replayIndex !== null
      ? cursorIndex
      : selectedIndex >= 0
        ? selectedIndex
        : cursorIndex;
  const current = currentIndex >= 0 ? groups[currentIndex] : null;
  // Only call it a selection when the moment in the detail card is the one the list marks.
  const atSelectedMoment = selectedIndex >= 0 && currentIndex === selectedIndex;

  /**
   * Written only by a user action (a moment, Previous or Next). Replay ticks and streaming events
   * never write it, so a screen reader is not flooded while the agent works, and the context it was
   * written for is kept with the text: a different selection, a replay move, or a new loaded-event
   * set (another chat, an append, earlier steps) empties it. Clearing a live region is silent, so
   * this removes stale text without announcing anything.
   */
  const [announcement, setAnnouncement] = useState<LensAnnouncement | null>(null);
  useEffect(() => {
    if (announcement === null) return;
    if (
      announcement.events !== events ||
      announcement.eventId !== selectedEventId ||
      announcement.replayIndex !== view.replayIndex
    ) {
      setAnnouncement(null);
    }
  }, [announcement, events, selectedEventId, view.replayIndex]);

  const activate = (group: LensGroup) => {
    const seek = seekIndexForGroup(group, view.totalEvents);
    onSeek(seek);
    const representative = group.eventIds[group.eventIds.length - 1];
    if (representative) onSelectEvent(representative);
    // Name the position in the recording, not in the sample. Seeking rebuilds the sample around the
    // new selection and cursor, so "moment k of the shown markers" could point at a different
    // marker by the time it is read; a recorded position does not move.
    const position = allGroups.findIndex((candidate) => candidate.key === group.key) + 1;
    const replayAfter = replayPrefixCount(seek, view.totalEvents);
    setAnnouncement({
      text: `${position > 0 ? `Moment ${position} of ${allGroups.length}${partial ? ' loaded' : ''}` : 'Moment'}: ${
        group.timeRangeLabel
      }. ${lensTypeText(group)}. ${group.statusLabel}. ${stepCount(group.count)}. ${rangeText(
        group,
        view.totalEvents,
        partial,
      )}. ${
        seek === null
          ? 'Replay is live.'
          : `Replay at step ${replayAfter.toLocaleString('en-US')} of ${view.totalEvents.toLocaleString(
              'en-US',
            )}${partial ? ' loaded' : ''}.`
      }`,
      eventId: representative ?? selectedEventId,
      replayIndex: seek,
      events,
    });
  };

  const step = (direction: 1 | -1) => {
    if (groups.length === 0) return;
    // Nothing is at the replay position (replay zero, or nothing selected yet): Previous must not
    // wrap forward to the end, and Next starts at the first moment.
    if (currentIndex < 0) {
      if (direction === -1) return;
      activate(groups[0]);
      return;
    }
    const target = Math.min(groups.length - 1, Math.max(0, currentIndex + direction));
    if (target === currentIndex) return;
    activate(groups[target]);
  };

  const canGoPrevious = groups.length > 0 && currentIndex > 0;
  const canGoNext = groups.length > 0 && currentIndex < groups.length - 1;
  // Say out loud which anchor Previous/Next use: the replay position, the selected moment while
  // live, or the latest moment. The note is also the buttons' accessible description.
  const navAnchor =
    current === null
      ? 'Nothing is at the replay position yet; Next starts at the first moment.'
      : !isLive
        ? `Stepping from the replay position at ${current.timeRangeLabel}.`
        : selectedIndex >= 0
          ? `Replay is live; Previous and Next step from the selected moment at ${current.timeRangeLabel}.`
          : `Replay is live; Previous and Next step from the latest moment at ${current.timeRangeLabel}.`;

  const totalSteps = view.totalEvents.toLocaleString('en-US');
  const totalGroups = view.totalGroups.toLocaleString('en-US');
  const shownGroups = groups.length.toLocaleString('en-US');
  // When only the newest window is loaded, every count on screen is a loaded-window count and says so.
  const replayLine = isLive
    ? `Live replay · all ${totalSteps} ${partial ? 'loaded' : 'recorded'} steps are in view`
    : `Replay at ${view.replayCount.toLocaleString('en-US')} of ${totalSteps}${
        partial ? ' loaded' : ''
      } · later recorded steps are not in the replay yet`;
  const samplingNote = !view.sampled
    ? ''
    : [
        `Showing ${shownGroups} of ${totalGroups} moment groups; ${
          view.omittedGroups === 1 ? 'the other group is' : 'the others are'
        } outside this sample. The selected moment and the replay position are kept where the cap allows, and moments with an explicit failure are kept as far as it allows.`,
        view.omittedFailures > 0
          ? `${view.omittedFailures.toLocaleString('en-US')} ${
              view.omittedFailures === 1
                ? 'moment with an explicit failure is'
                : 'moments with an explicit failure are'
            } outside this sample and not marked here; ${
              view.omittedFailures === 1 ? 'it remains' : 'they remain'
            } in the recording and in the totals.`
          : '',
        view.omittedEvents > 0
          ? `${view.omittedEvents.toLocaleString('en-US')} recorded ${
              view.omittedEvents === 1 ? 'step is' : 'steps are'
            } outside this sample; ${
              view.omittedEvents === 1 ? 'it remains' : 'they remain'
            } in the recording and in the totals.`
          : '',
        `Previous and Next move through the markers shown here; the sample is rebuilt around the selected moment and the replay position, so it can change as you navigate.`,
      ]
        .filter(Boolean)
        .join(' ');

  const intro = (
    <header className="lens-intro">
      <div>
        <p className="lens-eyebrow">Recorded moments</p>
        <h2 className="lens-title" id="run-lens-title">
          Run Lens
        </h2>
      </div>
      <p className="lens-counts">
        {totalSteps} {partial ? 'loaded' : 'recorded'} {view.totalEvents === 1 ? 'step' : 'steps'} ·{' '}
        {totalGroups}
        {partial ? ' loaded' : ''} {view.totalGroups === 1 ? 'moment group' : 'moment groups'} ·{' '}
        {view.sampled
          ? `${shownGroups} ${groups.length === 1 ? 'marker' : 'markers'} shown`
          : `all ${shownGroups} ${groups.length === 1 ? 'marker' : 'markers'} shown`}
      </p>
    </header>
  );

  if (view.totalEvents === 0) {
    return (
      <section className="lens-root" aria-labelledby="run-lens-title">
        {intro}
        <div className="lens-empty" role="status">
          {!hasChat ? (
            <p>
              Pick a conversation on the left to see its recorded moments. Nothing is drawn until a
              chat is selected.
            </p>
          ) : loading ? (
            <p>Loading recorded steps…</p>
          ) : (
            <>
              <p>
                <strong>No recorded steps yet.</strong>
              </p>
              <p>
                This lens draws only what the recorder wrote. It fills in as the agent works; nothing
                is guessed or filled in for it.
              </p>
            </>
          )}
        </div>
      </section>
    );
  }

  const fraction = view.totalEvents > 0 ? view.replayCount / view.totalEvents : 0;
  const centerX = 160;
  const centerY = 160;
  const orbitRadius = 118;
  const markerRadius = groups.length <= 8 ? 13 : groups.length <= 12 ? 11.5 : 10;
  const points = groups.map((group, index) => {
    const angle = -90 + (index * 360) / groups.length;
    const point = polar(centerX, centerY, orbitRadius, angle);
    return { group, index, x: point.x, y: point.y };
  });
  const presentCategories = Array.from(new Set(groups.map((group) => group.category)));

  return (
    <section className="lens-root" aria-labelledby="run-lens-title">
      {intro}
      {/*
        Deliberately not a live region. This text changes on every appended event and every replay
        tick, so announcing it would flood a screen reader while the agent is streaming. It stays
        visually hidden and is read when the reader moves to it.
      */}
      <p className="lens-live">
        {current
          ? `${atSelectedMoment ? 'Selected moment' : 'Replay position'}: ${lensTypeText(
              current,
            )}. ${current.statusLabel}. ${stepCount(current.count)}. ${rangeText(
              current,
              view.totalEvents,
              partial,
            )}. ${REPLAY_TEXT[current.replayState]}.`
          : ''}
      </p>
      {/*
        The one polite region in the lens, and only a user action writes text to it: activating a
        moment, or Previous/Next. Streaming events and replay ticks may empty it (the sentence no
        longer describes what is on screen) but never replace it with new text, so a screen reader
        is not flooded while the agent works.
      */}
      <p className="lens-announcer" role="status" aria-live="polite">
        {announcement?.text ?? ''}
      </p>
      <p className="lens-lede">
        One ring through the loaded recording. Each marker is a recorded moment, labelled with its
        type, its recorded status shape, and how many steps it stands for.
      </p>

      {view.sampled ? (
        <p className="lens-note">{samplingNote}</p>
      ) : null}
      {partial ? (
        <p className="lens-note">
          Only the loaded window is shown. Earlier activity has not been loaded, so this ring is not
          the whole run.
        </p>
      ) : null}
      <p className="lens-note lens-privacy">
        Drawn from recorded kind, status, tool name, order and time only. No message text, prompt,
        arguments, tool output or model name is shown.
      </p>

      <div className="lens-grid">
        <div className="lens-orbit-wrap">
          <svg
            className="lens-svg"
            viewBox="0 0 320 320"
            role="presentation"
            aria-hidden="true"
            focusable="false"
          >
            <circle className="lens-field" cx={centerX} cy={centerY} r={150} />
            <circle className="lens-ring lens-ring-outer" cx={centerX} cy={centerY} r={137} />
            <circle className="lens-ring" cx={centerX} cy={centerY} r={orbitRadius} />
            <circle className="lens-ring lens-ring-inner" cx={centerX} cy={centerY} r={78} />
            {fraction >= 1 ? (
              <circle className="lens-replay-arc" cx={centerX} cy={centerY} r={143} />
            ) : fraction > 0 ? (
              <path className="lens-replay-arc" d={arcPath(centerX, centerY, 143, fraction)} />
            ) : null}
            <path
              className="lens-eye"
              d={`M ${centerX - 52} ${centerY} Q ${centerX} ${centerY - 54} ${centerX + 52} ${centerY} Q ${centerX} ${centerY + 54} ${centerX - 52} ${centerY} Z`}
            />
            <circle className="lens-center-ring" cx={centerX} cy={centerY} r={30} />
            <circle className="lens-center-dot" cx={centerX} cy={centerY} r={4} />
            <text className="lens-center-count" x={centerX} y={centerY - 7} textAnchor="middle">
              {compactNumber(view.replayCount)}/{compactNumber(view.totalEvents)}
            </text>
            <text className="lens-center-label" x={centerX} y={centerY + 17} textAnchor="middle">
              {isLive ? 'live replay' : 'steps replayed'}
            </text>

            {points.map(({ group, index, x, y }) => {
              const isSelected = index === selectedIndex;
              const isCursor = index === cursorIndex;
              const countText = group.count > 99 ? '99+' : String(group.count);
              return (
                <g
                  key={group.key}
                  className={`lens-point tone-${group.tone}${isSelected ? ' is-selected' : ''}${isCursor ? ' is-cursor' : ''}`}
                  onClick={() => activate(group)}
                >
                  {isCursor && !isSelected ? (
                    <circle className="lens-cursor-ring" cx={x} cy={y} r={markerRadius + 5} />
                  ) : null}
                  {isSelected ? (
                    <circle className="lens-select-ring" cx={x} cy={y} r={markerRadius + 6} />
                  ) : null}
                  <g transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}>
                    <MarkerShape tone={group.tone} radius={markerRadius} />
                    <text
                      className="lens-point-type"
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={Math.max(8, markerRadius * 0.95)}
                    >
                      {CATEGORY_GLYPH[group.category]}
                    </text>
                    {group.count > 1 ? (
                      <g transform={`translate(${markerRadius * 0.92} ${-markerRadius * 0.92})`}>
                        <circle className="lens-count-badge" r={8} />
                        <text className="lens-count-text" textAnchor="middle" y={2.5}>
                          {countText}
                        </text>
                      </g>
                    ) : null}
                  </g>
                </g>
              );
            })}
          </svg>
          <p className="lens-orbit-caption">
            {replayLine}. <span className="lens-caption-sub">Marker shapes: circle ok, diamond explicit error, double ring running, square stopped, dashed status not recorded or not recognised.</span>
          </p>
        </div>

        <div className="lens-side">
          <div className="lens-detail">
            <p className="lens-eyebrow">
              {atSelectedMoment
                ? 'Selected moment'
                : currentIndex >= 0
                  ? 'At replay position'
                  : 'Recorded moments'}
            </p>
            {current ? (
              <>
                <h3 className="lens-detail-title">{lensTypeText(current)}</h3>
                <p className="lens-detail-meta">
                  <span className="mono">{current.timeRangeLabel}</span>
                  <span className={`lens-status tone-${current.tone}`}>{current.statusLabel}</span>
                  <span className="mono">{stepCount(current.count)}</span>
                </p>
                <p className="lens-detail-window">
                  {rangeText(current, view.totalEvents, partial)} · {REPLAY_TEXT[current.replayState]}
                </p>
                {current.missingTimeCount > 0 ? (
                  <p className="lens-detail-missing">
                    Time not recorded for {current.missingTimeCount} of {current.count}{' '}
                    {current.count === 1 ? 'step' : 'steps'} in this group.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="lens-detail-window">No recorded moment is at the replay position yet.</p>
            )}
            <p className="lens-detail-hint">
              Selecting a moment moves replay to the end of its group, so the steps in view match the
              replay position, and selects that group&apos;s last recorded step.
            </p>
          </div>

          <div className="lens-nav" role="group" aria-label="Move through recorded moments">
            <button
              type="button"
              className="lens-nav-button"
              onClick={() => step(-1)}
              disabled={!canGoPrevious}
              aria-label="Previous moment"
              aria-describedby="run-lens-nav-anchor"
            >
              ← Previous
            </button>
            <button
              type="button"
              className="lens-nav-button"
              onClick={() => step(1)}
              disabled={!canGoNext}
              aria-label="Next moment"
              aria-describedby="run-lens-nav-anchor"
            >
              Next →
            </button>
          </div>
          <p className="lens-nav-anchor" id="run-lens-nav-anchor">
            {navAnchor}
          </p>

          <h3 className="lens-list-title" id="run-lens-list-title">
            Moments, oldest first
          </h3>
          <ol className="lens-list" aria-labelledby="run-lens-list-title">
            {groups.map((group, index) => {
              const isSelected = index === selectedIndex;
              return (
                <li key={group.key}>
                  <button
                    type="button"
                    className={`lens-moment${isSelected ? ' is-selected' : ''}`}
                    aria-current={isSelected ? 'true' : undefined}
                    aria-label={accessibleName(group, view.totalEvents, partial)}
                    onClick={() => activate(group)}
                  >
                    <span className="lens-moment-line">
                      <span className="lens-moment-time mono">{group.timeRangeLabel}</span>
                      <span className={`lens-moment-glyph tone-${group.tone}`} aria-hidden="true">
                        {CATEGORY_GLYPH[group.category]}
                      </span>
                      <span className="lens-moment-type">{lensTypeText(group)}</span>
                    </span>
                    <span className="lens-moment-line lens-moment-meta">
                      <span className={`lens-status tone-${group.tone}`}>{group.statusLabel}</span>
                      <span className="mono">{stepCount(group.count)}</span>
                      <span className="mono">{rangeText(group, view.totalEvents, partial)}</span>
                      <span className={`lens-replay-tag replay-${group.replayState}`}>
                        {REPLAY_TEXT[group.replayState]}
                      </span>
                      {isSelected ? <span className="lens-selected-tag">Selected</span> : null}
                      {group.missingTimeCount > 0 ? (
                        <span className="lens-missing">
                          time missing for {group.missingTimeCount}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <div className="lens-legend" role="group" aria-label="Run Lens key">
        <div className="lens-legend-block">
          <span className="lens-legend-title">Type</span>
          {presentCategories.map((category) => (
            <span className="lens-legend-item" key={category}>
              <span className="lens-legend-glyph" aria-hidden="true">
                {CATEGORY_GLYPH[category]}
              </span>
              {CATEGORY_NAME[category]}
            </span>
          ))}
        </div>
        <div className="lens-legend-block">
          <span className="lens-legend-title">Recorded status</span>
          {(['ok', 'error', 'running', 'stopped', 'unknown'] as LensTone[]).map((tone) => (
            <span className="lens-legend-item" key={tone}>
              <span className={`lens-legend-shape tone-${tone}`} aria-hidden="true" />
              {TONE_NAME[tone]}
            </span>
          ))}
        </div>
        <div className="lens-legend-block">
          <span className="lens-legend-title">Groups</span>
          <span className="lens-legend-item">
            <span className="lens-legend-count" aria-hidden="true">
              3
            </span>
            number = steps in that moment
          </span>
        </div>
      </div>
    </section>
  );
}
