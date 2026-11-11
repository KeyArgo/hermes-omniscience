# What Omniscience can and can't see

> **Applies to:** Omniscience 1.0.0 · commit 12e8535
> **Revised:** 2026-11-09 · **Body hash:** b7c206a1


Omniscience subscribes to a subset of the Hermes observer hooks. The table below lists
every hook and whether Omniscience records it and why. Recorded hooks are wired up in
[`plugin/omniscience/__init__.py`](../plugin/omniscience/__init__.py).

| Hook | Recorded? | Why | What the viewer shows |
|---|---|---|---|
| `on_session_start` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Session box and its status |
| `on_session_end` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Session box and its status |
| `pre_llm_call` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Message box ("Message N · HH:MM") |
| `post_llm_call` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Message box ("Message N · HH:MM") |
| `pre_api_request` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Model call box with timing and token counts |
| `post_api_request` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Model call box with timing and token counts |
| `api_request_error` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A failed Model call (red) and its error type |
| `post_tool_call` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Tool box with timing, status and error type |
| `subagent_start` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Helper agent session linked to its parent |
| `subagent_stop` | Yes | Recorded — see `plugin/omniscience/__init__.py` | A Helper agent session linked to its parent |
| `pre_tool_call` | No | Deliberately not recorded: it can block tools if a plugin is slow, and Hermes treats a timeout there as a refusal | Nothing on the map |
| `pre_verify` | No | Not recorded yet | Nothing on the map |
| `on_session_finalize` | No | Not recorded yet | Nothing on the map |
| `on_session_reset` | No | Not recorded yet | Nothing on the map |
| `on_session_delete` | No | Not recorded yet | Nothing on the map |
| `pre_auxiliary_call` | No | Not recorded yet | Nothing on the map |
| `post_auxiliary_call` | No | Not recorded yet | Nothing on the map |

Busy messages fold into "N model calls · M tools" boxes, and lost events show as a gap
marker, never hidden.

## What this means

- Tool starts aren't seen — only tool ends — so a tool that hangs forever won't appear
  until it ends.
- Cancelled model requests show as "stopped without an answer".
- Anything Hermes does without a hook (internal retries, auxiliary model calls) isn't
  shown.
