# Security — threat model, collection policy, privacy

> **Applies to:** Omniscience 1.0.0 · written at commit f2109ab
> **Revised:** 2026-11-11 · **Body hash:** bfc57691



## Collection policy (default: metadata only)

Stored: IDs, timings, model/provider names, token counts, statuses, error *types*, tool *names*,
argument *names*, character/byte counts.

**Never stored by default:** prompts, system prompts, conversation history, assistant text, tool
argument values, tool results, request/response bodies, headers, environment values, API keys,
`base_url` query strings, approval commands, human-input answers.

Implementation is an **allowlist**, per hook (`plugin/omniscience/sanitize.py`). New Hermes fields are
ignored until someone adds them on purpose. On top of that:
- Free-text fields that we do keep (reason) are truncated to 200 chars and passed through a
  redactor: key=value secrets, `Bearer …`, `sk-…`/`ghp_…`/AWS-style tokens, long hex/base64
  runs and URL credentials/query strings are replaced with `[REDACTED]`. Error messages are
  never stored as text at all — only their length (`error_message_chars`) is kept.
- Any dict key matching `key|token|secret|password|auth|cookie|credential` is dropped.
- `base_url` is reduced to scheme+host.

Opt-in content capture is **not implemented**. A future `omniscience.capture: previews` setting
would store redacted short previews; nothing in 1.0.0 stores prompt, argument or result content.

Two features can make a network request, and only when you turn them on:

- **Ask a Model** (`POST /api/v1/insight`) sends a metadata-only digest to a provider Hermes is
  already authenticated for, then returns the written answer. It sends counts, token totals, model
  and provider names, durations, error reasons and chat labels. It cannot send prompts or tool
  output because the recorder does not store them.
- **DGX Sparks usage source** polls TensorFold counters at the hosts you list in
  `OMNISCIENCE_TENSORFOLD_HOSTS`.

The recorder itself makes no network calls. The viewer binds loopback by default.

## Threat model

| Threat | Mitigation |
|---|---|
| Telemetry slows or breaks the agent | Callbacks O(µs): copy + `put_nowait`. Never registers `pre_tool_call` (fails closed). Bounded queue; drops counted. All callback code in `try/except` |
| DB locked / disk full | Writer thread retries a batch once then drops it with a counted `omni.dropped`; agent path untouched |
| Secrets leak into DB | Allowlist + redaction + key filtering; tests feed known secrets through every normalizer and assert absence in DB bytes |
| Viewer exposes data to the network | Binds `127.0.0.1` only; `--host` must be passed explicitly; the database is opened read-only; a per-install key guards `/api`; Host and WebSocket Origin are checked. The only writes are preferences, bundles, privacy dossiers, usage-source state and the opt-in brake request |
| Malicious content in stored strings reaches the browser | React text rendering only (no `dangerouslySetInnerHTML`); strings are bounded |
| Replay triggers side effects | Replay is a pure reduce over stored rows; the web app has no API that can call tools or models |
| DB file readable by other users | Created with mode `0600` in `plugin-data/` |
| Claiming hidden model reasoning | We store `reasoning_tokens` counts only, never reasoning text; UI labels it a count |

## Uninstall / data removal

`hermes plugins disable omniscience` → restart gateway → `hermes plugins remove omniscience` →
`rm -r <HERMES_HOME>/plugin-data/omniscience`. Nothing else is touched.
