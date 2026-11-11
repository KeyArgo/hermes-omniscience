import { useMemo } from 'react';
import type { OmniEvent } from '../types';
import { attrsOf } from '../graph/reduce';
import { activityAge } from '../graph/activityAge';

type Activity = { calls: number; failures: number; lastTool: string | null; repeated: number };

export function summarizeActivity(events: OmniEvent[]): Activity {
  const tools = events.filter((event) => event.kind === 'tool.end');
  const latest = tools.at(-1);
  const value = latest && attrsOf(latest).tool_name;
  const lastTool = typeof value === 'string' && value ? value : null;
  let repeated = 0;
  if (lastTool) {
    for (let index = tools.length - 1; index >= 0; index--) {
      if (attrsOf(tools[index]).tool_name !== lastTool) break;
      repeated++;
    }
  }
  return { calls: tools.length, failures: tools.filter((event) => event.status === 'error').length, lastTool, repeated };
}

export function ActivitySummary({ events, partial, nowSeconds }: { events: OmniEvent[]; partial: boolean; nowSeconds: number }) {
  const activity = useMemo(() => summarizeActivity(events), [events]);
  const lastRecorded = useMemo(() => events.reduce<number | null>((latest, event) =>
    Number.isFinite(event.ts) && event.ts > 0 && (latest === null || event.ts > latest) ? event.ts : latest, null), [events]);
  return (
    <div className="activity-summary" aria-label="Recorded activity">
      <strong>Recorded activity{partial ? ' · loaded portion' : ''}</strong>
      <span>{activity.calls.toLocaleString()} tool calls · {activity.failures.toLocaleString()} failures</span>
      <span>Last recorded activity: {activityAge(lastRecorded, nowSeconds)}</span>
      {activity.repeated >= 5 ? (
        <span>Worth checking: {activity.lastTool} was called {activity.repeated} times in a row among recorded tool calls.
          The recorded details do not establish whether the calls were the same or whether work progressed.</span>
      ) : null}
    </div>
  );
}
