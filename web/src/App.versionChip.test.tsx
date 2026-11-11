import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TelemetryStrip, VersionChip } from './App';
import type { BuildInfo } from './api';

/** A full BuildInfo, so each test overrides only the field it is about. */
function build(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    version: '1.0.0-dev.728',
    release: '1.0.0',
    channel: 'dev',
    commit: '0746f579abcdef0123456789abcdef012345678',
    commit_short: '0746f579',
    commit_date: '2026-11-10T14:00:00Z',
    built_at: '2026-11-10T14:05:00Z',
    dirty: false,
    build: 'b-728',
    ...overrides,
  };
}

/** The visible text of rendered markup, with tags (and their attributes) dropped. */
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, '');
}

describe('VersionChip', () => {
  it('renders the exact line for the running build', () => {
    const markup = renderToStaticMarkup(<VersionChip build={build()} onCopy={() => {}} />);
    expect(textOf(markup)).toBe('v1.0.0-dev.728 · 2026-11-10 · 0746f579');
  });

  it('renders its own values when the metadata differs', () => {
    const other = build({
      version: '2.4.1-rc.3',
      commit: 'abc1234ffffffffffffffffffffffffffffffff',
      commit_short: 'abc1234',
      commit_date: '2025-03-09T08:30:00Z',
    });
    const markup = renderToStaticMarkup(<VersionChip build={other} onCopy={() => {}} />);
    expect(textOf(markup)).toBe('v2.4.1-rc.3 · 2025-03-09 · abc1234');
  });

  it('renders nothing when there is no build', () => {
    expect(renderToStaticMarkup(<VersionChip build={null} onCopy={() => {}} />)).toBe('');
  });

  it('marks a dirty build', () => {
    const markup = renderToStaticMarkup(
      <VersionChip build={build({ dirty: true })} onCopy={() => {}} />,
    );
    expect(textOf(markup)).toBe('v1.0.0-dev.728 · 2026-11-10 · 0746f579 · modified');
  });
});

describe('TelemetryStrip', () => {
  it('keeps the version chip when telemetry is hidden, but not Events or Lost', () => {
    const markup = renderToStaticMarkup(
      <TelemetryStrip
        build={build()}
        telemetryVisible={false}
        events={1234}
        lost={7}
        replayIndex={null}
        visibleCount={0}
        onCopyVersion={() => {}}
      />,
    );
    expect(markup).toContain('v1.0.0-dev.728 · 2026-11-10 · 0746f579');
    expect(markup).not.toContain('Events');
    expect(markup).not.toContain('Lost');
  });
});
