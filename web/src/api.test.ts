import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  fetchDiagnose,
  fetchWarnings,
  getPrefs,
  setPrefs,
  normalizeDiagnose,
  normalizeEvent,
  normalizeSession,
  type Diagnose,
} from './api';

describe('normalizeSession', () => {
  it('maps a full viewer session row', () => {
    expect(
      normalizeSession({
        id: 'abc',
        label: 'Fix the printer',
        first_ts: 1.5,
        last_ts: 2.5,
        events: 10,
        model: 'm',
        status: 'completed',
      }),
    ).toEqual({
      id: 'abc',
      label: 'Fix the printer',
      source: null,
      archived: null,
      first_ts: 1.5,
      last_ts: 2.5,
      events: 10,
      model: 'm',
      status: 'completed',
      calls: null,
      cached: null,
      fresh: null,
      output: null,
      prompt_max: null,
      prompt_now: null,
      tools: null,
      mcp_calls: null,
      skills: null,
      aux_calls: null,
      subagents: null,
      compactions: null,
    });
  });

  it('keeps prompt_now, so a compacted chat is not reported at its old peak', () => {
    const session = normalizeSession({ id: 'abc', prompt_now: 60_796, prompt_max: 517_312 });
    expect(session?.prompt_now).toBe(60_796);
    expect(session?.prompt_max).toBe(517_312);
  });

  it('keeps the token and activity totals the viewer sends', () => {
    const session = normalizeSession({
      id: 'abc',
      calls: 12,
      cached: 900,
      fresh: 100,
      output: 40,
      prompt_max: 5000,
      tools: 33,
      mcp_calls: 2,
      skills: 3,
      aux_calls: 4,
      subagents: 1,
      compactions: 2,
    });
    expect(session?.calls).toBe(12);
    expect(session?.cached).toBe(900);
    expect(session?.fresh).toBe(100);
    expect(session?.output).toBe(40);
    expect(session?.prompt_max).toBe(5000);
    expect(session?.tools).toBe(33);
    expect(session?.mcp_calls).toBe(2);
    expect(session?.skills).toBe(3);
    expect(session?.aux_calls).toBe(4);
    expect(session?.subagents).toBe(1);
    expect(session?.compactions).toBe(2);
  });

  it('accepts id aliases session_id / root_session_id / root in priority order', () => {
    expect(normalizeSession({ session_id: 'b' })?.id).toBe('b');
    expect(normalizeSession({ root_session_id: 'c' })?.id).toBe('c');
    expect(normalizeSession({ root: 'd' })?.id).toBe('d');
    expect(normalizeSession({ root: 'd', session_id: 'b' })?.id).toBe('b');
    expect(normalizeSession({ id: 'a', root: 'd' })?.id).toBe('a');
  });

  it('reads event counts from events / event_count / count', () => {
    expect(normalizeSession({ id: 'a', event_count: 3 })?.events).toBe(3);
    expect(normalizeSession({ id: 'a', count: 4 })?.events).toBe(4);
    expect(normalizeSession({ id: 'a', events: '5' })?.events).toBe(5);
  });

  it('coerces numeric strings and rejects non-finite numbers', () => {
    const s = normalizeSession({ id: 'a', first_ts: '10', last_ts: Number.NaN });
    expect(s?.first_ts).toBe(10);
    expect(s?.last_ts).toBeNull();
  });

  it('returns null for missing id or non-objects', () => {
    expect(normalizeSession({})).toBeNull();
    expect(normalizeSession({ id: '' })).toBeNull();
    expect(normalizeSession(null)).toBeNull();
    expect(normalizeSession(7)).toBeNull();
    expect(normalizeSession('abc')).toBeNull();
  });

  it('never throws on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        normalizeSession(v);
      }),
      { seed: 31337, numRuns: 200 },
    );
  });
});

