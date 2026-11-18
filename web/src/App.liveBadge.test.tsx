import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveBadge } from './App';
import {
  connectionDetails,
  formatStepTooltip,
  activityAge,
} from './graph/format';

/** The visible text of rendered markup, with tags (and their attributes) dropped. */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, '').trim();
}

describe('LiveBadge', () => {
  it('renders "Active now" with live age when live', () => {
    const markup = renderToStaticMarkup(
      <LiveBadge
        connection="live"
        label="Active now"
        ageText="12s ago"
        tooltip="An event was recorded in the last minute. That is what active means here. Last event 12s ago."
      />,
    );
    expect(textOf(markup)).toBe('Active now · 12s ago');
    expect(markup).toContain('live-badge is-live');
    expect(markup).toContain('live-dot');
  });

  it('renders "Recent activity" with age when recent', () => {
    const markup = renderToStaticMarkup(
      <LiveBadge
        connection="recent"
        label="Recent activity"
        ageText="2m ago"
        tooltip="The last event was 1–5 minutes ago: it just worked, but is not doing anything this second. Last event 2m ago."
      />,
    );
    expect(textOf(markup)).toBe('Recent activity · 2m ago');
    expect(markup).toContain('live-badge is-recent');
  });

  it('renders "Chat quiet" when idle for less than a few hours (e.g. 15 min)', () => {
    const markup = renderToStaticMarkup(
      <LiveBadge
        connection="recorded"
        label="Chat quiet"
        ageText="15m ago"
        tooltip="No event in this chat for over 5 minutes. Other chats may still be recording — this badge only describes the chat you have open. Last event 15m ago."
      />,
    );
    expect(textOf(markup)).toBe('Chat quiet · 15m ago');
    expect(markup).toContain('live-badge is-recorded');
  });

  it('renders "Last step · 2d ago" with exact local timestamp tooltip when step is 2 days old', () => {
    const stepDate = new Date(2026, 10, 15, 14, 18, 0);
    const stepTs = stepDate.getTime() / 1000;
    const now = stepTs + 2 * 86400; // 2 days later

    const details = connectionDetails('recorded', stepTs, now);
    const ageText = activityAge(now - stepTs);
    const tooltip = details.tooltip;

    const markup = renderToStaticMarkup(
      <LiveBadge
        connection="recorded"
        label={details.label}
        ageText={ageText}
        tooltip={tooltip}
      />,
    );

    // Visible text states the step age plainly without implying the recorder is broken
    expect(textOf(markup)).toBe('Last step · 2d ago');
    expect(markup).toContain('live-badge is-recorded');

    // Tooltip gives exact local date/time and confirms Omniscience is still recording
    expect(tooltip).toBe(
      'Last recorded step: Sun 15 Nov, 14:18. No step has been recorded in this chat since then.',
    );
    expect(markup).toContain(
      'title="Last recorded step: Sun 15 Nov, 14:18. No step has been recorded in this chat since then."',
    );
  });

  it('keeps "Disconnected" distinct even when steps were recorded days ago', () => {
    const markup = renderToStaticMarkup(
      <LiveBadge
        connection="disconnected"
        label="Disconnected"
        ageText="2d ago"
        tooltip="Disconnected — can't reach the viewer Last event 2d ago."
      />,
    );
    expect(textOf(markup)).toBe('Disconnected · 2d ago');
    expect(markup).toContain('live-badge is-disconnected');
    expect(markup).not.toContain('is-recorded');
  });

  it('never implies the viewer is stale when the connection is fine', () => {
    const stepTs = new Date(2026, 10, 15, 14, 18, 0).getTime() / 1000;
    const now = stepTs + 3 * 86400;

    const details = connectionDetails('recorded', stepTs, now);
    const tooltip = formatStepTooltip(stepTs);

    const markup = renderToStaticMarkup(
      <LiveBadge
        connection="recorded"
        label={details.label}
        ageText="3d ago"
        tooltip={tooltip}
      />,
    );

    expect(textOf(markup)).toBe('Last step · 3d ago');
    // Does not say "quiet", "stale", or "broken"
    expect(textOf(markup)).not.toContain('quiet');
    expect(textOf(markup)).not.toContain('stale');
    // Tooltip explicitly reassures the user
    expect(markup).toContain('No step has been recorded in this chat since then.');
  });
});
