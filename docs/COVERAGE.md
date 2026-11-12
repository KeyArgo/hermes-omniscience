# What Omniscience can and can't see

> **Applies to:** Omniscience 1.0.0 · written at commit f2109ab
> **Revised:** 2026-11-11 · **Body hash:** ea73fcf0


Omniscience subscribes to a subset of the Hermes observer hooks. The table lists every hook it
registers (`HOOKS` in [`__init__.py`](../__init__.py)) and whether it records an event, purges a
chat, or is deliberately left alone.

| Hook | Recorded? | Event kind | What the viewer shows |
|---|---|---|---|
| `on_session_start` | Yes | `session.start` | A Session box and its model |
| `on_session_end` | Yes | `session.end` | The Session box's completed/interrupted status |
| `pre_llm_call` | Yes | `turn.start` | A Message box ("Message N · HH:MM") |
| `post_llm_call` | Yes | `turn.end` | The Message box's end and assistant character count |
| `pre_api_request` | Yes | `llm.request` | A Model call box with model, provider and token estimate |
| `post_api_request` | Yes | `llm.response` | Model call timing, token counts and cache figures |
| `api_request_error` | Yes | `llm.error` | A failed Model call (red) and its error type |
| `post_tool_call` | Yes | `tool.end` | A Tool box with duration, status and error type |
| `subagent_start` | Yes | `subagent.start` | A Helper agent session linked to its parent turn |
| `subagent_stop` | Yes | `subagent.stop` | The Helper agent's status, duration and tool count |
| `pre_auxiliary_call` | Yes | `aux.request` | A background/auxiliary call attached to the turn |
| `post_auxiliary_call` | Yes | `aux.response` | Auxiliary call timing, tokens and error type |
| `on_skill_lifecycle` | Yes | `skill.event` | Skill use and reuse counts |
| `on_session_delete` | Yes (purge) | — | A deleted chat's rows are removed; an archived chat is hidden |

Hooks that are **not** registered:

| Hook | Why not |
|---|---|
| `pre_tool_call` | It fails closed: a slow callback can block the user's tool. Tool start time is derived from `post_tool_call.duration_ms` instead. |
| `transform_*` | They can change behaviour; an observer must not. |
| `on_stream_delta` | Token-rate firehose that would carry text. |
| `on_kanban_dispatch_tick` | Periodic noise unrelated to the run. |
| `pre_gateway_dispatch` | A policy gate, not an observation point. |
| `pre_verify`, `on_session_finalize`, `on_session_reset` | Not recorded yet. |

## What this means

- Tool starts are not seen, only tool ends, so a tool that hangs forever does not appear until it
  ends.
- A cancelled model request can show as a model call without a matching response.
- Auxiliary calls and skill events are recorded, but other work Hermes does without a hook is not.
- A deleted chat leaves the viewer; an archived chat is hidden but its history is kept.
- Busy messages fold into "N model calls · M tools" boxes, and lost events show as a `GAP` marker,
  never hidden.

## Related

- [HERMES_INTEGRATION](HERMES_INTEGRATION.md) — the verified payloads behind this table.
- [ARCHITECTURE](ARCHITECTURE.md) — how the events become a graph.
- [Documentation index](README.md)
