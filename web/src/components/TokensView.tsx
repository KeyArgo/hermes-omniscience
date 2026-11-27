import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { OmniEvent, SessionMeta } from "../types";
import {
  buildTokenReport,
  type CallTokens,
  type CompactionMark,
  type PromptPoint,
} from "../graph/tokens";
import { advisePressure } from "../graph/pressure";
import { heatLevel, heatRange, heatSentence, HEAT_LEVELS } from "../graph/heat";
import {
  CHAT_SORTS,
  CHAT_WINDOWS,
  chatWindowCounts,
  withinChatWindow,
  windowAppliesTo,
  type ChatSortKey,
  type ChatWindow,
  sortChats,
} from "../graph/sessions";
import { PressureBanner } from "./PressureBanner";
import { Tip } from "./Tip";
import "./TokensView.css";

const TOKENS_SORT_KEY = 'omni.tokensSort';
const TOKENS_WINDOW_KEY = 'omni.tokensWindow';

function readTokensSort(): ChatSortKey {
  try {
    const raw = window.localStorage.getItem(TOKENS_SORT_KEY);
    if (raw === 'context' || raw === 'recent' || raw === 'output' || raw === 'calls') return raw;
  } catch {
    // ignore
  }
  return 'context';
}

/**
 * Which chats the list shows by default. The last hour: a list of every conversation the
 * recorder ever saw fills up with chats that are finished, renamed or deleted, and the one
 * worth looking at is the one being worked on now. The window is a control, not a limit —
 * widening it is one click and the choice is remembered.
 */
function readTokensWindow(): ChatWindow {
  try {
    const raw = window.localStorage.getItem(TOKENS_WINDOW_KEY);
    if (raw === 'hour' || raw === 'today' || raw === 'all') return raw;
  } catch {
    // ignore
  }
  return 'hour';
}



function abbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function shortModel(model: string): string {
  // Drop a vendor prefix ("deepseek/…") and keep enough to tell models apart.
  const name = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return name;
}

/** Local clock time; includes the day when the chat did not run today. */
function when(ts: number | null | undefined, withDay = true): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (!withDay) return time;
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

function span(first: number | null | undefined, last: number | null | undefined): string {
  if (!first || !last) return "—";
  const total = Math.max(0, Math.round(last - first));
  const minutes = Math.floor(total / 60);
  const length =
    total >= 3600
      ? `${Math.floor(total / 3600)}h ${String(minutes % 60).padStart(2, "0")}m`
      : total >= 60
        ? `${minutes}m`
        : `${total}s`;
  if (first === last) return when(first);
  return `${when(first)} → ${when(last, false)} · ${length}`;
}

function plural(n: number, word: string): string {
  return Math.round(n) === 1 ? word : `${word}s`;
}

function pct(x: number | null): string {
  return x === null ? "—" : `${Math.round(x * 100)}%`;
}

/**
 * A panel that can be blown up to fill the window.
 *
 * On a 13-inch laptop the token figures are small. Expanding a panel puts the
 * same content front and centre, large and scrollable, with Esc to go back.
 */
