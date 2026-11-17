import { describe, expect, it } from 'vitest';
import { OPEN_WEB, OPEN_WEB_RESULT, requestBrowserOpen } from './browserOpen';

function fakeWindow() {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    listeners,
    addEventListener: (_: 'message', l: (event: MessageEvent) => void) => listeners.add(l),
    removeEventListener: (_: 'message', l: (event: MessageEvent) => void) => listeners.delete(l),
    deliver(event: Partial<MessageEvent>) {
      for (const l of [...listeners]) l(event as MessageEvent);
    },
  };
}

describe('requestBrowserOpen', () => {
  it('never puts the viewer key or a URL in the request', async () => {
    const sent: unknown[] = [];
    const self = fakeWindow();
    const parent = { postMessage: (m: unknown) => sent.push(m) };
    const pending = requestBrowserOpen({ session: 's1', view: 'graph' }, { parent, listenOn: self, timeoutMs: 10 });
    await pending;
    const msg = sent[0] as Record<string, unknown>;
    expect(msg.type).toBe(OPEN_WEB);
    expect(Object.keys(msg).sort()).toEqual(['requestId', 'session', 'type', 'view']);
    expect(JSON.stringify(msg)).not.toMatch(/t=|http/);
  });

  it('reports opened only when the parent answers ok for this request', async () => {
    const self = fakeWindow();
    let id = '';
    const parent = { postMessage: (m: unknown) => { id = (m as { requestId: string }).requestId; } };
    const pending = requestBrowserOpen({ session: null, view: null }, { parent, listenOn: self, timeoutMs: 1000 });
    // A stranger and a stale request are ignored.
    self.deliver({ source: {} as MessageEventSource, data: { type: OPEN_WEB_RESULT, requestId: id, ok: true } });
    self.deliver({ source: parent as unknown as MessageEventSource, data: { type: OPEN_WEB_RESULT, requestId: 'old', ok: true } });
    self.deliver({ source: parent as unknown as MessageEventSource, data: { type: OPEN_WEB_RESULT, requestId: id, ok: true } });
    expect(await pending).toBe('opened');
    expect(self.listeners.size).toBe(0);
  });

  it('reports a failed launch', async () => {
    const self = fakeWindow();
    let id = '';
    const parent = { postMessage: (m: unknown) => { id = (m as { requestId: string }).requestId; } };
    const pending = requestBrowserOpen({ session: null, view: null }, { parent, listenOn: self, timeoutMs: 1000 });
    self.deliver({ source: parent as unknown as MessageEventSource, data: { type: OPEN_WEB_RESULT, requestId: id, ok: false } });
    expect(await pending).toBe('failed');
  });

  it('reports no answer when nothing is listening', async () => {
    const self = fakeWindow();
    const result = await requestBrowserOpen({ session: null, view: null }, {
      parent: { postMessage: () => {} }, listenOn: self, timeoutMs: 5,
    });
    expect(result).toBe('no-answer');
    expect(self.listeners.size).toBe(0);
  });
});
