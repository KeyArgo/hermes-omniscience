import { expect, test } from 'vitest';
import { acknowledge, readAck, signature, unseen } from './ack';

const p = (over: Partial<Parameters<typeof signature>[0]> = {}) => ({
  ts: 1000,
  kind: 'tool.end',
  tool: 'browser_exec',
  error_type: 'Timeout',
  reason: 'the tool ran past its own median',
  ...over,
});

test('the same failure twice is one signature', () => {
  expect(signature(p())).toBe(signature(p({ ts: 2000, event_id: 'other' })));
});

test('a different tool or reason is a different problem', () => {
  expect(signature(p())).not.toBe(signature(p({ tool: 'grep' })));
  expect(signature(p())).not.toBe(signature(p({ reason: 'the model call was rate limited' })));
});

test('acknowledging hides the ones seen, and keeps a repeat after the moment', () => {
  const ack = acknowledge([p()], 5000);
  const seenAgain = unseen([p({ ts: 4000 })], ack);
  expect(seenAgain).toHaveLength(0);
  const repeated = unseen([p({ ts: 6000 })], ack);
  expect(repeated).toHaveLength(1);
  expect(unseen([p({ tool: 'computer_use', ts: 6000 })], ack)).toHaveLength(1);
});

test('a malformed or missing record is treated as "nothing acknowledged"', () => {
  expect(readAck(null)).toBeNull();
  expect(readAck('{"at": "yesterday"}')).toBeNull();
  expect(readAck('not json')).toBeNull();
  expect(unseen([p()], null)).toHaveLength(1);
  expect(readAck(JSON.stringify({ at: 10, sigs: ['x', 3] }))).toEqual({ at: 10, sigs: ['x'] });
});
