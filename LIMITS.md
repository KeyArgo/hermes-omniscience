# Limits — Hermes Omniscience

Applies to **Omniscience 1.0.0** · revised **2026-11-11**.

- It records Hermes sessions only. A different harness would need its own recorder writing the same
  `omni.v1` schema.
- The graph draws only what it recorded: a session that ran before the plugin was enabled has no
  steps to replay, unless the one-time metadata import from Hermes' `state.db` can fill it.
- Tool starts are not recorded, only tool ends, so a tool that hangs forever appears only when it
  finishes. This is deliberate: `pre_tool_call` fails closed and a slow callback there can block the
  tool.
- Events can be dropped under heavy load. When the bounded queue overflows, or the database is
  locked or the disk is full, the writer records a lost-event marker, so loss is visible rather than
  hidden.
- It is metadata-only. Prompts, conversation text, tool arguments, tool results and credentials are
  never stored by default, so the viewer cannot show them.
- The viewer is read-only and loopback only by design. There is no remote access mode.
- Each Hermes profile has its own database. There is no cross-profile, fleet-wide view.
- On Windows the `0600` mode on `events.db` is not applied; privacy depends on the folder's ACLs.

Everything else about this product works as described in README.md.
