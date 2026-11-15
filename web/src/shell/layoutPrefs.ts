import { useCallback, useEffect, useRef, useState } from 'react';
import type { InterfaceMode } from './mode';

export type Preset = 'simple' | 'standard' | 'everything';

/**
 * Where a panel layout is remembered. `web` keeps the keys this page has always used, so stored
 * choices survive unchanged; `hermes` gets its own namespace so the docked pane and the browser
 * cannot overwrite each other.
 */
export type PrefScope = InterfaceMode;

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

export function layoutStorageKey(preset: Preset, scope: PrefScope = 'web'): string {
  return scope === 'hermes' ? `omni.hermes.layout.${preset}` : `omni.layout.${preset}`;
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
  scope: PrefScope = 'web',
): Overrides {
  const store = storage ?? defaultStore();
  if (!store) return { ...EMPTY };
  try {
    const raw = store.getItem(layoutStorageKey(preset, scope));
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
  scope: PrefScope = 'web',
): void {
  const store =
    storage ?? defaultStore();
  if (!store || typeof store.setItem !== 'function') return;
  try {
    store.setItem(layoutStorageKey(preset, scope), JSON.stringify(overrides));
  } catch {
    // Storage may be full or blocked; preferences just won't persist.
  }
}

interface HookState {
  preset: Preset;
  scope: PrefScope;
  overrides: Overrides;
}

function freshState(preset: Preset, scope: PrefScope): HookState {
  return { preset, scope, overrides: readOverrides(preset, undefined, scope) };
}

/**
 * Apply one toggle to the stored layout for this preset and scope, reading the latest value first.
 *
 * Each toggle writes the whole overrides object, so writing an in-memory copy from the last render
 * would erase anything another tab (or the other copy of the docked pane) changed in between. The
 * read is deliberately outside React's state updater: a state updater can run twice, and a second
 * read-modify-write would toggle the same panel back.
 *
 * `fallback` is the in-memory layout, used only when storage is readable but not writable (a full
 * or private-mode store). `persisted` says whether the write actually landed, so the caller can
 * keep using memory instead of a store that silently drops every change.
 */
export function toggleStored(
  id: string,
  preset: Preset,
  storage?: Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>,
  scope: PrefScope = 'web',
  fallback?: Overrides,
): { overrides: Overrides; persisted: boolean } {
  const base = fallback ?? readOverrides(preset, storage, scope);
  const next = toggle(id, preset, base);
  writeOverrides(preset, next, storage, scope);
  const persisted =
    JSON.stringify(readOverrides(preset, storage, scope)) === JSON.stringify(next);
  return { overrides: next, persisted };
}

export function useLayoutPrefs(preset: Preset, scope: PrefScope = 'web'): {
  visible: (id: string) => boolean;
  toggle: (id: string) => void;
  reset: () => void;
  overrides: Overrides;
} {
  // The preset and the scope are remembered with the overrides they belong to. Without that
  // identity, a mode switch that keeps the same preset (Simple in both modes) would render one
  // frame against the other mode's layout, and a quick toggle could write it into the wrong key.
  const [state, setState] = useState<HookState>(() => freshState(preset, scope));
  const current = state.preset === preset && state.scope === scope
    ? state.overrides
    : readOverrides(preset, undefined, scope);
  // A readable-but-unwritable store would otherwise make every toggle start from the same stored
  // value, so a panel could be hidden once and never shown again for the life of the page.
  const writesBlocked = useRef(false);

  useEffect(() => {
    setState((previous) => {
      if (previous.preset === preset && previous.scope === scope) return previous;
      return freshState(preset, scope);
    });
  }, [preset, scope]);

  // Another tab showing the same mode knows the same key. Adopt its changes, so the visible
  // layout is the stored one rather than whichever copy rendered last.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = layoutStorageKey(preset, scope);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== key) return;
      let local: Storage | undefined;
      try {
        local = window.localStorage;
      } catch {
        return; // an opaque-origin frame has no shared storage and no events
      }
      if (event.storageArea && local && event.storageArea !== local) return;
      setState({ preset, scope, overrides: readOverrides(preset, undefined, scope) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [preset, scope]);

  const visible = useCallback(
    (id: string) => isVisible(id, preset, current),
    [preset, current],
  );

  const togglePanel = useCallback(
    (id: string) => {
      const result = toggleStored(
        id,
        preset,
        undefined,
        scope,
        writesBlocked.current ? current : undefined,
      );
      writesBlocked.current = !result.persisted;
      setState({ preset, scope, overrides: result.overrides });
    },
    [preset, scope, current],
  );

  const reset = useCallback(() => {
    const empty: Overrides = { hidden: [], shown: [] };
    writeOverrides(preset, empty, undefined, scope);
    writesBlocked.current =
      JSON.stringify(readOverrides(preset, undefined, scope)) !== JSON.stringify(empty);
    setState({ preset, scope, overrides: empty });
  }, [preset, scope]);

  return { visible, toggle: togglePanel, reset, overrides: current };
}