describe('normalizeEvent', () => {
  it('defaults missing optional fields per the omni.v1 contract', () => {
    const e = normalizeEvent({ rowid: 3, event_id: 'x1' });
    expect(e).toEqual({
      rowid: 3,
      event_id: 'x1',
      schema: 'omni.v1',
      boot_id: '',
      seq: 3,
      ts: 0,
      kind: 'unknown',
      session_id: null,
      parent_session_id: null,
      turn_id: null,
      api_request_id: null,
      tool_call_id: null,
      subagent_id: null,
      status: null,
      attrs: null,
    });
  });

  it('drops events without rowid or event_id', () => {
    expect(normalizeEvent({ event_id: 'x' })).toBeNull();
    expect(normalizeEvent({ rowid: 1 })).toBeNull();
    expect(normalizeEvent({ rowid: 'nope', event_id: 'x' })).toBeNull();
    expect(normalizeEvent({ rowid: 1, event_id: '' })).toBeNull();
  });

  it('keeps attrs as object or string, nulls everything else', () => {
    expect(normalizeEvent({ rowid: 1, event_id: 'a', attrs: { k: 1 } })?.attrs).toEqual({ k: 1 });
    expect(normalizeEvent({ rowid: 1, event_id: 'a', attrs: '{"k":1}' })?.attrs).toBe('{"k":1}');
    expect(normalizeEvent({ rowid: 1, event_id: 'a', attrs: 5 })?.attrs).toBeNull();
    expect(normalizeEvent({ rowid: 1, event_id: 'a', attrs: false })?.attrs).toBeNull();
  });

  it('coerces numeric-ish rowid/seq/ts and falls back to rowid for seq', () => {
    const e = normalizeEvent({ rowid: '12', seq: 'bad', ts: '', event_id: 'a' });
    expect(e?.rowid).toBe(12);
    expect(e?.seq).toBe(12);
    expect(e?.ts).toBe(0);
  });

  it('preserves provided schema/boot/kind/status strings', () => {
    const e = normalizeEvent({
      rowid: 1,
      event_id: 'a',
      schema: 'omni.v2',
      boot_id: 'b1',
      kind: 'tool.end',
      status: 'ok',
      session_id: 'sess',
      tool_call_id: 'call-9',
    });
    expect(e?.schema).toBe('omni.v2');
    expect(e?.boot_id).toBe('b1');
    expect(e?.kind).toBe('tool.end');
    expect(e?.status).toBe('ok');
    expect(e?.session_id).toBe('sess');
    expect(e?.tool_call_id).toBe('call-9');
  });

  it('treats empty strings as absent everywhere (viewer omits, never empty-fills)', () => {
    const e = normalizeEvent({
      rowid: 1,
      event_id: 'a',
      kind: '',
      session_id: '',
      status: '',
    });
    expect(e?.kind).toBe('unknown');
    expect(e?.session_id).toBeNull();
    expect(e?.status).toBeNull();
  });

  it('never throws on arbitrary JSON and always yields a valid OmniEvent or null', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const e = normalizeEvent(v);
        if (e !== null) {
          expect(Number.isFinite(e.rowid)).toBe(true);
          expect(typeof e.event_id).toBe('string');
          expect(Number.isFinite(e.seq)).toBe(true);
        }
      }),
      { seed: 4242, numRuns: 200 },
    );
  });
});

