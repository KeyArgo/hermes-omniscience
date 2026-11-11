# plugin/omniscience/notices.py
"""Live problem notices for the Omniscience Hermes plugin.

Posts short, human-readable notices into the chat while the user waits,
covering rate limits, model fallbacks, slow starts, provider errors and
repeated tool failures. All posting happens off the hook thread via a
background daemon thread that copies the current context (so the chat
binding is preserved).
"""

from __future__ import annotations

import contextvars
import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Callable, Optional

from . import prefs as prefs_mod
from .digest import TurnFacts, plain_name, render as render_digest
from .reminder import CostWatch

log = logging.getLogger("omniscience")

__all__ = ["Notices"]

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------
_MAX_SESSIONS = 64
_MAX_PROVIDERS = 256
_MAX_NEW_MESSAGES_PER_TURN = 5
_SLOW_TTFB_S = 60.0
_TOOL_FAIL_THRESHOLD = 3


def _int_or_none(value: Any) -> Optional[int]:
    """A non-negative int from a provider usage field, or None. Never raises."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return max(0, int(round(value)))


def _default_spawn(fn: Callable[[], None]) -> None:
    """Run *fn* on a daemon thread with a copy of the current context."""
    ctx = contextvars.copy_context()
    t = threading.Thread(target=ctx.run, args=(fn,), daemon=True)
    t.start()

# A failure notice that only says "it failed" makes the reader do the work. Each hint below names
# the cause that repeats like this in practice, so the message answers "why" as well as "what".
_TOOL_FAIL_HINTS = {
    "memory": (
        "the memory store is over its character budget, so writes are rejected until it is trimmed"
    ),
    "terminal": (
        "the command fails for a reason a retry does not change: a bad path, a missing program "
        "or a permission"
    ),
    "read_file": "the path does not resolve, or the file is not readable from here",
    "write_file": (
        "the write is being refused, usually because the file changed on disk since it was read"
    ),
    "search_files": "the pattern or the directory does not exist, so nothing can match",
    "web_fetch": "the page is unreachable, blocked, or needs a browser rather than a fetch",
    "delegate_task": "the subagent cannot start, so the same task request keeps failing",
}
_GENERIC_FAIL_HINT = (
    "the same call keeps failing, so the arguments, not the attempt, are what needs changing"
)


class _TurnState:
    """Per-turn, per-session notice bookkeeping."""

    __slots__ = (
        "rate_handle",
        "rate_count",
        "fallback_shown",
        "slow_shown",
        "provider_error_shown",
        "tool_fail_counts",
        "tool_fail_handles",
        "tool_fail_notified",
        "new_messages",
        "facts",
        "started_at",
    )

    def __init__(self) -> None:
        self.rate_handle: Any = None
        self.rate_count: int = 0
        self.fallback_shown: set[tuple[str, str]] = set()
        self.slow_shown: bool = False
        self.provider_error_shown: bool = False
        self.tool_fail_counts: dict[str, int] = {}
        self.tool_fail_handles: dict[str, Any] = {}
        self.tool_fail_notified: set[str] = set()
        self.new_messages: int = 0
        # Everything the end-of-turn summary needs, accumulated as the turn runs.
        self.facts = TurnFacts()
        self.started_at: float = 0.0


class _DeferredHandle:
    """The real message handle arrives on a background thread; edits made before then are kept
    (only the newest text matters) and applied as soon as it lands."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._real: Any = None
        self._done = False
        self._pending: Optional[str] = None

    def _attach(self, real: Any) -> None:
        with self._lock:
            self._real, self._done = real, True
            pending, self._pending = self._pending, None
        if pending is not None:
            self._apply(pending)

    def _apply(self, text: str) -> None:
        edit = getattr(self._real, "edit", None)
        if edit is not None:
            try:
                edit(text)
            except Exception:
                # A notice that cannot be edited is cosmetic; the host must not see the error.
                log.debug("omniscience: editing a live notice failed", exc_info=True)

    def edit(self, text: str) -> None:
        with self._lock:
            if not self._done:
                self._pending = text
                return
        self._apply(text)


