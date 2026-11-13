# FAQ

> **Applies to:** Omniscience 1.0.0 · written at commit 3ee0d28
> **Revised:** 2026-11-13 · **Body hash:** 05b81986




### Why does the top bar say OFFLINE?

Either no WebSocket library is installed for the viewer, or the viewer isn't running. Idle agents
(with no live events) can also show OFFLINE.

### Does it slow my agent?

No measurable amount in normal use. The hook copies a little metadata and puts it on a bounded queue;
a background thread does the SQLite writes. If anything goes wrong, events are dropped and counted,
and your agent keeps running.

### Does it send data anywhere?

The recorder makes no network calls, and neither does the viewer. Everything is stored in a SQLite
file on your machine and read locally. The written diagnosis (`/omni insight`) runs inside Hermes on
the model you already use, through the SDK's `ctx.llm` facade — the viewer holds no key and never
talks to a provider. The one optional network feature is the **DGX Sparks** usage source, which
polls the hosts you configure, and it does not run unless you turn it on. There is no telemetry
endpoint.

### Where is the data?

`<HERMES_HOME>/plugin-data/omniscience/events.db`, normally
`~/.hermes/plugin-data/omniscience/events.db`. Each Hermes profile has its own file.

### How do I delete it?

```bash
hermes plugins disable omniscience
# restart the gateway
hermes plugins remove omniscience
```

To delete the stored events too, remove the `plugin-data/omniscience` folder inside your Hermes home
(usually `~/.hermes/plugin-data/omniscience`) with your file manager, or run `/omni forget` in each chat first.

That removes every event it ever recorded.

### Why does it say "events lost"?

The plugin uses a bounded queue (10,000 events). If the writer cannot keep up — the DB is locked, the
disk is full, or a burst is very large — events are dropped rather than slowing the agent. The viewer
marks the gap with a dashed edge so you know the graph is incomplete there. It is a deliberate
trade-off, not corruption.

### Why is a box blue forever?

Blue means running: a start event arrived but no matching end event did. If the run really finished,
the end event may have been dropped (see above), or the process may have been killed before it could
write one. A box that stays blue after the session ends is a hint to check the gap markers and the
session's last recorded event.

### Does replay re-run tools?

No. Replay is a pure function over stored rows. It builds the graph again at each step; it never calls
a tool, a model, or the network.

### Which Hermes versions are supported?

Verified against Hermes Agent v0.23.0 (git `2bd378ed1b`). The plugin uses documented observer hooks;
other recent versions are likely to work, but are not verified.

### Is the viewer safe to expose on my network?

By default, no. It binds `127.0.0.1` and has no authentication. Pass `--host` only when you have your
own access control in front of it.

### Does it store prompts or tool results?

No. By default it stores metadata only: IDs, timings, model names, token counts, statuses, error
types, tool names, argument names, and character counts. See [SECURITY.md](SECURITY.md).