describe('fetchWarnings', () => {
  it('returns [] when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    try {
      expect(await fetchWarnings('root-1')).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns [] on non-ok responses and normalizes valid rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error' })),
    );
    try {
      expect(await fetchWarnings('root-1')).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          warnings: [
            {
              title: 'Lost events',
              what_happened: '42 events were skipped.',
              what_it_means: 'The recorder fell behind.',
              severity: 'warn',
              event_ids: ['e1', ''],
              session_id: 's1',
            },
            { nope: true },
          ],
        }),
      })),
    );
    try {
      expect(await fetchWarnings('root-1')).toEqual([
        {
          title: 'Lost events',
          what_happened: '42 events were skipped.',
          what_it_means: 'The recorder fell behind.',
          severity: 'warn',
          event_ids: ['e1'],
          session_id: 's1',
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const explained: Diagnose = {
  status: 'explained',
  failed_kind: 'tool.end',
  failed_tool: 'Bash',
  error_type: 'PermissionError',
  duration_ms: 91,
  session_id: 's1',
  previous_step: { kind: 'tool.end', tool: 'Read', duration_ms: 42, event_id: 'e2' },
  evidence_event_ids: ['e1', 'e2'],
  sentence: 'The first failure was the Bash tool with a PermissionError error after 91 ms.',
};

describe('normalizeDiagnose', () => {
  it('normalizes an explained answer with junk inside it', () => {
    expect(
      normalizeDiagnose({
        status: 'explained',
        sentence: 'Boom.',
        previous_step: { tool: 'Read', duration_ms: '42', event_id: 'e2' },
        evidence_event_ids: ['e1', ''],
      }),
    ).toEqual({
      status: 'explained',
      failed_kind: null,
      failed_tool: null,
      error_type: null,
      duration_ms: null,
      session_id: null,
      previous_step: { kind: null, tool: 'Read', duration_ms: 42, event_id: 'e2' },
      evidence_event_ids: ['e1'],
      sentence: 'Boom.',
    });
  });

  it('maps no_failure and insufficient', () => {
    expect(normalizeDiagnose({ status: 'no_failure', events: '7' })).toEqual({
      status: 'no_failure',
      events: 7,
    });
    expect(normalizeDiagnose({ status: 'insufficient', missing: ['previous_step', 5] })).toEqual({
      status: 'insufficient',
      missing: ['previous_step'],
    });
  });

  it('falls back to insufficient+response on any unknown shape', () => {
    const fallback = { status: 'insufficient', missing: ['response'] };
    expect(normalizeDiagnose(null)).toEqual(fallback);
    expect(normalizeDiagnose({})).toEqual(fallback);
    expect(normalizeDiagnose({ status: 'bogus' })).toEqual(fallback);
    expect(normalizeDiagnose({ status: 'explained' })).toEqual(fallback);
    expect(normalizeDiagnose({ status: 'insufficient', missing: [] })).toEqual(fallback);
  });
});

describe('fetchDiagnose', () => {
  it('returns null when the request fails or the response is not ok', async () => {
    const responders = [
      () => Promise.reject(new Error('network down')),
      () => Promise.resolve({ ok: false, status: 500, statusText: 'Server Error' }),
    ];
    for (const responder of responders) {
      vi.stubGlobal('fetch', vi.fn(responder));
      try {
        expect(await fetchDiagnose('root-1')).toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it('calls the diagnose endpoint and normalizes the payload', async () => {
    const fetchMock = vi.fn(async (_input: string) => ({ ok: true, json: async () => explained }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await fetchDiagnose('root/1')).toEqual(explained);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/diagnose?root=root%2F1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('shared chat settings', () => {
  it('reads the summary settings the plugin shares', async () => {
    const fetchMock = vi.fn(async (_input: string) => ({
      ok: true,
      json: async () => ({ version: 1, digest: { enabled: false, detail: 'full' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await getPrefs()).toEqual({ digest: { enabled: false, detail: 'full' } });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/prefs');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fills in safe defaults when the plugin answers with junk', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ digest: { detail: 'shout' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await getPrefs()).toEqual({ digest: { enabled: true, detail: 'standard' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('posts only the setting that changed', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ digest: { enabled: true, detail: 'brief' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const saved = await setPrefs({ digest: { detail: 'brief' } });
      expect(saved.digest.detail).toBe('brief');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/v1/prefs');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ digest: { detail: 'brief' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('surfaces a failed save instead of pretending it worked', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(setPrefs({ digest: { enabled: false } })).rejects.toThrow('500');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