class Notices:
    """Observe sanitized hook events and post live notices."""

    def __init__(
        self,
        ctx: Any,
        link_for: Callable[[str], str],
        *,
        enabled: bool = True,
        clock: Callable[[], float] = time.time,
        spawn: Optional[Callable[[Callable[[], None]], None]] = None,
        normalize: Optional[Callable[..., Any]] = None,
        prefs_reader: Optional[Callable[[], dict]] = None,
    ) -> None:
        self._ctx = ctx
        self._link_for = link_for
        self._enabled = enabled
        self._clock = clock
        self._spawn = spawn if spawn is not None else _default_spawn
        # None means "no platform filter" (post everywhere); a tuple restricts to those platforms.
        self._platform_filter: Optional[tuple] = None

        if normalize is None:
            from .sanitize import normalize as _normalize
            self._normalize = _normalize
        else:
            self._normalize = normalize

        # session_id -> _TurnState (LRU, capped)
        self._sessions: "OrderedDict[str, _TurnState]" = OrderedDict()
        # session_id -> platform, learned from turn.start (the only observed event that
        # carries it). The platform filter needs it on *every* event in the session, not
        # just the one that reports it, or a notice posted on a later event (a rate limit,
        # a tool failure) leaks onto a messaging platform the filter was meant to exclude.
        self._session_platform: "OrderedDict[str, str]" = OrderedDict()
        # Remembers which chats already had a cost reminder, so it does not repeat.
        self._cost = CostWatch()
        # Where the digest's on/off switch lives. Read fresh each turn so a /omni
        # command or the viewer's settings take effect without a restart.
        self._prefs_reader = prefs_reader if prefs_reader is not None else prefs_mod.defaults
        # Sessions that have already been told how to turn the digest off.
        self._hinted: "OrderedDict[str, None]" = OrderedDict()
        # Prefs are read from a small file; a short cache keeps an event loop off the disk.
        self._prefs_cache: Optional[dict] = None
        self._prefs_at: float = 0.0
        # api_request_id -> provider (LRU, capped)
        self._providers: "OrderedDict[str, str]" = OrderedDict()
        # api_request_id -> model (LRU, capped)
        self._models: "OrderedDict[str, str]" = OrderedDict()
        # Set the first time observe() fails, so that failure is reported once and not per hook.
        self._observe_error_logged = False

    def set_platform_filter(self, platforms: tuple) -> None:
        """Restrict notices to the given platforms (e.g. local surfaces only)."""
        self._platform_filter = tuple(platforms)

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------
    def observe(self, hook_name: str, kwargs: dict) -> None:
        """Observe a hook event. Never raises."""
        if not self._enabled:
            return
        try:
            self._observe_inner(hook_name, kwargs)
        except Exception:
            # Notices must never break the host - but a notice that silently stops appearing
            # is a bug the user cannot report, so the first failure of a launch is loud.
            if not self._observe_error_logged:
                self._observe_error_logged = True
                log.warning(
                    "omniscience: live notices hit an unexpected error; they may stop appearing",
                    exc_info=True,
                )
            else:
                log.debug("omniscience: live notice error", exc_info=True)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------
    def _observe_inner(self, hook_name: str, kwargs: dict) -> None:
        result = self._normalize(hook_name, kwargs)
        if result is None:
            return
        kind, ids, status, attrs, _natural_key = result

        session_id = ids.get("session_id")
        if not session_id:
            return

        # Helper sessions belong to a different chat; skip them, but a helper agent is
        # still part of the parent turn's cost, so count it there.
        if ids.get("parent_session_id"):
            if kind == "subagent.start":
                parent_state = self._sessions.get(ids["parent_session_id"])
                if parent_state is not None:
                    parent_state.facts.helpers += 1
            return

        # Platform filter: only post on allowed surfaces (default: local only). The real
        # normalize records the platform in attrs on turn.start, never in ids; remember it so
        # every later event in the same session is filtered by it too (those events carry no
        # platform of their own). An unknown platform is treated as local (fail open), matching
        # _LOCAL_PLATFORMS. (ids is also consulted for robustness to a normalize that puts it
        # there.)
        platform = attrs.get("platform")
        if platform is None:
            platform = ids.get("platform")
        if platform is not None:
            self._session_platform[session_id] = platform
            self._session_platform.move_to_end(session_id)
            while len(self._session_platform) > _MAX_SESSIONS:
                self._session_platform.popitem(last=False)
        if self._platform_filter is not None:
            effective = platform if platform is not None else self._session_platform.get(session_id)
            if effective is not None and effective not in self._platform_filter:
                return

        turn_id = ids.get("turn_id")

        # Remember provider and model per api_request_id (for later notices).
        api_request_id = ids.get("api_request_id")
        if kind == "llm.request" and api_request_id:
            provider = attrs.get("provider")
            if provider:
                self._remember_provider(api_request_id, provider)
            model = attrs.get("model")
            if model:
                self._remember_model(api_request_id, model)

        # Turn lifecycle.
        if kind == "turn.start":
            state = _TurnState()
            state.started_at = self._clock()
            self._sessions[session_id] = state
            self._sessions.move_to_end(session_id)
            self._evict_sessions()
            return

        if kind == "turn.end":
            finished = self._sessions.pop(session_id, None)
            if finished is not None:
                self._post_digest(session_id, finished)
            return

        # All other notices need a turn state.
        state = self._sessions.get(session_id)
        if state is None:
            # No turn.start seen yet; create a fresh state lazily.
            state = _TurnState()
            self._sessions[session_id] = state
            self._sessions.move_to_end(session_id)
            self._evict_sessions()

        link = self._link_for(session_id)

        if kind == "llm.error":
            self._handle_llm_error(state, attrs, status, link, api_request_id)
        elif kind == "llm.response":
            self._handle_llm_response(state, attrs, api_request_id, link, session_id)
        elif kind == "tool.end":
            self._handle_tool_end(state, attrs, status, link)
        elif kind == "skill.event":
            name = attrs.get("skill_name")
            if isinstance(name, str) and name:
                state.facts.skills.append(name)
        elif kind == "aux.response":
            state.facts.aux += 1
        elif kind == "subagent.start":
            state.facts.helpers += 1

    # ------------------------------------------------------------------
    # Rule handlers
    # ------------------------------------------------------------------
    def _handle_llm_error(
        self,
        state: _TurnState,
        attrs: dict,
        status: Any,
        link: str,
        api_request_id: Optional[str] = None,
    ) -> None:
        reason = attrs.get("reason")
        status_code = attrs.get("status_code")

        is_rate_limit = reason == "rate_limit" or status_code == 429
        is_provider_error = reason == "timeout" or (
            isinstance(status_code, int) and status_code >= 500
        )

        if is_rate_limit:
            state.rate_count += 1
            state.facts.rate_limits = state.rate_count
            provider = plain_name(self._providers.get(api_request_id or "", "the provider"))
            if state.rate_count == 1:
                text = (
                    f"⚠ Omniscience: {provider} rate-limited this reply "
                    f"(429); Hermes is retrying. See what happened: {link}"
                )
                handle = self._post_new(state, text)
                state.rate_handle = handle
            else:
                text = (
                    f"⚠ Omniscience: {provider} rate-limited this reply "
                    f"{state.rate_count} times; Hermes is retrying. "
                    f"See what happened: {link}"
                )
                self._edit_existing(state.rate_handle, text)
            return

        if is_provider_error and not state.provider_error_shown:
            state.provider_error_shown = True
            detail = plain_name(reason if reason else status_code, limit=120)
            text = (
                f"⚠ Omniscience: the provider returned an error "
                f"({detail}); Hermes may retry. Details: {link}"
            )
            self._post_new(state, text)

    def _handle_llm_response(
        self,
        state: _TurnState,
        attrs: dict,
        api_request_id: Optional[str],
        link: str,
        session_id: Optional[str] = None,
    ) -> None:
        # Fallback notice: compare request model vs response_model.
        request_model = self._models.get(api_request_id or "")
        response_model = attrs.get("response_model")
        facts = state.facts
        facts.calls += 1
        if request_model and response_model and request_model != response_model:
            pair = (request_model, response_model)
            if pair not in facts.switches:
                facts.switches.append(pair)
            pair = (request_model, response_model)
            if pair not in state.fallback_shown:
                state.fallback_shown.add(pair)
                text = (
                    f"↪ Omniscience: this reply was requested from {request_model} "
                    f"and answered by {response_model}. Details: {link}"
                )
                self._post_new(state, text)

        # Slow start notice.
        ttfb = attrs.get("ttfb_s")
        if isinstance(ttfb, (int, float)) and ttfb > _SLOW_TTFB_S:
            if not state.slow_shown:
                state.slow_shown = True
                provider = plain_name(self._providers.get(api_request_id or "", "the provider"))
                n = int(round(ttfb))
                text = (
                    f"⏳ Omniscience: the first words of this reply took {n} s to arrive "
                    f"({provider}). Details: {link}"
                )
                self._post_new(state, text)

        # Numbers for the end-of-turn summary.
        usage = attrs.get("usage")
        if isinstance(usage, dict):
            prompt = _int_or_none(usage.get("prompt_tokens"))
            cached = _int_or_none(usage.get("cache_read_tokens"))
            if prompt is None and _int_or_none(usage.get("input_tokens")) is not None:
                prompt = _int_or_none(usage.get("input_tokens")) + (cached or 0)
            output = _int_or_none(usage.get("output_tokens"))
            if prompt is not None:
                # A real drop means the provider compacted this chat mid-turn.
                previous = facts.prompt_last
                if previous and previous - prompt > 1000 and prompt < previous * 0.75:
                    facts.compacted = (previous, prompt)
                facts.prompt_last = prompt
                facts.peak = max(facts.peak or 0, prompt)
                facts.fresh_last = max(0, prompt - (cached or 0))
                facts.cache_share = min(1.0, (cached or 0) / prompt) if prompt else None
            if output is not None:
                facts.output = (facts.output or 0) + output

        # Cost reminder: this chat may be expensive to keep talking to. The turn summary
        # already carries this advice every turn, so the separate escalation is only for
        # "brief", which leaves token arithmetic out. Off means silent.
        if isinstance(usage, dict) and self._want_cost_reminder():
            reminder = self._cost.consider(
                session_id,
                usage.get("prompt_tokens"),
                usage.get("cache_read_tokens"),
            )
            if reminder is not None:
                text = reminder["text"]
                if reminder.get("repeat"):
                    text = f"{text} (still growing). Details: {link}"
                else:
                    text = f"{text} Details: {link}"
                self._post_new(state, text)

    def _handle_tool_end(
        self,
        state: _TurnState,
        attrs: dict,
        status: Any,
        link: str,
    ) -> None:
        tool_name = attrs.get("tool_name")
        if not tool_name:
            return

        facts = state.facts
        facts.tools += 1
        if attrs.get("mcp_server"):
            facts.mcp += 1
        duration_ms = attrs.get("duration_ms")
        if isinstance(duration_ms, (int, float)) and duration_ms >= 0:
            seconds = duration_ms / 1000.0
            if facts.slowest_s is None or seconds > facts.slowest_s:
                facts.slowest_s = seconds
                facts.slowest_name = tool_name

        if status == "error":
            facts.failures.append(tool_name)
            count = state.tool_fail_counts.get(tool_name, 0) + 1
            state.tool_fail_counts[tool_name] = count

            if count >= _TOOL_FAIL_THRESHOLD:
                hint = _TOOL_FAIL_HINTS.get(tool_name, _GENERIC_FAIL_HINT)
                text = (
                    f"⚠ Omniscience: {plain_name(tool_name)} failed "
                    f"{count} times in a row — {hint}. Details: {link}"
                )
                if tool_name not in state.tool_fail_notified:
                    state.tool_fail_notified.add(tool_name)
                    handle = self._post_new(state, text)
                    state.tool_fail_handles[tool_name] = handle
                else:
                    self._edit_existing(
                        state.tool_fail_handles.get(tool_name), text
                    )
        else:
            # Success resets the consecutive-failure counter.
            state.tool_fail_counts[tool_name] = 0

    # ------------------------------------------------------------------
    # End-of-turn summary
    # ------------------------------------------------------------------
    def _current_prefs(self) -> dict:
        """Prefs, cached for a couple of seconds so a busy turn is not reading the disk."""
        now = self._clock()
        if self._prefs_cache is not None and (now - self._prefs_at) < 2.0:
            return self._prefs_cache
        try:
            loaded = self._prefs_reader() or {}
        except Exception:
            loaded = {}
        if not isinstance(loaded, dict):
            loaded = {}
        self._prefs_cache = prefs_mod.normalize(loaded)
        self._prefs_at = now
        return self._prefs_cache

    def _want_cost_reminder(self) -> bool:
        """True only when the summary is on but too brief to mention tokens."""
        try:
            prefs = self._current_prefs()
            return prefs_mod.digest_enabled(prefs) and prefs_mod.detail_level(prefs) == "brief"
        except Exception:
            return False

    def _digest_on(self) -> bool:
        try:
            return prefs_mod.digest_enabled(self._current_prefs())
        except Exception:
            return True

    def _post_digest(self, session_id: str, state: _TurnState) -> None:
        """Send the turn summary into the chat, if the user still wants it."""
        prefs = self._current_prefs()
        if not prefs_mod.digest_enabled(prefs):
            return
        facts = state.facts
        if state.started_at:
            seconds = self._clock() - state.started_at
            if seconds > 0:
                facts.seconds = seconds
        hint = session_id not in self._hinted
        text = render_digest(facts, prefs_mod.detail_level(prefs), hint=hint)
        if not text:
            return
        if hint:
            self._hinted[session_id] = None
            while len(self._hinted) > _MAX_SESSIONS:
                self._hinted.popitem(last=False)
        self._post_message(text)

    # ------------------------------------------------------------------
    # Posting helpers
    # ------------------------------------------------------------------
    def _post_new(self, state: _TurnState, text: str) -> Any:
        if state.new_messages >= _MAX_NEW_MESSAGES_PER_TURN:
            return None
        handle = self._post_message(text)
        if handle is not None:
            state.new_messages += 1
        return handle

    def _post_message(self, text: str) -> Any:
        """Post on a background thread; return a handle whose edit() works before the post lands."""
        if self._ctx is None:
            return None
        post = getattr(self._ctx, "post_message", None)
        if post is None:
            return None
        handle = _DeferredHandle()

        def _do() -> None:
            try:
                handle._attach(post(text))
            except Exception:
                handle._attach(None)

        self._spawn(_do)
        return handle

    def _edit_existing(self, handle: Any, text: str) -> None:
        if handle is None:
            return
        edit = getattr(handle, "edit", None)
        if edit is None:
            return

        def _do() -> None:
            try:
                edit(text)
            except Exception:
                log.debug("omniscience: editing a live notice failed", exc_info=True)

        self._spawn(_do)

    # ------------------------------------------------------------------
    # Provider / model cache
    # ------------------------------------------------------------------
    def _remember_provider(self, api_request_id: str, provider: str) -> None:
        self._providers[api_request_id] = provider
        self._providers.move_to_end(api_request_id)
        while len(self._providers) > _MAX_PROVIDERS:
            self._providers.popitem(last=False)

    def _remember_model(self, api_request_id: str, model: str) -> None:
        self._models[api_request_id] = model
        self._models.move_to_end(api_request_id)
        while len(self._models) > _MAX_PROVIDERS:
            self._models.popitem(last=False)

    # ------------------------------------------------------------------
    # Session eviction
    # ------------------------------------------------------------------
    def _evict_sessions(self) -> None:
        while len(self._sessions) > _MAX_SESSIONS:
            self._sessions.popitem(last=False)
