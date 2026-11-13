import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from './api';
import { tokenHeaders } from './token';
import { EVENT_PAGE_SIZE, downloadCsv, fetchBuildId, fetchEvents, fetchSessions, fetchVersion, fetchWarnings, liveSubprotocol, liveUrl, normalizeEvent, type BuildInfo } from './api';
import { recoverStaleKey } from './token';
import type { OmniEvent, SessionMeta, Warning } from './types';
import { groupMembers } from './graph/collapse';
import { type Graph, type GNode } from './graph/reduce';
import {
  CONNECTION_TEXT,
  activityAge,
  connectionState,
  pickNewestSession,
} from './graph/format';
import {
  computeRunSummary,
  computeTimeSplit,
  countLostEvents,
  runningNow,
} from './graph/summary';
import { GraphView } from './components/GraphView';
import { ActivitySummary } from './components/ActivitySummary';
import { EventTimeline } from './components/EventTimeline';
import { HelpPanel, markHelpSeen } from './components/HelpPanel';
import { PrivacyAlert } from './components/PrivacyAlert';
import { PrivacyView } from './components/PrivacyView';
import { ConcernsView } from './components/ConcernsView';
import { findPrivacyHit, quietCounts, type PrivacyHit } from './privacy/alert';
import { addDismissed, readDismissed } from './privacy/dismissed';
import { Inspector } from './components/Inspector';
import { Legend } from './components/Legend';
import { ChatSummaryPanel } from './components/ChatSummaryPanel';
import { TimeView } from './components/TimeView';
import { RunList } from './components/RunList';
import { MiniLive } from './components/MiniLive';
import { MiniShell, type MiniView } from './components/MiniShell';
import { PrivacyPanel } from './components/PrivacyPanel';
import { SettingsPanel, type ViewMode, type ViewerSettings } from './components/SettingsPanel';
import { TokensView } from './components/TokensView';
import { UsageView } from './components/UsageView';
import { FollowRail } from './components/FollowRail';
import { ProblemsPanel } from './components/ProblemsPanel';
import { FlameView } from './components/FlameView';
import { ToolsView } from './components/ToolsView';
import { ContextView } from './components/ContextView';
import HelpersView from './components/HelpersView';
import { CoverageView } from './components/CoverageView';
import { LatencyView } from './components/LatencyView';
import { InsightPanel } from './components/InsightPanel';
import { FailurePanel } from './components/FailurePanel';
import { SessionContextStrip } from './components/SessionContextStrip';
import { VerdictHeader } from './components/VerdictHeader';
import { buildVerdict } from './graph/verdict';
import { applyFilter, buildRows } from './graph/rows';
import { ReplayBar, type Speed } from './components/ReplayBar';
import { SessionList } from './components/SessionList';
import { SlowestList } from './components/SlowestList';
import { SummaryBar } from './components/SummaryBar';
import { WarningsPanel, groupWarnings } from './components/WarningsPanel';
import { WhyPanel } from './components/WhyPanel';
import { Seal } from './components/Seal';
import { MenuButton, MenuCheck, MenuItem, MenuLabel, MenuSep } from './components/MenuButton';
import { PanelsSheet } from './components/PanelsSheet';
import { PanelFrame } from './components/PanelFrame';
import { Tour } from './components/Tour';
import { useLayoutPrefs } from './shell/layoutPrefs';
import { TipLayer } from './help/TipLayer';
import guide from './help/guide.json';

function shortRoot(id: string): string {
  return id.length > 26 ? `${id.slice(0, 10)}…${id.slice(-10)}` : id;
}

/** Views behind the "more" menu, so the main switch stays short. The label carries what the view
 *  is for: a menu of six bare nouns asks the reader to open all six to find out. */
const MORE_VIEWS: [ViewMode, string][] = [
  ['flame', 'Flame — where the time went'],
  ['tools', 'Tools — which ones failed'],
  ['context', 'Context — how the prompt grew'],
  ['helpers', 'Helpers — subagents it spawned'],
  ['coverage', 'Coverage — what is recorded'],
  ['latency', 'Latency — who is slow, who refused'],
];

const VIEW_TABS: [ViewMode, string, string][] = [
  ['list', 'List', 'List: one row per message, newest at the bottom; open a row to see its steps.'],
  ['graph', 'Map', 'Map: one chat as a picture — each box is a model call or a tool run, arrows show what led to what. Click a box for its details. Use it to see shape and order (where work branched, looped or stalled); List and Time answer different questions.'],
  ['time', 'Time', 'Time: each bar is one step, as long as it took. Shows waits, rate limits and fallbacks.'],
  ['tokens', 'Tokens', 'Tokens: how much was reused from the cache vs sent fresh, and output speed per model (helpers and background calls too).'],
  ['concerns', 'Concerns', 'Concerns: what deserves attention in the past hour, day or month — browser, desktop, wide sweeps, network, MCP — grouped and counted, with an optional written summary from your own model.'],
  ['privacy', 'Privacy', 'Privacy: every tool run that drove a browser or this desktop, swept many files, called the network or reached an MCP server. Flag one to write a file with the action, the chat and the steps around it.'],
  ['usage', 'Usage', 'Usage: what this machine spent — tokens per day and model, cache, context and cost, over the period you pick.'],
];

/** One sentence saying what you are looking at, shown under the view switch. */
const VIEW_HINTS: Partial<Record<ViewMode, string>> = {
  list: 'One row per step in order: each model call, the tools it ran, and how the turn ended.',
  graph: 'The same steps as boxes — a model call, the tools it triggered, turns folded when they get long.',
  time: 'Every step as a bar as long as it took. Waits, rate limits and fallbacks show as gaps.',
  tokens: 'Chats ranked by the context they carry right now, then one chat call by call.',
  flame: 'Where the time went: long steps and repeated calls make the widest bars.',
  tools: 'Which tools ran, how long each took, and which ones failed.',
  context: 'How the prompt grew call by call, and where a compaction cut it back.',
  helpers: 'Helper agents this chat spawned, and what each one did for it.',
  coverage: 'What the recording holds and what it is missing, by event kind.',
};

/** ?mini=1: the narrow live pane docked next to a Hermes chat. */
const mini = (() => {
  try {
    return new URLSearchParams(window.location.search).get('mini') === '1';
  } catch {
    return false;
  }
})();

const embedded = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

/** How much of the interface is on show. One control, three answers, remembered. */
export type Preset = 'simple' | 'standard' | 'everything';

function readPreset(): Preset {
  try {
    const stored = window.localStorage.getItem('omni.preset');
    if (stored === 'simple' || stored === 'standard' || stored === 'everything') return stored;
  } catch {
    /* storage unavailable */
  }
  return 'simple';
}

function readPersistedBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writePersistedBool(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** The chip's own line: product, runtime version, commit date and short commit. Every value is
 *  read from the running viewer, so the chip can never announce a version it is not. */
export function versionChipText(build: BuildInfo): string {
  return `v${build.version} · ${(build.commit_date || '').slice(0, 10)} · ${build.commit_short}`;
}

/** The tooltip: the runtime metadata, and a note when the installed copy has local changes. */
export function versionChipTitle(build: BuildInfo): string {
  return `${build.version}${build.channel === 'dev' ? ' — pre-release build of ' + (build.release ?? '') : ''}${
    build.dirty ? ' (uncommitted changes in the installed copy)' : ''
  }\nCommit ${build.commit.slice(0, 12)} · ${(build.commit_date || '').slice(0, 10)}\nBuilt ${
    build.built_at || 'unknown'
  }\nClick to copy this line for a bug report.`;
}

/** The build chip. Shown in every full-viewer layout, whatever the telemetry preference: it is the
 *  only place the running version appears, and the line a bug report asks for. Nothing is shown
 *  until the viewer answers with its build, and no value is compiled in. */
export function VersionChip({
  build,
  onCopy,
}: {
  build: BuildInfo | null;
  onCopy: (line: string) => void;
}) {
  if (!build) return null;
  const line = versionChipText(build);
  return (
    <button
      type="button"
      className={`version-chip mono${build.dirty ? ' is-dirty' : ''}`}
      title={versionChipTitle(build)}
      onClick={() => onCopy(line)}
    >
      {line}
      {build.dirty ? ' · modified' : ''}
    </button>
  );
}

/** The header's version chip and the optional telemetry counts that share its row. The chip is not
 *  behind the telemetry toggle; Events/Lost (and the replay badge) still are. */
export function TelemetryStrip({
  build,
  telemetryVisible,
  events,
  lost,
  replayIndex,
  visibleCount,
  onCopyVersion,
}: {
  build: BuildInfo | null;
  telemetryVisible: boolean;
  events: number;
  lost: number;
  replayIndex: number | null;
  visibleCount: number;
  onCopyVersion: (line: string) => void;
}) {
  return (
    <>
      <VersionChip build={build} onCopy={onCopyVersion} />
      {telemetryVisible ? (
        <div className="telemetry" data-panel="telemetry">
          <span
            className="metric"
            title="Number of recorded steps loaded for this conversation, including helper agents."
          >
            Events <b className="mono">{events}</b>
          </span>
          <span
            className="metric"
            title="Lost: steps the recorder had to skip because it fell behind. The map shows where."
          >
            Lost <b className={`mono ${lost > 0 ? 'warn-text' : ''}`}>{lost}</b>
          </span>
          {replayIndex !== null ? (
            <span
              className="replay-badge mono"
              title="You are watching a replay: the map redraws recorded steps, from the beginning up to here. Nothing is re-run."
            >
              REPLAY {visibleCount}/{events}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * The writeup chip. It names what the panel shows, and says where the model call happens: the
 * viewer cannot ask a model — it holds no Hermes credential, by design — so the report is
 * written inside Hermes with `/omni insight` and this panel reads it back.
 */
export function WriteupChip({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="chip ask-model"
      onClick={onOpen}
      title="The writeup: Hermes reads this recording — tokens, timings, rate limits, context growth — with the model you already use (/omni insight) and writes what to fix. Metadata only."
    >
      Writeup
    </button>
  );
}

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  // What the CSV export did, said out loud: a silent download is indistinguishable from a broken one.
  const [exportNote, setExportNote] = useState<string | null>(null);
  // The viewer can be updated underneath an open tab. Its bundle is immutable and this page
  // keeps running the old one until it is reloaded, so say so rather than look wrong.
  const [staleBuild, setStaleBuild] = useState(false);
  // Which build is answering. Read from the viewer, never compiled in, so the chip cannot
  // announce a version other than the one installed.
  const [build, setBuild] = useState<BuildInfo | null>(null);
  // Folded by default: the summary is one line until someone wants the whole read.
  const [chatSummaryOpen, setChatSummaryOpen] = useState(false);

  useEffect(() => {
    void fetchVersion().then(setBuild);
  }, []);

  useEffect(() => {
    let loadedBuild: string | null = null;
    let stopped = false;
    const check = async () => {
      const build = await fetchBuildId();
      if (stopped || !build) return;
      if (loadedBuild === null) loadedBuild = build;
      else if (build !== loadedBuild) setStaleBuild(true);
    };
    void check();
    const timer = window.setInterval(() => void check(), 60_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  // A viewer key that rotated under this tab answers 401 to everything. Reload once so the
  // page gets the key the viewer now writes into it, rather than leaving a dead screen that
  // asks the user to go hunting for a fresh /omni link.
  useEffect(() => {
    if (sessionsError && sessionsError.startsWith('401')) recoverStaleKey();
  }, [sessionsError]);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);

  const [events, setEvents] = useState<OmniEvent[]>([]);
  const eventsRef = useRef<OmniEvent[]>([]);
  const rootRef = useRef<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierExhausted, setEarlierExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [socketOpen, setSocketOpen] = useState(false);
  const [eventsFetchFailed, setEventsFetchFailed] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [nowSec, setNowSec] = useState(() => Date.now() / 1000);

  // The live socket is one source of "when was the last event"; the session list polled every
  // few seconds is another. Without the second, a dropped socket makes a busy chat read
  // "No recent activity" for as long as the reconnect backoff lasts — which looks like the
  // recorder stopped.
  const selectedLastTs = (() => {
    const row = selectedRoot ? sessions.find((candidate) => candidate.id === selectedRoot) : undefined;
    return typeof row?.last_ts === 'number' ? row.last_ts : null;
  })();
  const freshest = Math.max(lastEventAt ?? 0, selectedLastTs ?? 0);
  const connection = connectionState({
    socketOpen,
    fetchFailing: sessionsError !== null || eventsFetchFailed,
    lastEventAt: freshest > 0 ? freshest : null,
    now: nowSec,
  });
  const connectionText = CONNECTION_TEXT[connection];
  const ageText = freshest > 0 ? activityAge(nowSec - freshest) : '';
  const isLive = connection === 'live';

  useEffect(() => {
    const timer = window.setInterval(() => setNowSec(Date.now() / 1000), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const [replayIndex, setReplayIndexState] = useState<number | null>(null);
  const replayRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set());

  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [hideTools, setHideTools] = useState(false);
  const [hideLlms, setHideLlms] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);

  const [helpOpen, setHelpOpen] = useState(false);
  const [insightOpen, setInsightOpen] = useState(false);
  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    markHelpSeen();
  }, []);

  const [focusToken, setFocusToken] = useState(0);
  const [resetToken, setResetToken] = useState(0);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() => readPersistedBool('omni.leftCollapsed', embedded));
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() => readPersistedBool('omni.rightCollapsed', embedded));
  const [compact, setCompact] = useState<boolean>(() => readPersistedBool('omni.compact', embedded));
  const [preset, setPreset] = useState<Preset>(readPreset);
  const prefs = useLayoutPrefs(preset);
  const [panelsOpen, setPanelsOpen] = useState(false);
  // Two ways to read the same chat: the timeline the map has always drawn, and a link web.
  const [linkView, setLinkView] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('omni.mapStyle') === 'links';
    } catch {
      return false;
    }
  });
  const chooseMapStyle = (links: boolean) => {
    setLinkView(links);
    try {
      window.localStorage.setItem('omni.mapStyle', links ? 'links' : 'timeline');
    } catch {
      /* storage unavailable */
    }
  };
  const [tourNonce, setTourNonce] = useState(0);
  const [railTab, setRailTab] = useState<'inspect' | 'warnings' | 'why'>('warnings');

  useEffect(() => {
    try {
      window.localStorage.setItem('omni.preset', preset);
    } catch {
      /* storage unavailable */
    }
  }, [preset]);
  const chatsVisible = prefs.visible('chats');
  const inspectorVisible = prefs.visible('inspector');
  useEffect(() => setLeftCollapsed(!chatsVisible), [chatsVisible]);
  useEffect(() => setRightCollapsed(!inspectorVisible), [inspectorVisible]);
  const setChatsShown = (show: boolean) => {
    setLeftCollapsed(!show);
    writePersistedBool('omni.leftCollapsed', !show);
    if (show !== chatsVisible) prefs.toggle('chats');
  };
  const setInspectorShown = (show: boolean) => {
    setRightCollapsed(!show);
    writePersistedBool('omni.rightCollapsed', !show);
    if (show !== inspectorVisible) prefs.toggle('inspector');
  };
  const isView = (value: unknown): value is ViewMode =>
    typeof value === 'string' &&
    ['list', 'graph', 'time', 'tokens', 'usage', ...MORE_VIEWS.map(([m]) => m)].includes(value);
  const [defaultView, setDefaultView] = useState<ViewMode>(() => {
    try {
      const saved = window.localStorage.getItem('omni.defaultView');
      if (isView(saved)) return saved;
    } catch {
      /* storage unavailable */
    }
    return 'graph';
  });
  const [view, setView] = useState<ViewMode>(() => {
    try {
      // ?view=usage is how /omni tokens lands here: a deep link, so the page a chat command
      // points at is the page that opens.
      const requested = new URLSearchParams(window.location.search).get('view');
      if (isView(requested)) return requested;
    } catch {
      /* storage unavailable */
    }
    try {
      const saved = window.localStorage.getItem('omni.view');
      if (isView(saved)) return saved;
    } catch {
      /* storage unavailable */
    }
    return defaultView;
  });
  const [showTitles, setShowTitles] = useState<boolean>(() => readPersistedBool('omni.showTitles', true));
  // The context-per-call chart under each chat is a lens, not a default view: on
  // by default, one switch off for people who want the map and nothing else.
  const [showContext, setShowContext] = useState<boolean>(() => readPersistedBool('omni.showContext', true));
  // Two faces for the same data: the console (default) and the warm paper one.
  const [theme, setTheme] = useState<'console' | 'paper'>(() => {
    try {
      return window.localStorage.getItem('omni.theme') === 'paper' ? 'paper' : 'console';
    } catch {
      return 'console';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Side-pane view (List / Context / Tools / Tokens / Time), remembered per browser.
  const [miniView, setMiniView] = useState<MiniView>(() => {
    try {
      const saved = window.localStorage.getItem('omni.miniView');
      if (saved === 'live' || saved === 'context' || saved === 'tools' || saved === 'tokens' || saved === 'time') return saved;
    } catch {
      /* storage unavailable */
    }
    return 'live';
  });
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [followNewest, setFollowNewest] = useState<boolean>(() => readPersistedBool('omni.followNewest', false));
  // What the right frame shows: the usual details, or only what the user follows.
  const [railMode, setRailMode] = useState<'details' | 'follow'>(() => {
    try {
      return window.localStorage.getItem('omni.railMode') === 'follow' ? 'follow' : 'details';
    } catch {
      return 'details';
    }
  });

  const setReplay = useCallback((index: number | null) => {
    replayRef.current = index;
    setReplayIndexState(index);
  }, []);

  const appendEvents = useCallback((incoming: OmniEvent[]) => {
    if (incoming.length === 0) return;
    setEvents((previous) => {
      const seen = new Set(previous.map((event) => event.rowid));
      const merged = [...previous];
      for (const event of incoming) {
        if (!seen.has(event.rowid)) {
          seen.add(event.rowid);
          merged.push(event);
        }
      }
      merged.sort((a, b) => a.rowid - b.rowid);
      if (merged.length === previous.length) return previous;
      eventsRef.current = merged;
      return merged;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const list = await fetchSessions();
        if (cancelled) return;
        setSessions(list);
        setSessionsError(null);
        const newest = pickNewestSession(list);
        // /omni links open the calling chat via ?session=<id>; unknown ids fall back to newest.
        const requested = new URLSearchParams(window.location.search).get('session');
        // Keep the chat the user came from even when nothing is recorded for it yet (it may have
        // started before Omniscience was on); the stage explains that instead of showing another chat.
        const linked = requested || null;
        setSelectedRoot((previous) => previous ?? linked ?? newest?.id ?? null);
      } catch (error) {
        if (cancelled) return;
        setSessionsError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedRoot) {
      setSocketOpen(false);
      setEventsFetchFailed(false);
      setLastEventAt(null);
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let attempt = 0;

    rootRef.current = selectedRoot;
    setEarlierExhausted(false);
    setLoadingEarlier(false);
    setLoading(true);
    setPlaying(false);
    setSelectedNodeId(null);
    setReplay(null);
    setSocketOpen(false);
    setEventsFetchFailed(false);
    setLastEventAt(null);
    eventsRef.current = [];
    setEvents([]);

    const connect = () => {
      if (closed || !selectedRoot) return;
      const after = eventsRef.current.reduce((max, event) => Math.max(max, event.rowid), 0);
      socket = new WebSocket(liveUrl(selectedRoot, after), liveSubprotocol() ? [liveSubprotocol()!] : []);

      socket.onopen = () => {
        attempt = 0;
        if (!closed) setSocketOpen(true);
      };

      socket.onmessage = (message) => {
        if (closed) return;
        let payload: unknown;
        try {
          payload = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (!payload || typeof payload !== 'object') return;
        const record = payload as Record<string, unknown>;
        if (record.type === 'heartbeat') {
          setSocketOpen(true);
          return;
        }
        if (record.type === 'events' && Array.isArray(record.events)) {
          const normalized = record.events
            .map(normalizeEvent)
            .filter((event): event is OmniEvent => event !== null);
          const latestRecorded = normalized.reduce(
            (latest, event) => Number.isFinite(event.ts) ? Math.max(latest, event.ts) : latest,
            0,
          );
          if (latestRecorded > 0) setLastEventAt(previous => Math.max(previous ?? 0, latestRecorded));
          appendEvents(normalized);
        }
      };

      socket.onclose = () => {
        if (closed) return;
        setSocketOpen(false);
        const delay = Math.min(15000, 500 * 2 ** attempt);
        attempt += 1;
        retryTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    fetchEvents(selectedRoot, 0)
      .then((loaded) => {
        if (closed) return;
        eventsRef.current = loaded;
        setEvents(loaded);
        const latest = loaded.reduce(
          (max, event) => (Number.isFinite(event.ts) ? Math.max(max, event.ts) : max),
          0,
        );
        setLastEventAt(latest > 0 ? latest : null);
        setEventsFetchFailed(false);
        setLoading(false);
        connect();
      })
      .catch(() => {
        if (closed) return;
        eventsRef.current = [];
        setEvents([]);
        setLastEventAt(null);
        setEventsFetchFailed(true);
        setLoading(false);
        connect();
      });

    return () => {
      closed = true;
      rootRef.current = null;
      setSocketOpen(false);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [selectedRoot, appendEvents, setReplay]);

  useEffect(() => {
    if (!selectedRoot) {
      setWarnings([]);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      const list = await fetchWarnings(selectedRoot);
      if (cancelled) return;
      if (list.length > 0 || !isLive) setWarnings(list);
    };

    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedRoot, isLive]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const total = eventsRef.current.length;
      const current = replayRef.current ?? 0;
      const next = Math.min(current + speed, total);
      if (next >= total) {
        setReplay(null);
        setPlaying(false);
      } else {
        setReplay(next);
      }
    }, 400);
    return () => window.clearInterval(timer);
  }, [playing, speed, setReplay]);

  const visibleEvents = useMemo(
    () => (replayIndex === null ? events : events.slice(0, replayIndex)),
    [events, replayIndex],
  );
  // Something is driving a browser or this desktop, or sweeping the disk. Find the newest such
  // step in the chat on screen; it stays up until dismissed or the chat moves on.
  const [privacyOff, setPrivacyOff] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('omni.privacyAlerts') === 'off';
    } catch {
      return false;
    }
  });
  // Settings writes the switch; this picks the change up without a reload.
  useEffect(() => {
    const sync = () => {
      try {
        setPrivacyOff(window.localStorage.getItem('omni.privacyAlerts') === 'off');
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener('omni:privacy', sync);
    return () => window.removeEventListener('omni:privacy', sync);
  }, []);
  // Kept in storage, not in memory: a dismissal that came back on the next reload read as a
  // broken button.
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed());
  const [stopNote, setStopNote] = useState<string | null>(null);
  const privacy = useMemo<PrivacyHit | null>(() => {
    if (privacyOff) return null;
    return findPrivacyHit(visibleEvents, Date.now() / 1000);
  }, [visibleEvents, privacyOff]);
  const quiet = useMemo(
    () => (privacyOff ? { network: 0, mcp: 0 } : quietCounts(visibleEvents, Date.now() / 1000)),
    [visibleEvents, privacyOff],
  );
  const riskActive = privacy !== null && !dismissed.includes(privacy.id);
  const dismissPrivacy = (id: string) => setDismissed(addDismissed(id));
  useEffect(() => {
    if (!stopNote) return;
    const timer = window.setTimeout(() => setStopNote(null), 8000);
    return () => window.clearTimeout(timer);
  }, [stopNote]);
  const flagChat = async () => {
    if (!selectedRoot) return;
    const eventId = privacy?.id ?? null;
    if (privacy) dismissPrivacy(privacy.id);
    setStopNote('Flagging this chat…');
    try {
      const response = await fetch(`${API_BASE}/privacy/flag`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...tokenHeaders() },
        body: JSON.stringify({ session_id: selectedRoot, event_id: eventId }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; flag?: string; detail?: string }
        | null;
      if (!response.ok || !body?.ok) {
        const detail = typeof body?.detail === 'string' ? body.detail : null;
        setStopNote(detail ?? `The viewer answered ${response.status}.`);
        return;
      }
      setStopNote(`Flagged: ${body.flag}. The action, this chat and the steps around it are in the file.`);
    } catch {
      setStopNote('Could not reach the viewer to flag this chat.');
    }
  };

  // Cancel obsolete computations and bound the graph before layout.
  const [computed, setComputed] = useState<{ fullGraph: Graph; baseGraph: Graph; graph: Graph; truncated: number }>({
    fullGraph: { nodes: [], edges: [] }, baseGraph: { nodes: [], edges: [] },
    graph: { nodes: [], edges: [] }, truncated: 0,
  });
  useEffect(() => {
    const worker = new Worker(new URL('./graph/graph.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (message: MessageEvent<typeof computed>) => setComputed(message.data);
    const timer = window.setTimeout(() => {
      worker.postMessage({ events: visibleEvents, expanded: [...expandedTurnIds], hideTools, hideLlms, errorsOnly });
    }, 100);
    return () => { window.clearTimeout(timer); worker.terminate(); };
  }, [visibleEvents, expandedTurnIds, hideTools, hideLlms, errorsOnly]);
  const { fullGraph, baseGraph, graph, truncated } = computed;

  const selectedNode = useMemo(
    () => baseGraph.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [baseGraph.nodes, selectedNodeId],
  );

  const expandTurn = useCallback((turnId: string) => {
    setExpandedTurnIds((previous) => new Set(previous).add(turnId));
  }, []);

  const foldTurn = useCallback((turnId: string) => {
    setExpandedTurnIds((previous) => {
      const next = new Set(previous);
      next.delete(turnId);
      return next;
    });
  }, []);

  /**
   * Select a node; when it lives inside a collapsed group, expand that group
   * first (the collapse re-run then exposes the node) and select it.
   */
  const selectNodeDeep = useCallback(
    (nodeId: string | null) => {
      if (nodeId === null) {
        setSelectedNodeId(null);
        return;
      }
      setRailTab('inspect');
      setRailMode('details');
      setRightCollapsed(false);
      const owner = baseGraph.nodes.find((node) => {
        if (node.id !== `group:${nodeId}` && node.type !== 'group') return false;
        return groupMembers(baseGraph, node.id).includes(nodeId);
      });
      const target = owner ? groupMembers(baseGraph, owner.id).includes(nodeId) ? owner : null : null;
      const turnId =
        target && typeof target.data.turn_id === 'string'
          ? target.data.turn_id
          : typeof (baseGraph.nodes.find((node) => node.id === nodeId)?.data.turn_id) === 'string'
            ? (baseGraph.nodes.find((node) => node.id === nodeId)?.data.turn_id as string)
            : null;
      if (turnId) expandTurn(turnId);
      setSelectedNodeId(nodeId);
      setFocusToken((token) => token + 1);
    },
    [baseGraph, expandTurn],
  );

  const summary = useMemo(() => computeRunSummary(visibleEvents), [visibleEvents]);
  // Only the chat's own calls get a chart; helpers and background calls have their
  // own little contexts and would turn the line into noise.
  const contextCalls = useMemo(
    () =>
      visibleEvents.filter(
        (ev) => ev.kind === 'llm.request' && (!selectedRoot || ev.session_id === selectedRoot)
      ).length,
    [visibleEvents, selectedRoot]
  );
  const split = useMemo(() => computeTimeSplit(visibleEvents), [visibleEvents]);
  const nowStep = useMemo(() => runningNow(visibleEvents), [visibleEvents]);
  const lost = useMemo(() => countLostEvents(events), [events]);

  const [nowTs, setNowTs] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!summary.isRunning) return;
    setNowTs(Date.now() / 1000);
    const timer = window.setInterval(() => setNowTs(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [summary.isRunning]);

  const failedNodes = useMemo(
    () => graph.nodes.filter((node: GNode) => node.status === 'error'),
    [graph.nodes],
  );

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectNonce, setSelectNonce] = useState(0);
  const onSelectEvent = useCallback(
    (eventId: string) => {
      setSelectedEventId(eventId);
      setSelectNonce((n) => n + 1);
      setRightCollapsed(false);
      const node = baseGraph.nodes.find((candidate) => candidate.eventIds.includes(eventId));
      if (node) selectNodeDeep(node.id);
      return Boolean(node);
    },
    [baseGraph.nodes, selectNodeDeep],
  );

  const failureEventIds = useMemo(
    () =>
      visibleEvents
        .filter((e) => e.kind === 'llm.error' || (e.kind === 'tool.end' && e.status && e.status !== 'ok'))
        .map((e) => e.event_id),
    [visibleEvents],
  );
  const stepFailure = (direction: 1 | -1) => {
    if (failureEventIds.length === 0) return;
    const at = selectedEventId ? failureEventIds.indexOf(selectedEventId) : -1;
    const next = at === -1
      ? (direction === 1 ? 0 : failureEventIds.length - 1)
      : (at + direction + failureEventIds.length) % failureEventIds.length;
    onSelectEvent(failureEventIds[next]);
  };
  const onNextError = () => stepFailure(1);
  const onPrevError = () => stepFailure(-1);

  const onTogglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (events.length === 0) return;
    if (replayRef.current === null) setReplay(0);
    setPlaying(true);
  };

  const onIndex = (index: number | null) => {
    setPlaying(false);
    setReplay(index);
  };

  const onLive = () => {
    setPlaying(false);
    setReplay(null);
  };

  const visibleCount = visibleEvents.length;
  const selectedSession = sessions.find((session) => session.id === selectedRoot);
  const loadEarlier = async () => {
    const root = selectedRoot;
    const first = eventsRef.current[0]?.rowid;
    if (!root || first === undefined || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const earlier = await fetchEvents(root, 0, first);
      if (rootRef.current !== root) return;
      if (earlier.length < EVENT_PAGE_SIZE) setEarlierExhausted(true);
      appendEvents(earlier);
    } catch {
      if (rootRef.current === root) setEventsFetchFailed(true);
    } finally {
      if (rootRef.current === root) setLoadingEarlier(false);
    }
  };

  const onSelectSession = (id: string) => {
    setSelectedRoot(id);
    setSessionsOpen(false);
  };

  const chooseView = (mode: ViewMode) => {
    setView(mode);
    try {
      window.localStorage.setItem('omni.view', mode);
    } catch {
      /* storage unavailable */
    }
  };

  const exportCsv = (choice: string) => {
    const [table, scope] = choice.split(':') as ['steps' | 'chats' | 'models', string];
    setExportNote('Preparing the CSV…');
    void downloadCsv(table, scope === 'chat' ? selectedRoot : null)
      .then((result) => {
        setExportNote(`Saved ${result.name}`);
        window.setTimeout(() => setExportNote(null), 6000);
      })
      .catch(() => {
        setExportNote(null);
        window.alert('Export failed: the viewer could not be reached. Try again in a moment.');
      });
  };

  /**
   * Put the view back the way it started.
   *
   * Anyone can end up with every panel folded, an odd zoom, filters on and a
   * remembered chat. This forgets the saved view settings, restores the
   * defaults, and re-frames the map. It never touches the recording.
   */
  // The tour teaches the screen, so it starts from the screen's defaults: a tour that begins on a
  // layout the reader has hacked away at points at panels that are not there.
  const startTour = () => {
    resetView();
    setTourNonce((n) => n + 1);
  };

  const resetView = () => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        // Keep the reader's own choices that are not part of the layout: whether privacy alerts
        // are on, and the tour having been seen. Clearing these turned alerts back on behind the
        // Settings checkbox and left the screen showing a setting that was no longer stored.
        if (key && key.startsWith('omni.') && key !== 'omni.tourSeen' && key !== 'omni.privacyAlerts') keys.push(key);
      }
      for (const key of keys) window.localStorage.removeItem(key);
    } catch {
      /* storage unavailable: still reset what is on screen */
    }
    prefs.reset();
    setPreset('simple');
    setCompact(embedded);
    setLeftCollapsed(embedded);
    setRightCollapsed(embedded);
    setShowTitles(true);
    setFollowNewest(false);
    setTheme('console');
    setLinkView(false);
    window.dispatchEvent(new Event('omni:privacy'));
    setShowContext(true);
    setDefaultView('graph');
    setView('graph');
    setHideTools(false);
    setHideLlms(false);
    setErrorsOnly(false);
    setSessionsOpen(false);
    setSelectedNodeId(null);
    setExpandedTurnIds(new Set());
    setReplay(null);
    setPlaying(false);
    setRailMode('details');
    setFocusToken(0);
    setResetToken((token) => token + 1);
    setSettingsOpen(false);
  };

  const viewerSettings: ViewerSettings = { defaultView, compact, followNewest, showTitles, theme, showContext };
  const applySettings = (next: ViewerSettings) => {
    setDefaultView(next.defaultView);
    setCompact(next.compact);
    setFollowNewest(next.followNewest);
    setShowTitles(next.showTitles);
    setTheme(next.theme);
    setShowContext(next.showContext);
    writePersistedBool('omni.compact', next.compact);
    writePersistedBool('omni.followNewest', next.followNewest);
    writePersistedBool('omni.showTitles', next.showTitles);
    writePersistedBool('omni.showContext', next.showContext);
    try {
      window.localStorage.setItem('omni.theme', next.theme);
      window.localStorage.setItem('omni.defaultView', next.defaultView);
    } catch {
      /* storage unavailable */
    }
  };
  const toggleFullscreen = () => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } catch {
      /* fullscreen not allowed here */
    }
  };
  // Titles can hold the start of what the user typed: hide them when asked (e.g. screen sharing).
  const shownSessions = useMemo(
    () => (showTitles ? sessions : sessions.map((session) => ({ ...session, label: null }))),
    [sessions, showTitles],
  );

  // "Follow newest": like a packet capture, jump to whichever chat is working right now.
  useEffect(() => {
    if (!followNewest || sessions.length === 0) return;
    const nowS = Date.now() / 1000;
    const active = sessions
      .filter((session) => session.last_ts && nowS - session.last_ts < 60)
      .sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0))[0];
    if (active && active.id !== selectedRoot) setSelectedRoot(active.id);
  }, [followNewest, sessions, selectedRoot]);

  // "Lost events" markers are recorder-wide, not part of any chat: a chat with only those is not recorded.
  const notRecorded = !events.some((event) => event.kind !== 'omni.dropped');
  const verdict = useMemo(() => buildVerdict(visibleEvents, nowSec), [visibleEvents, nowSec]);
  const rows = useMemo(
    () => applyFilter(buildRows(visibleEvents, nowSec), { hideTools, hideLlms, errorsOnly }),
    [visibleEvents, nowSec, hideTools, hideLlms, errorsOnly],
  );

  // Spelled out next to the product name: "what am I watching" is a status, not a setting you
  // have to go and look up in a menu.
  const modeLabel = followNewest ? 'following newest' : leftCollapsed ? 'this chat only' : 'all chats';
  const modeBlurb = followNewest
    ? 'Following newest: the map jumps to whichever chat is working and keeps the newest step in view.'
    : leftCollapsed
      ? 'Watching one chat: the list is hidden. Press all chats to see every recorded chat.'
      : 'Watching all chats: the list is open and you pick which one to follow.';

  if (mini) {
    const fullUrl = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('mini');
      return url.toString();
    };
    const chooseMiniView = (next: MiniView) => {
      setMiniView(next);
      try {
        window.localStorage.setItem('omni.miniView', next);
      } catch {
        /* storage unavailable */
      }
    };
    return (
      <div className="app app-mini">
        <MiniShell
          sessions={shownSessions}
          selectedId={selectedRoot}
          onSelectSession={(id) => setSelectedRoot(id)}
          view={miniView}
          onView={chooseMiniView}
          nowTs={nowSec}
        >
          <SessionContextStrip
            session={shownSessions.find((candidate) => candidate.id === selectedRoot) ?? null}
            events={visibleEvents}
          />
          {miniView === 'context' ? (
            <ContextView events={visibleEvents} rootSessionId={selectedRoot} onSelectEvent={onSelectEvent} compact />
          ) : miniView === 'tools' ? (
            <ToolsView events={visibleEvents} rootSessionId={selectedRoot} onSelectEvent={onSelectEvent} />
          ) : miniView === 'tokens' ? (
            <TokensView
              events={visibleEvents}
              rootSessionId={selectedRoot}
              chats={shownSessions}
              onSelectEvent={onSelectEvent}
              onSelectChat={(id) => setSelectedRoot(id)}
            />
          ) : miniView === 'time' ? (
            <TimeView events={visibleEvents} nowTs={nowSec} onSelectEvent={onSelectEvent} />
          ) : (
            <MiniLive
              verdict={verdict}
              rows={rows}
              nowTs={nowSec}
              live={connection === 'live'}
              onOpenFull={() => {
                try {
                  window.parent.postMessage({ type: 'omniscience:open-full', session: selectedRoot }, '*');
                } catch {
                  /* not embedded */
                }
              }}
              onOpenBrowser={() => {
                try {
                  window.parent.postMessage({ type: 'omniscience:open-external', url: fullUrl() }, '*');
                } catch {
                  window.open(fullUrl(), '_blank', 'noopener');
                }
              }}
              onSelectEvent={onSelectEvent}
            />
          )}
        </MiniShell>
      </div>
    );
  }

  // Account-level pages (Usage, Latency) describe the whole machine, not the chat that happens to
  // be open: they take the full width, own their scrolling, and suppress the chat-scoped
  // furniture (verdict, failure nav, summary toggle, context chart) that would otherwise sit on
  // top of them and squeeze the page into a 320px strip.
  const accountView = view === 'usage' || view === 'latency' || view === 'privacy' || view === 'concerns';
  // Single-key shortcuts; never while typing, never with a modifier, never over an open dialog.
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcutRef.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    // A modal is open: the sheet traps Tab, but a click on its backdrop moves focus out of the
    // dialog and the single-key shortcuts would then act on the page behind it.
    if (panelsOpen || helpOpen) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
    const index = ['1', '2', '3', '4', '5'].indexOf(event.key);
    if (index >= 0) chooseView(VIEW_TABS[index][0]);
    else if (event.key === '[') onPrevError();
    else if (event.key === ']') onNextError();
    else if (event.key === 'b' && !accountView && selectedRoot) prefs.toggle('briefing');
    else if (event.key === 'p') setPanelsOpen(true);
    else if (event.key === '?') setHelpOpen(true);
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => shortcutRef.current(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const briefingOpen = prefs.visible('briefing');
  const warningGroups = useMemo(() => groupWarnings(warnings).length, [warnings]);

  return (
    <div className={`app ${compact ? 'is-compact' : ''} preset-${preset} ${accountView ? 'is-account' : ''}${riskActive ? ' is-privacy' : ''}`}>
      {riskActive ? <div className="privacy-glow" aria-hidden="true" /> : null}
      {stopNote ? (
        <div className="privacy-note-toast" role="status">
          {stopNote}
          <button type="button" className="pnt-x" onClick={() => setStopNote(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}
      <HelpPanel open={helpOpen} onClose={closeHelp} />
      <InsightPanel open={insightOpen} onClose={() => setInsightOpen(false)} />
      <SettingsPanel
        open={settingsOpen}
        settings={viewerSettings}
        onChange={applySettings}
        onOpenPrivacy={() => {
          setSettingsOpen(false);
          setPrivacyOpen(true);
        }}
        onResetView={resetView}
        onClose={() => setSettingsOpen(false)}
      />
      <PrivacyPanel open={privacyOpen} onClose={() => setPrivacyOpen(false)} dbPath={null} />
      <PanelsSheet
        open={panelsOpen}
        onClose={() => setPanelsOpen(false)}
        preset={preset}
        onPreset={setPreset}
        prefs={prefs}
      />
      <Tour forceStart={tourNonce} onClose={markHelpSeen} />
      <TipLayer extra={guide.tips} />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Seal size={30} />
          </span>
          <span className="brand-name">OMNISCIENCE</span>
          <span className="brand-sub">Every run, made legible</span>
          <span className={`brand-status${followNewest ? ' is-following' : ''}`} title={modeBlurb}>
            · {modeLabel}
          </span>
          <button
            type="button"
            className="sessions-toggle"
            aria-expanded={sessionsOpen}
            onClick={() => setSessionsOpen((value) => !value)}
            title="Show/hide the conversation list."
          >
            Sessions
          </button>
        </div>
        <div className="top-metrics">
          <span
            className={`live-badge is-${connection}`}
            title={`${connectionText.tooltip}${ageText ? ` Last event ${ageText}.` : ''}`}
          >
            <span className="live-dot" />
            {connectionText.label}
            {ageText ? <span className="live-age">· {ageText}</span> : null}
          </span>
          <TelemetryStrip
            build={build}
            telemetryVisible={prefs.visible('telemetry')}
            events={events.length}
            lost={lost}
            replayIndex={replayIndex}
            visibleCount={visibleCount}
            onCopyVersion={(line) => {
              void navigator.clipboard?.writeText(line);
              setExportNote('Version copied');
            }}
          />
          {/* The two ways to change what you are watching, side by side where they can be found. */}
          <div className="mode-switch" role="group" aria-label="What you are watching">
            <button
              type="button"
              className={`chip ${followNewest ? 'is-active' : ''}`}
              aria-pressed={followNewest}
              onClick={() => {
                setFollowNewest((value) => {
                  writePersistedBool('omni.followNewest', !value);
                  return !value;
                });
              }}
              title="Follow newest: jump to whichever chat is working right now and keep the newest step in view."
            >
              {followNewest ? '● Following' : 'Follow Newest'}
            </button>
            <button
              type="button"
              className={`all-chats ${leftCollapsed ? '' : 'is-active'}`}
              aria-expanded={!leftCollapsed}
              onClick={() => {
                setChatsShown(leftCollapsed);
                setSessionsOpen((value) => !value);
              }}
              title="Show every recorded chat, not just this one."
            >
              {leftCollapsed ? '⤢ All Chats' : '⤡ This Chat Only'}
            </button>
          </div>
          {embedded ? (
            <a
              className="popout-link"
              href={window.location.href}
              target="_blank"
              rel="noopener noreferrer"
              title="Open this view in your web browser for more room."
              onClick={(event) => {
                // Hermes desktop blocks new windows from embedded pages; ask the host page instead.
                try {
                  window.parent.postMessage({ type: 'omniscience:open-external', url: window.location.href }, '*');
                  event.preventDefault();
                } catch {
                  /* fall back to the plain link */
                }
              }}
            >
              Open in Browser ↗
            </a>
          ) : null}
          {embedded ? (
            <button
              type="button"
              className="chip"
              onClick={() => {
                try {
                  window.parent.postMessage({ type: 'omniscience:toggle-pane' }, '*');
                } catch {
                  /* not inside Hermes */
                }
              }}
              title="Send a mini Omniscience to the right-hand side panel (next to your chat): pick any chat and switch between Live, Context, Tools, Tokens and Time there. Click again to close it."
            >
              ⇥ Side panel
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            onClick={resetView}
            title="Reset view: put the panels, zoom, filters and view back the way they started. Nothing is deleted."
            aria-label="Reset view"
          >
            ↺
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={toggleFullscreen}
            title="Maximize: show only Omniscience, full screen (Esc to leave)."
            aria-label="Maximize"
          >
            ⛶
          </button>
          <button
            type="button"
            className={`chip mini-chip ${railMode === 'follow' ? 'is-active' : ''}`}
            aria-pressed={railMode === 'follow'}
            aria-label={railMode === 'follow' ? 'Close the mini panel' : 'Open the mini panel'}
            onClick={() => {
              const next = railMode === 'follow' ? 'details' : 'follow';
              setRailMode(next);
              try {
                window.localStorage.setItem('omni.railMode', next);
              } catch {
                /* storage unavailable */
              }
              if (next === 'follow') setInspectorShown(true);
            }}
            title="Mini panel: a small frame on the right that shows only what you chose to watch in your chats. Add or remove items with its edit button."
          >
            <span className="mini-glyph" aria-hidden="true">
              ⬒
            </span>
            <span className="mini-label">Mini Panel</span>
          </button>
          <button
            type="button"
            className="chip panels-button"
            data-tour="panels"
            aria-haspopup="dialog"
            aria-expanded={panelsOpen}
            onClick={() => setPanelsOpen(true)}
            title="Panels: show, hide and resize any panel, switch between Simple, Standard and Everything, or reset the layout."
          >
            <span aria-hidden="true">⊞</span> Panels
          </button>
          <button
            type="button"
            className="chip reset-view-chip"
            onClick={resetView}
            title="Reset View: back to how Omniscience first opens. Recordings are not touched."
          >
            <span aria-hidden="true">↺</span> Reset View
          </button>
          <button
            type="button"
            className="chip tour-chip"
            onClick={startTour}
            title="Take the Tour: five stops, about thirty seconds."
          >
            <span aria-hidden="true">◎</span> Tour
          </button>
          {view === 'graph' && !accountView ? (
            <span className="map-style" role="group" aria-label="How to draw this chat">
              <button
                type="button"
                className={`chip${linkView ? '' : ' is-on'}`}
                aria-pressed={!linkView}
                onClick={() => chooseMapStyle(false)}
                title="Timeline: steps left to right, in the order they happened."
              >
                Timeline
              </button>
              <button
                type="button"
                className={`chip${linkView ? ' is-on' : ''}`}
                aria-pressed={linkView}
                onClick={() => chooseMapStyle(true)}
                title="Links: the same steps as a web, arranged by what led to what."
              >
                Links
              </button>
            </span>
          ) : null}
          {!accountView && !prefs.visible('context') ? (
            <button
              type="button"
              className="chip restore-chart-chip"
              onClick={() => prefs.toggle('context')}
              title="Bring back the Tokens per call chart you closed."
            >
              <span aria-hidden="true">▤</span> Tokens chart
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            title="Settings: views, compact text, chat titles, recording and privacy."
            aria-label="Settings"
          >
            ⚙
          </button>
          <MenuButton label="Help" icon="?" tip="Help: a guided explanation, or a short tour of the screen." align="end">
            <MenuItem onSelect={() => setHelpOpen(true)} hint="What every box, colour and number means.">
              What Am I Looking At?
            </MenuItem>
            <MenuItem onSelect={startTour} hint="Five stops, about 30 seconds. Resets the layout to its defaults first.">
              Take the Tour
            </MenuItem>
          </MenuButton>
        </div>
      </header>

      <main
        className={`workspace ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}
      >
        <div
          className={`rail-backdrop ${sessionsOpen ? 'is-open' : ''}`}
          onClick={() => setSessionsOpen(false)}
        />
        <aside
          data-tour="chats"
          data-panel="chats"
          className={`rail-left ${sessionsOpen ? 'is-open' : ''} ${leftCollapsed ? 'is-collapsed' : ''}`}
        >
          {leftCollapsed ? (
            <button
              type="button"
              className="rail-expand"
              aria-label="Show conversation list"
              aria-expanded={false}
              onClick={() => setChatsShown(true)}
            >
              Chats ›
            </button>
          ) : null}
          <div className="rail-content">
            <button
              type="button"
              className="rail-collapse"
              aria-label="Hide conversation list"
              onClick={() => setChatsShown(false)}
            >
              ‹
            </button>
            <SessionList
              sessions={sessions}
              selectedId={selectedRoot}
              loading={sessionsLoading}
              error={sessionsError}
              onSelect={onSelectSession}
              heat={view === 'tokens'}
            />
          </div>
        </aside>

        <section className="stage">
          <div className="stage-toolbar">
            <div className="stage-title" title="The conversation currently shown on the map (its session id).">
              {selectedRoot ? (
                <>
                  <span className="stage-title-prefix">chat</span>
                  <span className="stage-title-name" title={selectedRoot}>
                    {shownSessions.find((session) => session.id === selectedRoot)?.label || shortRoot(selectedRoot)}
                  </span>
                </>
              ) : (
                'agent graph'
              )}
            </div>
            <div className="chips">
              <div className="view-switch" role="group" aria-label="View">
                {VIEW_TABS.map(([mode, label, tip]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`chip ${view === mode ? 'is-active' : ''}`}
                    aria-pressed={view === mode}
                    onClick={() => chooseView(mode)}
                    title={tip}
                  >
                    {label}
                  </button>
                ))}
                <select
                  className={`chip more-views ${MORE_VIEWS.some(([m]) => m === view) ? 'is-active' : ''}`}
                  value={MORE_VIEWS.some(([m]) => m === view) ? view : ''}
                  onChange={(event) => {
                    const mode = event.target.value as ViewMode;
                    if (!mode) return;
                    setView(mode);
                    try {
                      window.localStorage.setItem('omni.view', mode);
                    } catch {
                      /* storage unavailable */
                    }
                  }}
                  title="More views: flame, tools, context growth, helper agents, recording coverage."
                  aria-label="More views"
                >
                  <option value="">More Views ▾</option>
                  {MORE_VIEWS.map(([mode, label]) => (
                    <option key={mode} value={mode}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {quiet.network + quiet.mcp > 0 ? (
                <span
                  className="quiet-chip"
                  title="In the last five minutes this chat called out to the network or a third-party server. Nothing was alerted, because these are ordinary working calls."
                >
                  {quiet.network ? `${quiet.network} network` : ''}
                  {quiet.network && quiet.mcp ? ' · ' : ''}
                  {quiet.mcp ? `${quiet.mcp} MCP` : ''}
                </span>
              ) : null}
              {riskActive && privacy ? (
                <PrivacyAlert
                  hit={privacy.hit}
                  toolName={privacy.tool}
                  ageSeconds={privacy.age}
                  ranMs={privacy.ranMs}
                  chatLabel={
                    shownSessions.find((candidate) => candidate.id === selectedRoot)?.label ??
                    selectedRoot?.slice(0, 8) ??
                    null
                  }
                  onFlag={() => void flagChat()}
                  onIgnore={() => dismissPrivacy(privacy.id)}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onDismiss={() => dismissPrivacy(privacy.id)}
                />
              ) : null}

              <span className="toolbar-spacer" aria-hidden="true" />
              <MenuButton
                label="Filters"
                badge={(hideTools ? 1 : 0) + (hideLlms ? 1 : 0) + (errorsOnly ? 1 : 0)}
                tip="Filters: choose which steps the map, list and timeline show. The number counts filters that are on."
                align="end"
              >
                <MenuLabel>Show on the map and list</MenuLabel>
                <MenuCheck checked={hideTools} onChange={setHideTools} hint="Actions like running a command or reading a file.">
                  Hide Tool Steps
                </MenuCheck>
                <MenuCheck checked={hideLlms} onChange={setHideLlms} hint="The agent asking the AI model.">
                  Hide Model Calls
                </MenuCheck>
                <MenuCheck checked={errorsOnly} onChange={setErrorsOnly} hint="Only failed steps and lost markers, to find what went wrong.">
                  Errors Only
                </MenuCheck>
              </MenuButton>
              <WriteupChip onOpen={() => setInsightOpen(true)} />
              <MenuButton label="Actions" tip="Actions: export CSV, panels, reset the view." align="end">
                <MenuLabel>Export CSV — timings, tokens, models; never message text</MenuLabel>
                <MenuItem disabled={!selectedRoot} onSelect={() => exportCsv('steps:chat')}>Every Step of This Chat</MenuItem>
                <MenuItem onSelect={() => exportCsv('steps:all')}>Every Step of All Chats</MenuItem>
                <MenuItem onSelect={() => exportCsv('chats:all')}>One Row per Chat</MenuItem>
                <MenuItem disabled={!selectedRoot} onSelect={() => exportCsv('models:chat')}>Per Model, This Chat</MenuItem>
                <MenuItem onSelect={() => exportCsv('models:all')}>Per Model, All Chats</MenuItem>
                <MenuSep />
                <MenuItem onSelect={() => setPanelsOpen(true)} hint="Show, hide and resize panels; switch Simple, Standard, Everything.">
                  Panels…
                </MenuItem>
                <MenuItem onSelect={resetView} hint="Back to how Omniscience first opens. Recordings are not touched.">
                  ↺ Reset View
                </MenuItem>
              </MenuButton>
              {exportNote ? <span className="export-note" role="status">{exportNote}</span> : null}
            </div>
          </div>

          {!accountView && prefs.visible('hints') && VIEW_HINTS[view] ? (
            <p className="view-hint">{VIEW_HINTS[view]}</p>
          ) : null}

          {!accountView && selectedRoot && !loading && !earlierExhausted && events.length > 0 &&
            (selectedSession?.events ?? 0) > events.length ? (
            <div className="stage-window-note" style={{ position: 'static' }}>
              Showing {events.length.toLocaleString()} recent recorded events; earlier activity is not loaded.{' '}
              <button type="button" onClick={() => void loadEarlier()} disabled={loadingEarlier}>
                {loadingEarlier ? 'Loading…' : 'Load earlier activity'}
              </button>
            </div>
          ) : null}
          {staleBuild ? (
            <div className="stale-build" role="status">
              Omniscience was updated underneath this tab.
              <button type="button" onClick={() => window.location.reload()}>Reload</button>
            </div>
          ) : null}
          {!accountView && selectedRoot && !notRecorded && prefs.visible('status') ? (
            <div className={`status-band${briefingOpen ? ' is-open' : ''}`} data-tour="status" data-panel="status">
              <VerdictHeader
                verdict={verdict}
                onJump={onSelectEvent}
                onSummary={() => {
                  if (!briefingOpen) prefs.toggle('briefing');
                  setChatSummaryOpen(true);
                }}
              />
              <div className="sb-row">
                <button
                  type="button"
                  className="sb-briefing"
                  aria-expanded={briefingOpen}
                  onClick={() => prefs.toggle('briefing')}
                  title="Briefing: the plain-English summary, each failure with why and what to do, the activity summary and the timeline."
                >
                  <span className="sb-caret" aria-hidden="true">{briefingOpen ? '▾' : '▸'}</span>
                  <span className="sb-label">Summary</span>
                  <span className="sb-digest mono">
                    {summary.statusWord} · {summary.modelCalls} model calls · {summary.toolCalls} tools
                    {summary.failedTools > 0 ? ` · ${summary.failedTools} failed` : ''}
                  </span>
                  <span className="sb-open">{briefingOpen ? 'Hide Briefing' : 'Open Briefing'}</span>
                </button>
                {failureEventIds.length > 0 ? (
                  <span className="sb-stepper" role="group" aria-label="Step through failures">
                    <button type="button" onClick={onPrevError} aria-label="Previous failure" title="Previous failure">‹</button>
                    <span className="sb-fails mono">{failureEventIds.length} {failureEventIds.length === 1 ? 'failure' : 'failures'}</span>
                    <button type="button" onClick={onNextError} aria-label="Next failure" title="Next failure">›</button>
                  </span>
                ) : null}
                {lost > 0 ? (
                  <span
                    className="sb-lost"
                    title="Lost: steps the recorder had to skip because it fell behind. Conclusions about this chat may be incomplete."
                  >
                    ⚠ {lost} lost {lost === 1 ? 'record' : 'records'}
                  </span>
                ) : null}
              </div>
              {briefingOpen ? (
                <div className="briefing">
                  <ChatSummaryPanel
                    events={visibleEvents}
                    rootSessionId={selectedRoot}
                    open={chatSummaryOpen}
                    onToggle={() => setChatSummaryOpen((open) => !open)}
                    onJump={onSelectEvent}
                  />
                  {failureEventIds.length > 0 ? (
                    <FailurePanel
                      root={selectedRoot}
                      failureCount={failureEventIds.length}
                      selectedEventId={selectedEventId}
                      onSelectEvent={onSelectEvent}
                      onPrev={onPrevError}
                      onNext={onNextError}
                    />
                  ) : null}
                  {events.length > 0 ? (
                    <ActivitySummary
                      events={visibleEvents}
                      nowSeconds={nowSec}
                      partial={(selectedSession?.events ?? 0) > events.length}
                    />
                  ) : null}
                  <EventTimeline events={visibleEvents} nodes={baseGraph.nodes} onSelectEvent={onSelectEvent} />
                  <SummaryBar
                    summary={summary}
                    nowStep={nowStep}
                    nowTs={nowTs}
                    split={split}
                    failedNodeCount={failureEventIds.length}
                    onNextError={onNextError}
                    onPrevError={onPrevError}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {sessionsError !== null || eventsFetchFailed ? (
            sessionsError?.startsWith('401') ? (
              <div className="stage-state is-offline" role="status">
                <strong>This page's key is out of date.</strong> The viewer is running, but this page was opened
                with an older key. Open Omniscience again from Hermes (sidebar) or a fresh <code>/omni</code> link.
              </div>
            ) : (
              <div className="stage-state is-offline" role="status">
                <strong>Viewer can't be reached.</strong> Omniscience can't load recordings right now. It reconnects
                by itself when the viewer is back; if it stays like this, restart the Hermes gateway.
              </div>
            )
          ) : !loading && selectedRoot && notRecorded ? (
            <div className="stage-state" role="status">
              <strong>Not recorded yet.</strong> This chat may have started before Omniscience was on; your
              next message appears here as it happens.
            </div>
          ) : null}
          {/* Account views and the views that already are a context chart do not repeat it. */}
          {!accountView && view !== 'tokens' && view !== 'context' && prefs.visible('context') && showContext &&
            selectedRoot && contextCalls > 1 && sessionsError === null && !eventsFetchFailed ? (
            <PanelFrame
              key={resetToken}
              id="context-lane"
              title="Tokens per call"
              tip="How much context each model call re-sent. Spikes are where it piled up; drops are compactions. ⤢ shows the notes and a bigger chart."
              // 150 px showed a line and no shape. Twice that is where the spikes and the
              // compaction drops become readable without taking the stage.
              defaultHeight={320}
              minHeight={180}
              tourId="context"
              onHide={() => prefs.toggle('context')}
            >
              <ContextView
                events={visibleEvents}
                rootSessionId={selectedRoot}
                onSelectEvent={onSelectEvent}
                compact
              />
            </PanelFrame>
          ) : null}

          {view === 'list' ? (
            <div className="graph-surface rl-surface">
              <RunList
                rows={rows}
                selectedEventId={selectedEventId}
                selectNonce={selectNonce}
                playing={playing}
                follow={replayIndex === null}
                onSelectEvent={onSelectEvent}
              />
            </div>
          ) : view === 'flame' ? (
            <div className="graph-surface tv-surface">
              <FlameView events={visibleEvents} rootSessionId={selectedRoot} nowTs={nowSec} onSelectEvent={onSelectEvent} />
            </div>
          ) : view === 'tools' ? (
            <div className="graph-surface tv-surface">
              <ToolsView events={visibleEvents} rootSessionId={selectedRoot} onSelectEvent={onSelectEvent} />
            </div>
          ) : view === 'context' ? (
            <div className="graph-surface tv-surface">
              <ContextView events={visibleEvents} rootSessionId={selectedRoot} onSelectEvent={onSelectEvent} />
            </div>
          ) : view === 'helpers' ? (
            <div className="graph-surface tv-surface">
              <HelpersView events={visibleEvents} rootSessionId={selectedRoot} onSelectEvent={onSelectEvent} />
            </div>
          ) : view === 'latency' ? (
            <div className="graph-surface lat-surface">
              <LatencyView />
            </div>
          ) : view === 'coverage' ? (
            <div className="graph-surface tv-surface">
              <CoverageView events={visibleEvents} loadedAll={!((selectedSession?.events ?? 0) > events.length)} />
            </div>
          ) : view === 'tokens' ? (
            <div className="graph-surface tv-surface">
              <TokensView
                events={visibleEvents}
                rootSessionId={selectedRoot}
                chats={sessions}
                onSelectEvent={onSelectEvent}
                onSelectChat={onSelectSession}
              />
            </div>
          ) : view === 'usage' ? (
            <div className="graph-surface us-surface">
              <UsageView
                onOpenChat={(sessionId) => {
                  onSelectSession(sessionId);
                  setView('tokens');
                }}
              />
            </div>
          ) : view === 'concerns' ? (
            <div className="graph-surface pv-surface">
              <ConcernsView />
            </div>
          ) : view === 'privacy' ? (
            <div className="graph-surface pv-surface">
              <PrivacyView
                onOpenChat={(sessionId) => {
                  onSelectSession(sessionId);
                  setView('graph');
                }}
              />
            </div>
          ) : view === 'time' ? (
            <div className="graph-surface tv-surface">
              <TimeView events={visibleEvents} nowTs={nowSec} onSelectEvent={onSelectEvent} />
            </div>
          ) : (
            <div className="graph-surface" data-tour="map">
              <GraphView
                graph={graph}
                linkView={linkView}
                selectedId={selectedNodeId}
                rootKey={selectedRoot ?? 'none'}
                onSelect={selectNodeDeep}
                onExpandTurn={expandTurn}
                onFoldTurn={foldTurn}
                focusToken={focusToken}
                resetToken={resetToken}
              />
              {loading ? <div className="stage-overlay">loading events…</div> : null}
              {!loading && truncated > 0 ? (
                <div className="stage-window-note">
                  showing the newest {graph.nodes.length} steps · {truncated} earlier step
                  {truncated === 1 ? '' : 's'} hidden — narrow with the filters to see them
                </div>
              ) : null}
              {!loading && !selectedRoot && !sessionsError ? (
                <div className="stage-overlay">Pick a conversation on the left</div>
              ) : null}
              {!loading && selectedRoot && events.length === 0 ? (
                <div className="stage-overlay">
                  {selectedSession
                    ? 'No steps recorded for this conversation yet — it will fill in as your agent works.'
                    : 'Omniscience has no recording of this chat yet. It probably started before Omniscience was switched on; your next message will appear here. Older chats are imported from Hermes history when Omniscience starts.'}
                </div>
              ) : null}
              {!loading && selectedRoot && events.length > 0 && visibleEvents.length === 0 ? (
                <div className="stage-overlay">replay at 0 — press play or drag the slider</div>
              ) : null}
            </div>
          )}

          {view === 'graph' && prefs.visible('legend') ? <Legend /> : null}
        </section>

        {!rightCollapsed ? (
            <div className="rail-scrim" aria-hidden="true" onClick={() => setInspectorShown(false)} />
          ) : null}
          <aside
          className={`rail-right ${selectedNode ? 'has-selection' : ''} ${rightCollapsed ? 'is-collapsed' : ''} ${railMode === 'follow' ? 'is-mini' : ''}`}
        >
          {rightCollapsed ? (
            <button
              type="button"
              className="rail-expand"
              aria-label="Show details"
              aria-expanded={false}
              onClick={() => setInspectorShown(true)}
            >
              ‹ Details
            </button>
          ) : null}
          <div className="rail-content">
            {/* The same strip that heads the standalone mini page, so "next to your chat" means
                the same thing whether Omniscience is docked or opened on its own. */}
            <SessionContextStrip
              session={shownSessions.find((candidate) => candidate.id === selectedRoot) ?? null}
              events={visibleEvents}
            />
            {railMode === 'follow' ? (
              <FollowRail
                events={visibleEvents}
                rootSessionId={selectedRoot}
                onSelectEvent={onSelectEvent}
              />
            ) : null}
            {railMode === 'follow' ? (
              <ProblemsPanel
                root={selectedRoot}
                onSelectEvent={onSelectEvent}
                onAskModel={() => setInsightOpen(true)}
              />
            ) : null}
            <button
              type="button"
              className="rail-collapse"
              aria-label="Hide details"
              onClick={() => setInspectorShown(false)}
            >
              ›
            </button>
            {/* The chevron above is a 20 px "›" in a corner: at drawer widths it reads as "expand".
                This one is a plain X with a 40 px target, and it only appears when the rail is a
                drawer. */}
            <button
              type="button"
              className="rail-close"
              aria-label="Close details"
              onClick={() => setInspectorShown(false)}
            >
              ✕
            </button>
            {railMode === 'details' ? (
              <>
                <div className="rail-tabs" role="tablist" aria-label="Details">
                  {([
                    ['inspect', 'Inspect', 'The selected step, or the longest steps when nothing is selected.'],
                    ['warnings', `Warnings${warningGroups > 0 ? ` (${warningGroups})` : ''}`, 'Patterns worth a look in this chat, grouped by kind.'],
                    ['why', 'Why', 'Why the run failed, read from its failures.'],
                  ] as const).map(([id, label, tip]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      id={`rail-tab-${id}`}
                      aria-selected={railTab === id}
                      aria-controls={`rail-panel-${id}`}
                      className={`rail-tab${railTab === id ? ' is-active' : ''}`}
                      onClick={() => setRailTab(id)}
                      title={tip}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div role="tabpanel" id={`rail-panel-${railTab}`} aria-labelledby={`rail-tab-${railTab}`} className="rail-tabpanel">
                  {railTab === 'warnings' ? (
                    <WarningsPanel
                      warnings={warnings}
                      nodes={baseGraph.nodes}
                      onSelectNode={selectNodeDeep}
                    />
                  ) : railTab === 'why' ? (
                    <WhyPanel
                      root={selectedRoot}
                      failedCount={failedNodes.length}
                      onSelectEvent={onSelectEvent}
                    />
                  ) : selectedNode ? (
                    <Inspector node={selectedNode} onClose={() => setSelectedNodeId(null)} />
                  ) : (
                    <SlowestList nodes={fullGraph.nodes} onSelect={selectNodeDeep} />
                  )}
                </div>
              </>
            ) : null}
          </div>
        </aside>
      </main>

      {/* What the page is honest about: every recorded fact up to this moment is included,
          anything after it is not yet shown. A stale line is the signal that the stream stopped. */}
      <div
        className={`asof${freshest > 0 && nowSec - freshest > 120 ? ' is-stale' : ''}`}
        title={
          'The newest recorded event in this view. Everything up to this moment is included; ' +
          'anything after it has not been recorded or has not arrived yet. If this line stops ' +
          'advancing while the agent is working, the recorder or the stream has stalled.'
        }
      >
        <span className="asof-dot" aria-hidden="true" />
        {freshest > 0 ? (
          <>
            Facts accurate to <b className="mono">{new Date(freshest * 1000).toLocaleTimeString()}</b>
            {' '}· {ageText || 'now'} · <b className="mono">{events.length.toLocaleString()}</b> steps in view
          </>
        ) : (
          <>No recorded facts yet for this chat.</>
        )}
      </div>

      {/* Usage and Latency describe the machine, not a run: there is nothing to scrub, so the
          transport is not drawn at all rather than shown dead. */}
      {!accountView && prefs.visible('replay') ? (
        <ReplayBar
          total={events.length}
          index={replayIndex}
          playing={playing}
          speed={speed}
          onIndex={onIndex}
          onTogglePlay={onTogglePlay}
          onSpeed={setSpeed}
          onLive={onLive}
        />
      ) : null}
    </div>
  );
}
