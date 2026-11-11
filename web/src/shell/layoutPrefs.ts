import { useCallback, useEffect, useState } from 'react';

export type Preset = 'simple' | 'standard' | 'everything';

export interface PanelDef {
  id: string;
  title: string;
  description: string;
  group: 'Chat' | 'Map & views' | 'Details' | 'Header';
  defaultVisible: Record<Preset, boolean>;
}

export const PANELS: PanelDef[] = [
  {
    id: 'chats',
    title: 'Chat list',
    description: 'Every recorded chat, grouped by day. Pick one to see what happened.',
    group: 'Chat',
    defaultVisible: { simple: false, standard: true, everything: true },
  },
  {
    id: 'status',
    title: 'Status line',
    description: 'The verdict and a one-line summary of the chat, with a stepper through its failures.',
    group: 'Chat',
    defaultVisible: { simple: true, standard: true, everything: true },
  },
  {
    id: 'briefing',
    title: 'Briefing (summary, failures, timeline)',
    description: 'The plain-English summary, each failure with why and what to do, and the event timeline.',
    group: 'Details',
    defaultVisible: { simple: false, standard: false, everything: true },
  },
  {
    id: 'context',
    title: 'Tokens per call chart',
    description: 'How much context each model call re-sent, and where it was compacted.',
    group: 'Map & views',
    // Simple opens on the map. With the chart docked under the status line the canvas was 355 px
    // tall, so the graph could not be fitted and only its newest box was visible.
    defaultVisible: { simple: false, standard: true, everything: true },
  },
  {
    id: 'inspector',
    title: 'Inspector & warnings',
    description: 'Details of the selected step, the warnings found in this chat, and why a run failed.',
    group: 'Details',
    defaultVisible: { simple: false, standard: true, everything: true },
  },
  {
    id: 'legend',
    title: 'Map key',
    description: 'What each colour and shape on the map means.',
    group: 'Map & views',
    defaultVisible: { simple: false, standard: false, everything: true },
  },
  {
    id: 'telemetry',
    title: 'Telemetry strip (events, lost)',
    description: 'The build, event and lost-record counts, and when the facts were last updated.',
    group: 'Header',
    defaultVisible: { simple: false, standard: true, everything: true },
  },
  {
    id: 'replay',
    title: 'Replay controls',
    description: 'Play the chat back step by step, or jump to live.',
    group: 'Map & views',
    defaultVisible: { simple: true, standard: true, everything: true },
  },
  {
    id: 'hints',
    title: 'View hints',
    description: 'One line under the toolbar explaining the current view.',
    group: 'Map & views',
    defaultVisible: { simple: true, standard: false, everything: false },
  },
];

export interface Overrides {
  hidden: string[];
  shown: string[];
}

const EMPTY: Overrides = { hidden: [], shown: [] };

function defaultStore(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function storageKey(preset: Preset): string {
  return `omni.layout.${preset}`;
}

function findPanel(id: string): PanelDef | undefined {
  return PANELS.find((p) => p.id === id);
}

export function isVisible(id: string, preset: Preset, overrides: Overrides): boolean {
  const panel = findPanel(id);
  if (!panel) return false;
  const base = panel.defaultVisible[preset];
  if (overrides.hidden.includes(id)) return false;
  if (overrides.shown.includes(id)) return true;
  return base;
}

export function toggle(id: string, preset: Preset, overrides: Overrides): Overrides {
  const panel = findPanel(id);
  if (!panel) return overrides;
  const base = panel.defaultVisible[preset];
  const currentlyVisible = isVisible(id, preset, overrides);
  const nextVisible = !currentlyVisible;

  const hidden = overrides.hidden.filter((x) => x !== id);
  const shown = overrides.shown.filter((x) => x !== id);

  if (nextVisible === base) {
    return { hidden, shown };
  }
  if (nextVisible) {
    shown.push(id);
  } else {
    hidden.push(id);
  }
  return { hidden, shown };
}

function sanitize(raw: unknown): Overrides {
  if (!raw || typeof raw !== 'object') return { ...EMPTY };
  const obj = raw as Record<string, unknown>;
  const hidden = Array.isArray(obj.hidden)
    ? obj.hidden.filter((x): x is string => typeof x === 'string')
    : [];
  const shown = Array.isArray(obj.shown)
    ? obj.shown.filter((x): x is string => typeof x === 'string')
    : [];
  return { hidden, shown };
}

export function readOverrides(
  preset: Preset,
  storage?: Pick<Storage, 'getItem'>,
): Overrides {
  const store = storage ?? defaultStore();
  if (!store) return { ...EMPTY };
  try {
    const raw = store.getItem(storageKey(preset));
    if (!raw) return { ...EMPTY };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...EMPTY };
  }
}

export function writeOverrides(
  preset: Preset,
  overrides: Overrides,
  storage?: Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>,
): void {
  const store =
    storage ?? defaultStore();
  if (!store || typeof store.setItem !== 'function') return;
  try {
    store.setItem(storageKey(preset), JSON.stringify(overrides));
  } catch {
    // Storage may be full or blocked; preferences just won't persist.
  }
}

export function useLayoutPrefs(preset: Preset): {
  visible: (id: string) => boolean;
  toggle: (id: string) => void;
  reset: () => void;
  overrides: Overrides;
} {
  const [overrides, setOverrides] = useState<Overrides>(() => readOverrides(preset));

  useEffect(() => {
    setOverrides(readOverrides(preset));
  }, [preset]);

  const visible = useCallback(
    (id: string) => isVisible(id, preset, overrides),
    [preset, overrides],
  );

  const togglePanel = useCallback(
    (id: string) => {
      setOverrides((prev) => {
        const next = toggle(id, preset, prev);
        writeOverrides(preset, next);
        return next;
      });
    },
    [preset],
  );

  const reset = useCallback(() => {
    const empty: Overrides = { hidden: [], shown: [] };
    writeOverrides(preset, empty);
    setOverrides(empty);
  }, [preset]);

  return { visible, toggle: togglePanel, reset, overrides };
}
