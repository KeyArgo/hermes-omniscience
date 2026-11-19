import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HeaderBrand,
  TelemetryStrip,
  VersionChip,
  chipClasses,
  chipLabel,
  copyChipLine,
  versionChipText,
  type ChipCopyState,
} from './App';
import type { BuildInfo } from './api';

/** A full BuildInfo, so each test overrides only the field it is about. */
function build(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    version: '1.0.0-dev.728',
    release: '1.0.0',
    channel: 'dev',
    commit: '0746f579abcdef0123456789abcdef012345678',
    commit_short: '0746f579',
    chip_line: 'v1.0.0-dev.728 · 0746f579 · 2026-11-10',
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
    expect(textOf(markup)).toBe('v1.0.0-dev.728 · 0746f579 · 2026-11-10');
  });

  it('renders its own values when the metadata differs', () => {
    const other = build({
      version: '2.4.1-rc.3',
      commit: 'abc1234ffffffffffffffffffffffffffffffff',
      commit_short: 'abc1234',
      commit_date: '2025-03-09T08:30:00Z',
      chip_line: undefined,
    });
    const markup = renderToStaticMarkup(<VersionChip build={other} onCopy={() => {}} />);
    expect(textOf(markup)).toBe('v2.4.1-rc.3 · abc1234 · 2025-03-09');
  });

  it('uses the backend chip line as the visible and copyable version', () => {
    const line = 'v2.4.1-dev.9 · abc12345 · 2025-03-09 · modified';
    const markup = renderToStaticMarkup(<VersionChip build={build({ chip_line: line })} onCopy={() => {}} />);
    expect(textOf(markup)).toBe(line);
  });

  it('falls back safely when an older backend omits the chip line', () => {
    const legacy = build({ chip_line: undefined });
    expect(versionChipText(legacy)).toBe('v1.0.0-dev.728 · 0746f579 · 2026-11-10');
    expect(versionChipText(build({ chip_line: undefined, version: '', commit_short: '', commit_date: null })))
      .toBe('vunknown');
  });

  it('renders nothing when there is no build', () => {
    expect(renderToStaticMarkup(<VersionChip build={null} onCopy={() => {}} />)).toBe('');
  });

  it('marks a dirty build', () => {
    const markup = renderToStaticMarkup(
      <VersionChip
        build={build({ dirty: true, chip_line: 'v1.0.0-dev.728 · 0746f579 · 2026-11-10 · modified' })}
        onCopy={() => {}}
      />,
    );
    expect(textOf(markup)).toBe('v1.0.0-dev.728 · 0746f579 · 2026-11-10 · modified');
    expect(markup).toContain('is-dirty');
  });

  it('is a pill that keeps the suite order: version · commit · date', () => {
    const markup = renderToStaticMarkup(<VersionChip build={build()} onCopy={() => {}} />);
    expect(markup).toContain('version-chip');
    // Not Aura's date-before-commit fallback: the chip line leads with the version.
    expect(textOf(markup)).toMatch(/^v1\.0\.0-dev\.728 · 0746f579 · 2026-11-10$/);
  });

  it('says copied or failed only after a real copy, then reverts', async () => {
    vi.useFakeTimers();
    try {
      const states: ChipCopyState[] = [];
      const writeText = vi.fn(async () => {});
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const copied: string[] = [];
      await copyChipLine('v1.0.0-dev.728 · 0746f579 · 2026-11-10', (s) => states.push(s), (l) => copied.push(l));
      expect(writeText).toHaveBeenCalledWith('Omniscience v1.0.0-dev.728 · 0746f579 · 2026-11-10');
      expect(states).toEqual(['copied']);
      expect(copied).toEqual(['v1.0.0-dev.728 · 0746f579 · 2026-11-10']);
      vi.advanceTimersByTime(1399);
      expect(states).toEqual(['copied']);
      vi.advanceTimersByTime(1);
      expect(states).toEqual(['copied', '']);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('restarts the 1.4 s on a second click: still copied ✓ 1400 ms after the first click', async () => {
    vi.useFakeTimers();
    try {
      const states: ChipCopyState[] = [];
      const writeText = vi.fn(async () => {});
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined };
      await copyChipLine('v1 · a · b', (s) => states.push(s), undefined, timer);
      vi.advanceTimersByTime(1000);
      await copyChipLine('v1 · a · b', (s) => states.push(s), undefined, timer);
      // 1400 ms after the FIRST click: its timer was cleared by the second, so nothing reverted.
      vi.advanceTimersByTime(400);
      expect(states).toEqual(['copied', 'copied']);
      // Now the second click's own 1.4 s runs out and the label returns to the line.
      vi.advanceTimersByTime(1000);
      expect(states).toEqual(['copied', 'copied', '']);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('says copy failed when the clipboard refuses', async () => {
    vi.useFakeTimers();
    try {
      const states: ChipCopyState[] = [];
      const writeText = vi.fn(async () => {
        throw new Error('denied');
      });
      // No document either: the textarea fallback cannot save it, so the answer is the truth.
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      vi.stubGlobal('document', undefined);
      const copied: string[] = [];
      await copyChipLine('v1 · a · b', (s) => states.push(s), (l) => copied.push(l));
      expect(states).toEqual(['failed']);
      expect(copied).toEqual([]);
      vi.advanceTimersByTime(1400);
      expect(states).toEqual(['failed', '']);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('labels itself by the copy state, in the accent or the red', () => {
    expect(chipLabel('v1 · a · b', '')).toBe('v1 · a · b');
    expect(chipLabel('v1 · a · b', 'copied')).toBe('copied ✓');
    expect(chipLabel('v1 · a · b', 'failed')).toBe('copy failed');
    expect(chipClasses(build(), 'copied')).toContain('is-copied');
    expect(chipClasses(build(), 'failed')).toContain('is-copy-failed');
    expect(chipClasses(build(), '')).toBe('version-chip mono');
    expect(chipClasses(build({ dirty: true }), 'copied')).toBe('version-chip mono is-dirty is-copied');
  });
});

describe('HeaderBrand', () => {
  /** The compact header renders this same brand, so a chip in it is a chip at every width. */
  it('shows the version chip beside the product name, whatever the width', () => {
    const markup = renderToStaticMarkup(
      <HeaderBrand
        build={build()}
        followNewest={false}
        modeLabel="all chats"
        modeBlurb="Every chat, newest first."
        onCopyVersion={() => {}}
      />,
    );
    expect(markup).toContain('class="brand"');
    expect(markup).toContain('OMNISCIENCE');
    expect(markup).toContain('version-chip');
    expect(textOf(markup)).toContain('v1.0.0-dev.728 · 0746f579 · 2026-11-10');
  });

  it('still shows the chip when there is no answer yet, as nothing', () => {
    const markup = renderToStaticMarkup(
      <HeaderBrand
        build={null}
        followNewest
        modeLabel="following newest"
        modeBlurb="Following."
        onCopyVersion={() => {}}
      />,
    );
    expect(markup).toContain('OMNISCIENCE');
    expect(markup).not.toContain('version-chip');
  });
});

describe('TelemetryStrip', () => {
  it('shows the counts only when telemetry is visible, and never the chip', () => {
    const hidden = renderToStaticMarkup(
      <TelemetryStrip telemetryVisible={false} events={1234} lost={7} replayIndex={null} visibleCount={0} />,
    );
    expect(hidden).not.toContain('Events');
    expect(hidden).not.toContain('version-chip');
    const shown = renderToStaticMarkup(
      <TelemetryStrip telemetryVisible events={1234} lost={7} replayIndex={null} visibleCount={0} />,
    );
    expect(shown).toContain('Events');
    expect(shown).toContain('Lost');
    expect(shown).not.toContain('version-chip');
  });
});
