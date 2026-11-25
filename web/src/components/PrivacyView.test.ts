import { describe, expect, it } from 'vitest';
import { privacyWhen, privacyWhy, type PrivacyRun } from './PrivacyView';

function run(partial: Partial<PrivacyRun> = {}): PrivacyRun {
  return {
    event_id: 'evt-1',
    ts: 1_800_000_000,
    at: '2026-11-23 09:41:07',
    tool: 'browser_exec',
    cls: 'browser',
    label: 'Browser use',
    why: 'It drove a web browser.',
    touched: 'example.com',
    tone: 'high',
    session_id: 's1',
    chat_title: null,
    turn_id: null,
    status: 'ok',
    duration_ms: 1200,
    ...partial,
  };
}

describe('the privacy row says when and why', () => {
  it('shows the exact recorded local time, not only how long ago', () => {
    const when = privacyWhen(run(), 1_800_000_030);
    expect(when.exact).toBe('2026-11-23 09:41:07');
    expect(when.ago).toBe('30s ago');
  });

  it('falls back to the browser clock when an older recording has no local stamp', () => {
    const when = privacyWhen(run({ at: null }), 1_800_000_030);
    expect(when.exact).not.toBe('');
    expect(when.exact).not.toBe('null');
  });

  it('states the class reason in plain words', () => {
    expect(privacyWhy(run())).toBe('Browser use: It drove a web browser. Touched example.com');
  });

  it('names a file count or MCP server when that is what it touched', () => {
    expect(privacyWhy(run({ cls: 'sweep', label: 'Wide file sweep', why: 'It read through many files in one step.', touched: '40 files' })))
      .toBe('Wide file sweep: It read through many files in one step. Touched 40 files');
    expect(privacyWhy(run({ cls: 'mcp', label: 'MCP server', why: 'It called a tool on an MCP server.', touched: 'server filesystem' })))
      .toContain('Touched server filesystem');
  });

  it('never invents a touch when the metadata has none', () => {
    expect(privacyWhy(run({ touched: null }))).toBe('Browser use: It drove a web browser.');
  });

  it('still reads as a sentence when an older viewer sends no why field', () => {
    expect(privacyWhy(run({ why: undefined, touched: null })))
      .toBe('Browser use: touches this machine or the outside world.');
  });
});
