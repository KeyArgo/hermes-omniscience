import { describe, expect, it } from 'vitest';
import { attrsOf, missing, normalizeStatus } from './reduce';
import { makeEvent } from '../test-fixtures/streams';

describe('missing()', () => {
  it('renders the em-dash placeholder for absent values', () => {
    expect(missing(null)).toBe('—');
    expect(missing(undefined)).toBe('—');
    expect(missing('')).toBe('—');
  });

  it('stringifies present values including falsy-but-real ones', () => {
    expect(missing(0)).toBe('0');
    expect(missing(false)).toBe('false');
    expect(missing(NaN)).toBe('NaN');
    expect(missing('tool')).toBe('tool');
    expect(missing({ a: 1 })).toBe('[object Object]');
  });
});

describe('attrsOf()', () => {
  it('passes object attrs through', () => {
    expect(attrsOf(makeEvent(1, 'x', { attrs: { a: 1 } }))).toEqual({ a: 1 });
  });

  it('parses JSON object strings', () => {
    expect(attrsOf(makeEvent(1, 'x', { attrs: '{"a":1}' }))).toEqual({ a: 1 });
  });

  it('returns {} for null, broken JSON, and falsy attrs', () => {
    for (const raw of [null, undefined, '{oops', '42', '"s"', 'true', 'null', 0, false]) {
      expect(attrsOf(makeEvent(1, 'x', { attrs: raw as never }))).toEqual({});
    }
  });

  // BUG: attrsOf's contract is a record, but truthy non-object attrs (numbers, booleans)
  // are returned verbatim, typed as a record.
  it.fails('BUG: attrsOf passes truthy non-object attrs through instead of {}', () => {
    expect(attrsOf(makeEvent(1, 'x', { attrs: 5 as never }))).toEqual({});
    expect(attrsOf(makeEvent(1, 'x', { attrs: true as never }))).toEqual({});
  });

  it('wraps JSON arrays as records (they are objects, keep that behaviour pinned)', () => {
    const out = attrsOf(makeEvent(1, 'x', { attrs: '[1,2]' }));
    expect(typeof out).toBe('object');
    expect(out.length).toBe(2);
  });
});

describe('normalizeStatus()', () => {
  const cases: [string, string][] = [
    ['ok', 'ok'],
    ['OK', 'ok'],
    ['success', 'ok'],
    ['Succeeded', 'ok'],
    ['error', 'error'],
    ['failed', 'error'],
    ['FAILURE', 'error'],
    ['Interrupted', 'interrupted'],
    ['blocked', 'blocked'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['completed', 'completed'],
    ['complete', 'completed'],
    ['running', 'running'],
    ['started', 'running'],
    ['in_progress', 'running'],
  ];
  it.each(cases)('maps %s to %s', (raw, want) => {
    expect(normalizeStatus(raw)).toBe(want);
  });

  it('uses the caller fallback for unknown or non-string values', () => {
    expect(normalizeStatus('weird')).toBe('unknown');
    expect(normalizeStatus('weird', 'ok')).toBe('ok');
    expect(normalizeStatus(null, 'completed')).toBe('completed');
    expect(normalizeStatus(7, 'error')).toBe('error');
    expect(normalizeStatus(undefined, 'running')).toBe('running');
  });
});