function Section({
  title,
  tip,
  children,
  className,
  action,
}: {
  title: string;
  tip: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <section className={`tk-section ${className ?? ""}`}>
      <h3 className="tk-h">
        {title}
        <Tip text={tip} side="bottom">
          <span className="tk-hint">?</span>
        </Tip>
        <span className="tk-h-actions">
          {action}
          <button
            type="button"
            className="tk-expand"
            onClick={() => setOpen(true)}
            title="Expand this panel to fill the window (Esc to close). Useful on a laptop."
            aria-label={`Expand ${title}`}
          >
            ⤢
          </button>
        </span>
      </h3>
      <div className="tk-section-body">{children}</div>
      {open ? (
        <div className="tk-modal" role="dialog" aria-modal="true" aria-label={title}>
          <div className="tk-modal-inner">
            <div className="tk-modal-head">
              <span className="tk-modal-title">{title}</span>
              <button
                type="button"
                className="tk-modal-close"
                onClick={() => setOpen(false)}
                autoFocus
              >
                Close <span className="tk-modal-key">Esc</span>
              </button>
            </div>
            <div className="tk-modal-body">{children}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RoleBadge({ role, task }: { role: CallTokens["role"]; task: string | null }) {
  if (role === "main") return null;
  const label = role === "background" ? "outside" : "helper";
  const text =
    role === "background"
      ? `Outside the chat: a background task (${task ?? "unlabelled"}) asked a model on its own. It does not carry the chat's context, so its prompts are small.`
      : "Helper: a sub-agent started by this chat, working on its own part of the job.";
  return (
    <Tip text={text} side="top">
      <span className={`tk-badge tk-badge-${role}`}>{label}</span>
    </Tip>
  );
}

function HeatKey() {
  return (
    <div className="tk-heatkey" role="note" aria-label="Context cost colours">
      <span className="tk-heatkey-caption">Context sent per call:</span>
      {HEAT_LEVELS.map(({ level, label, meaning }) => (
        <Tip key={level} text={`${label} — ${meaning}. ${heatRange(level)} of context sent per call.`} side="top">
          <span className="tk-heatkey-item">
            <span className={`heat-dot heat-${level}`} aria-hidden="true" />
            {label}
          </span>
        </Tip>
      ))}
    </div>
  );
}

function ChatRow({
  chat,
  selected,
  maxContext,
  onSelect,
}: {
  chat: SessionMeta;
  selected: boolean;
  maxContext: number;
  onSelect: () => void;
}) {
  const cached = chat.cached ?? 0;
  const fresh = chat.fresh ?? 0;
  const output = chat.output ?? 0;
  const total = cached + fresh + output;
  const contextNow = chat.prompt_now && chat.prompt_now > 0 ? chat.prompt_now : (chat.prompt_max ?? 0);
  const peak = chat.prompt_max ?? contextNow;
  const width = maxContext > 0 ? (Math.min(contextNow, maxContext) / maxContext) * 100 : 0;
  const peakWidth = maxContext > 0 ? (Math.min(peak, maxContext) / maxContext) * 100 : 0;
  const level = heatLevel(contextNow);
  // A chat that has not called a model recently is showing history, not "now": after a
  // compaction the new size is only recorded at the next call.
  const nowS = Date.now() / 1000;
  const ageS = typeof chat.last_ts === "number" ? nowS - chat.last_ts : null;
  const staleS = ageS !== null && ageS > 300 ? ageS : null;
  const share = cached + fresh > 0 ? cached / (cached + fresh) : null;
  const compactions = chat.compactions ?? 0;
  const label = chat.label || chat.id || "untitled chat";

  const summary = [
    `${label}`,
    `Ran ${span(chat.first_ts, chat.last_ts)}`,
    `${fmtInt(chat.calls ?? 0)} model calls, ${fmtInt(chat.tools ?? 0)} tool calls${
      chat.mcp_calls ? ` (${fmtInt(chat.mcp_calls)} over MCP)` : ""
    }`,
    `${fmtInt(chat.skills ?? 0)} skill loads, ${fmtInt(chat.aux_calls ?? 0)} outside model calls`,
    `${abbrev(cached)} cached, ${abbrev(fresh)} new, ${abbrev(output)} out — ${abbrev(total)} billed so far`,
    compactions > 0
      ? `${compactions} context compaction${compactions === 1 ? "" : "s"}`
      : "no compaction seen",
    heatSentence(contextNow, chat.prompt_max, undefined, staleS),
    "Click to see this chat's calls, its context size and any compaction.",
  ].join("\n");

  return (
    <button
      type="button"
      className={`tk-chat tk-heat-${level}${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      data-tip={summary}
    >
      <span className="tk-chat-main">
        <span className="tk-chat-name">
          <span className={`heat-dot heat-${level}`} aria-hidden="true" />
          {label}
        </span>
        <span className="tk-chat-when">{span(chat.first_ts, chat.last_ts)}</span>
      </span>
      <span className="tk-chat-counts">
        <span className="tk-count" title="Model calls made by this chat">
          <b>{fmtInt(chat.calls ?? 0)}</b>
          <i>{plural(chat.calls ?? 0, "call")}</i>
        </span>
        <span className="tk-count" title="Tool calls, of which MCP server calls">
          <b>{fmtInt(chat.tools ?? 0)}</b>
          <i>{plural(chat.tools ?? 0, "tool")}</i>
          {chat.mcp_calls ? <em>{fmtInt(chat.mcp_calls)} MCP</em> : null}
        </span>
        <span className="tk-count" title="Times a skill was loaded into this chat">
          <b>{fmtInt(chat.skills ?? 0)}</b>
          <i>{plural(chat.skills ?? 0, "skill")}</i>
        </span>
        <span className="tk-count" title="Model calls made outside the conversation: titles, approvals, vision, background work">
          <b>{fmtInt(chat.aux_calls ?? 0)}</b>
          <i>outside</i>
        </span>
      </span>
      <span className="tk-chat-bar" aria-hidden="true">
        <span className="tk-chat-bar-track">
          {/* The pale part is where this chat was before a compaction; the solid part is what
              the next message actually pays for. */}
          <span className="tk-chat-bar-peak" style={{ width: `${peakWidth}%` }} />
          <span className={`tk-chat-bar-fill tk-heat-${level}`} style={{ width: `${width}%` }} />
        </span>
      </span>
      <span className="tk-chat-meta">
        <span className="tk-chat-tokens" title="Context the next message pays for; the peak is the largest it ever got.">
          {abbrev(contextNow)} {staleS === null ? "now" : "at last call"}
          {peak > contextNow * 1.05 ? ` · ${abbrev(peak)} peak` : ''}
          {staleS !== null ? ` · ${Math.round(staleS / 60)}m ago` : ''}
        </span>
        <span className="tk-chat-cache" title="Share of the input the provider served from its cache">
          {pct(share)} reused
        </span>
        {compactions > 0 ? (
          <span className="tk-chip-compaction" title="Context was compacted mid-chat">
            {compactions} compaction{compactions === 1 ? "" : "s"}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function ContextLine({
  points,
  compactions,
  onSelect,
}: {
  points: PromptPoint[];
  compactions: CompactionMark[];
  onSelect: (eventId: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 900;
  const H = 90;
  const pad = 8;

  const max = points.reduce((m, p) => Math.max(m, p.prompt), 1);
  const first = points.length > 0 ? points[0].at : 0;
  const last = points.length > 0 ? points[points.length - 1].at : 1;
  const tSpan = Math.max(1, last - first);

  const xy = (p: PromptPoint): [number, number] => {
    const x = pad + ((p.at - first) / tSpan) * (W - pad * 2);
    const y = H - pad - (p.prompt / max) * (H - pad * 2);
    return [x, y];
  };

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xy(p)[0].toFixed(1)},${xy(p)[1].toFixed(1)}`).join(" ");

  const markX = (ts: number) => pad + ((ts - first) / tSpan) * (W - pad * 2);

  return (
    <div className="tk-context">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="tk-context-svg"
        role="img"
        aria-label={`Context size over ${points.length} calls, up to ${fmtInt(max)} tokens`}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="tk-context-axis" />
        {compactions.map((c, i) => (
          <g key={`${c.at}-${i}`}>
            <line
              x1={markX(c.at)}
              y1={pad}
              x2={markX(c.at)}
              y2={H - pad}
              className="tk-context-mark"
            />
            <circle cx={markX(c.at)} cy={pad + 4} r={3} className="tk-context-mark-dot" />
          </g>
        ))}
        <path d={path} className="tk-context-line" />
        {points.map((p, i) => {
          const [x, y] = xy(p);
          return (
            <circle
              key={`${p.eventId}-${i}`}
              cx={x}
              cy={y}
              r={hover === i ? 4 : 2}
              className={`tk-context-dot${hover === i ? " is-hover" : ""}`}
              onMouseEnter={() => setHover(i)}
              onClick={() => onSelect(p.eventId)}
            >
              <title>{`${when(p.at)} · ${fmtInt(p.prompt)} tokens sent`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="tk-context-legend">
        <span>context sent to the model</span>
        <span className="tk-context-max">peak {fmtInt(max)}</span>
        {compactions.length > 0 ? (
          <span className="tk-context-key">
            <span className="tk-context-key-mark" /> compaction
          </span>
        ) : null}
      </div>
      {hover !== null && points[hover] ? (
        <div className="tk-context-readout">
          {when(points[hover].at)} · {fmtInt(points[hover].prompt)} tokens sent
        </div>
      ) : null}
    </div>
  );
}

function CompactionCard({ mark, onSelect }: { mark: CompactionMark; onSelect: (id: string) => void }) {
  const pctLost = mark.before > 0 ? mark.saved / mark.before : 0;
  return (
    <button type="button" className="tk-compaction" onClick={() => onSelect(mark.eventId)}>
      <span className="tk-compaction-head">
        <span className="tk-compaction-when">{when(mark.at)}</span>
        <span className="tk-compaction-title">context compacted</span>
      </span>
      <span className="tk-compaction-flow">
        <span>{fmtInt(mark.before)}</span>
        <span className="tk-compaction-arrow">→</span>
        <span className="tk-compaction-after">{fmtInt(mark.after)}</span>
        <span className="tk-compaction-saved">
          −{fmtInt(mark.saved)} ({pct(pctLost)} of the context)
        </span>
      </span>
      <span className="tk-compaction-detail">
        Cache reuse went {pct(mark.beforeCacheShare)} → {pct(mark.afterCacheShare)}; the next call
        had to process {fmtInt(mark.freshAfter)} tokens fresh.
      </span>
    </button>
  );
}

export function TokensView({
  events,
  rootSessionId,
  chats,
  onSelectEvent,
  onSelectChat,
}: {
  events: OmniEvent[];
  rootSessionId: string | null;
  chats: SessionMeta[];
  onSelectEvent: (eventId: string) => void;
  onSelectChat: (sessionId: string) => void;
}) {
  const report = useMemo(() => buildTokenReport(events, rootSessionId), [events, rootSessionId]);

  const { totals, notes, byModel, calls, compactions, promptSeries, activity } = report;

  const [chatSort, setChatSort] = useState<ChatSortKey>(readTokensSort);
  function changeChatSort(next: ChatSortKey) {
    setChatSort(next);
    try {
      window.localStorage.setItem(TOKENS_SORT_KEY, next);
    } catch {
      // ignore
    }
  }

  const [chatWindow, setChatWindow] = useState<ChatWindow>(readTokensWindow);
  function changeChatWindow(next: ChatWindow) {
    setChatWindow(next);
    try {
      window.localStorage.setItem(TOKENS_WINDOW_KEY, next);
    } catch {
      // ignore
    }
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowCounts = useMemo(
    () => chatWindowCounts(chats, nowSeconds),
    [chats, nowSeconds],
  );
  // The window belongs to the "biggest context now" ranking, and to nothing else: an old chat
  // can top a history ranking honestly, but it must not be presented as today's heaviest.
  // The chat you already opened is always kept, so a row cannot vanish from under its panel.
  const windowApplies = windowAppliesTo(chatSort);
  const shownChats = useMemo(
    () => (windowApplies ? withinChatWindow(chats, chatWindow, nowSeconds, rootSessionId) : chats),
    [chats, chatWindow, nowSeconds, rootSessionId, windowApplies],
  );
  const sortedChats = useMemo(() => sortChats(shownChats, chatSort), [shownChats, chatSort]);

  // Bars are scaled to the largest context any chat is carrying NOW, so a compacted chat
  // visibly shrinks instead of keeping a longest bar because of what it once sent.
  const maxChatTokens = useMemo(() => {
    let m = 1;
    for (const c of sortedChats) {
      const t = c.prompt_now && c.prompt_now > 0 ? c.prompt_now : (c.prompt_max ?? 0);
      if (t > m) m = t;
    }
    return m;
  }, [sortedChats]);

  // Read from the full list, not the visible one: narrowing the window must not blank the
  // detail panel for the chat you are already reading.
  const selectedChat = useMemo(
    () => chats.find((c) => c.id === rootSessionId) ?? null,
    [chats, rootSessionId]
  );

  // Bars are scaled by the context each call *sent* (prompt), not by the billed total: the
  // number on the row is "N in", so the length has to measure the same thing. Output tokens are
  // written in the label; folding them into the bar made a chatty answer look like a bigger
  // context than it was.
  const maxCall = useMemo(() => {
    let m = 1;
    for (const c of calls) {
      const sent = c.cached + c.fresh;
      if (sent > m) m = sent;
    }
    return m;
  }, [calls]);

  const visibleCalls = useMemo(() => calls.slice(-400), [calls]);

  const pressure = useMemo(() => advisePressure(calls), [calls]);

  const totalInput = totals.cached + totals.fresh;
  const barTotal = totalInput + totals.output || 1;
  const cachedPct = (totals.cached / barTotal) * 100;
  const freshPct = (totals.fresh / barTotal) * 100;
  const outputPct = (totals.output / barTotal) * 100;

  const chatFirst = selectedChat?.first_ts ?? (promptSeries[0]?.at ?? null);
  const chatLast =
    selectedChat?.last_ts ?? (promptSeries[promptSeries.length - 1]?.at ?? null);

  return (
    <div className="tk-root">
      {/* (a) chats — one row per conversation, ranked by size */}
      <Section
        title="Chats"
        tip="Conversations ranked by the mode you pick. Biggest context only looks back as far as the window says — a chat that stopped an hour ago still has a big context but is not what needs attention. The other rankings are questions about history and show every chat."
        action={
          <>
            {windowApplies && (
            <select
              className="tk-window"
              value={chatWindow}
              onChange={(event) => changeChatWindow(event.target.value as ChatWindow)}
              title="How far back the list looks. The last hour keeps finished and deleted chats out of the way; widen it to find an older one."
              aria-label="Chats in the last"
            >
              {CHAT_WINDOWS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} ({windowCounts[option.value]})
                </option>
              ))}
            </select>
            )}
            <select
              className="tk-sort"
              value={chatSort}
              onChange={(event) => changeChatSort(event.target.value as ChatSortKey)}
              title="Which chat is worth looking at first. Biggest context puts the most expensive chat on top."
              aria-label="Sort chats"
            >
              {CHAT_SORTS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </>
        }
      >
        <HeatKey />
        <div className="tk-chats">
          {sortedChats.length === 0 && (
            <p className="tk-empty">
              {chatWindow === 'hour'
                ? `No chats ran in the last hour. ${windowCounts.today} ran today, ${windowCounts.all} are recorded.`
                : chatWindow === 'today'
                  ? `Nothing ran today yet. ${windowCounts.all} chats are recorded in total.`
                  : 'No chats recorded yet.'}
              {windowApplies && chatWindow !== 'all' && windowCounts.all > 0 && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="tk-empty-action"
                    onClick={() => changeChatWindow(chatWindow === 'hour' ? 'today' : 'all')}
                  >
                    {chatWindow === 'hour' ? 'Show today' : 'Show all chats'}
                  </button>
                </>
              )}
            </p>
          )}
          {sortedChats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              selected={chat.id === rootSessionId}
              maxContext={maxChatTokens}
              onSelect={() => onSelectChat(chat.id)}
            />
          ))}
        </div>
      </Section>

      {/* (b) the selected chat, in detail */}
      <Section
        className="tk-this"
        title="This chat"
        tip="The conversation you picked. Times are your local clock. Everything here comes from the recording: no message text, only measurements."
      >
        {selectedChat ? (
          <div className="tk-this-head">
            <span className="tk-this-name">{selectedChat.label || selectedChat.id}</span>
            <span className="tk-this-when">{span(chatFirst, chatLast)}</span>
            <span className="tk-this-facts">
              <Tip text="Model calls made by the chat itself; outside calls are separate." side="top">
                <span>
                  <b>{fmtInt(activity.llmCalls)}</b> model {plural(activity.llmCalls, "call")}
                </span>
              </Tip>
              <Tip text="Tool calls this chat ran, including helpers' tools." side="top">
                <span>
                  <b>{fmtInt(activity.tools)}</b> {plural(activity.tools, "tool")}
                </span>
              </Tip>
              <Tip text="Tool calls that went to an MCP server rather than a built-in tool." side="top">
                <span>
                  <b>{fmtInt(activity.mcpCalls)}</b> MCP
                  {activity.mcpServers.length > 0 ? ` (${activity.mcpServers.join(", ")})` : ""}
                </span>
              </Tip>
              <Tip
                text={
                  activity.skillNames.length > 0
                    ? `Skills loaded: ${activity.skillNames.join(", ")}. A skill is instructions the agent loaded for this kind of task.`
                    : "Skills the agent loaded into this chat. None were loaded here."
                }
                side="top"
              >
                <span>
                  <b>{fmtInt(activity.skills)}</b> skill {plural(activity.skills, "load")}
                </span>
              </Tip>
              <Tip
                text="Model calls made outside the conversation: chat titles, approval checks, vision, background work. They do not carry the chat's context."
                side="top"
              >
                <span>
                  <b>{fmtInt(activity.auxCalls)}</b> outside {plural(activity.auxCalls, "call")}
                </span>
              </Tip>
              {activity.subagents > 0 ? (
                <Tip text="Sub-agents this chat started." side="top">
                  <span>
                    <b>{fmtInt(activity.subagents)}</b> helpers
                  </span>
                </Tip>
              ) : null}
            </span>
          </div>
        ) : (
          <p className="tk-empty">Pick a chat above.</p>
        )}

        <PressureBanner
          advice={pressure}
          onCompact={
            promptSeries.length > 0
              ? () => onSelectEvent(promptSeries[promptSeries.length - 1].eventId)
              : undefined
          }
        />

        {promptSeries.length > 0 ? (
          <ContextLine points={promptSeries} compactions={compactions} onSelect={onSelectEvent} />
        ) : null}

        {compactions.length > 0 ? (
          <div className="tk-compactions">
            {compactions.map((m, i) => (
              <CompactionCard key={`${m.at}-${i}`} mark={m} onSelect={onSelectEvent} />
            ))}
          </div>
        ) : null}
      </Section>

      {/* (c) totals strip */}
      <section className="tk-strip">
        <div className="tk-strip-nums">
          <Tip text="Input the provider served from its cache. Cheap: it was not processed again." side="top">
            <div className="tk-stat">
              <span className="tk-stat-num tk-cyan">{abbrev(totals.cached)}</span>
              <span className="tk-stat-lbl">cached</span>
            </div>
          </Tip>
          <span className="tk-dot">·</span>
          <Tip text="New input: the tokens the provider had to read fresh, at full price." side="top">
            <div className="tk-stat">
              <span className="tk-stat-num tk-amber">{abbrev(totals.fresh)}</span>
              <span className="tk-stat-lbl">new</span>
            </div>
          </Tip>
          <span className="tk-dot">·</span>
          <Tip text="Tokens the model wrote back." side="top">
            <div className="tk-stat">
              <span className="tk-stat-num tk-green">{abbrev(totals.output)}</span>
              <span className="tk-stat-lbl">output</span>
            </div>
          </Tip>
          <span className="tk-dot">·</span>
          <Tip
            text="Share of all input that came from cache. After a compaction this drops, because the provider cannot reuse a context it has not seen."
            side="top"
          >
            <div className="tk-stat">
              <span className="tk-stat-num tk-cyan">{pct(totals.cacheShare)}</span>
              <span className="tk-stat-lbl">cache reuse</span>
            </div>
          </Tip>
        </div>
        <div className="tk-stackbar" role="img" aria-label="token breakdown">
          <div className="tk-seg tk-seg-cached" style={{ width: `${cachedPct}%` }} />
          <div className="tk-seg tk-seg-fresh" style={{ width: `${freshPct}%` }} />
          <div className="tk-seg tk-seg-output" style={{ width: `${outputPct}%` }} />
        </div>
      </section>

      {/* (d) notes */}
      {notes.length > 0 && (
        <section className="tk-notes">
          <ul className="tk-notes-list">
            {notes.map((n, i) => (
              <li key={i} className="tk-note">
                {n}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* (e) per call chart */}
      <Section
        title="Per call"
        tip="One bar per model call, in order. The left part is cached input, the middle is new input, the right is what the model wrote. Click a bar to jump to that step."
      >
        <HeatKey />
        <div className="tk-chart">
          {visibleCalls.length === 0 && <p className="tk-empty">No model calls recorded.</p>}
          {visibleCalls.map((c) => {
            const sent = c.cached + c.fresh;
            const w = (sent / maxCall) * 100;
            const cachedW = sent > 0 ? (c.cached / sent) * 100 : 0;
            const freshW = sent > 0 ? (c.fresh / sent) * 100 : 0;
            const outputW = sent > 0 ? (c.output / sent) * 100 : 0;
            return (
              <button
                key={c.id}
                type="button"
                className={`tk-bar-row tk-heat-${heatLevel(c.prompt)}`}
                onClick={() => onSelectEvent(c.eventId)}
                data-tip={`${when(c.start)} · ${shortModel(c.model)} · ${fmtInt(
                  c.prompt
                )} sent (${fmtInt(c.cached)} cached, ${fmtInt(c.fresh)} new) · ${fmtInt(
                  c.output
                )} out\n${heatSentence(c.prompt)}`}
              >
                <span className="tk-bar-label">
                  <span className="tk-bar-time">{when(c.start, false)}</span>
                  <span className="tk-bar-model">{shortModel(c.model)}</span>
                  <RoleBadge role={c.role} task={c.task} />
                </span>
                <span className="tk-bar-track">
                  <span className="tk-bar-fill" style={{ width: `${w}%` }}>
                    <span className="tk-bar-seg tk-seg-cached" style={{ width: `${cachedW}%` }} />
                    <span className="tk-bar-seg tk-seg-fresh" style={{ width: `${freshW}%` }} />
                    {/* Output is drawn past the end of the bar so it cannot be mistaken for
                        context: it is what the model wrote, not what it was sent. */}
                    <span
                      className="tk-bar-out"
                      style={{ width: `${Math.min(30, outputW)}%` }}
                      title={`${fmtInt(c.output)} tokens written by the model`}
                    />
                  </span>
                </span>
                <span className="tk-bar-right" title="Context this call sent back to the model">
                  {abbrev(c.prompt)} in
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* (f) by model table */}
      <Section
        title="By model"
        tip="Each model that answered in this chat, with medians. The first-word wait is how long the provider took before it started writing."
      >
        <div className="tk-table-wrap">
          <table className="tk-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th className="tk-num">Calls</th>
                <th className="tk-num">Cached</th>
                <th className="tk-num">New</th>
                <th className="tk-num">Output</th>
                <th className="tk-num">Median tok/s out</th>
                <th className="tk-num">Median first-word wait</th>
              </tr>
            </thead>
            <tbody>
              {byModel.length === 0 && (
                <tr>
                  <td colSpan={8} className="tk-empty">
                    No models recorded.
                  </td>
                </tr>
              )}
              {byModel.map((m) => (
                <tr key={m.model}>
                  <td className="tk-model">{m.model}</td>
                  <td className="tk-muted">{m.provider ?? "—"}</td>
                  <td className="tk-num">{fmtInt(m.calls)}</td>
                  <td className="tk-num tk-cyan">{fmtInt(m.cached)}</td>
                  <td className="tk-num tk-amber">{fmtInt(m.fresh)}</td>
                  <td className="tk-num tk-green">{fmtInt(m.output)}</td>
                  <td className="tk-num">
                    {m.medianOutPerSec !== null
                      ? `${Math.round(m.medianOutPerSec).toLocaleString()}`
                      : "—"}
                  </td>
                  <td className="tk-num">
                    {m.medianTtfb !== null ? `${m.medianTtfb.toFixed(1)}s` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
