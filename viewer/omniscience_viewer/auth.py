"""Per-launch secret token auth for the local read-only viewer."""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
from typing import Any, Awaitable, Callable

log = logging.getLogger("omniscience")

TOKEN_FILE_NAME = "viewer-token"


def token_path(db_path: str) -> str:
    # realpath, not abspath: the dashboard reads the key next to the resolved database path, so a
    # symlinked profile folder has to produce the same filename for both.
    return os.path.join(os.path.dirname(os.path.realpath(db_path)), TOKEN_FILE_NAME)


def write_token(path: str) -> str:
    token = secrets.token_urlsafe(24)
    # Replace whatever is at the path instead of writing through it. The directory next to the
    # database is group-writable on some installs, and O_TRUNC on a symlink would hand the key
    # to the link's target. O_EXCL + O_NOFOLLOW make the create fail rather than follow.
    if os.path.lexists(path):  # lexists: a broken symlink counts as something to replace
        os.unlink(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        os.write(fd, token.encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        # The file was created 0600; this only re-asserts it. ensure_token() checks the mode
        # before reusing a key, so a failure here costs a new key, not a leak.
        log.debug("omniscience: could not restrict %s to 0600", path, exc_info=True)
    return token


def ensure_token(path: str) -> str:
    """Reuse the existing key when it is still private to this user, else make a new one.

    Keeping the key across viewer restarts means pages already open (a browser tab, a /omni link)
    keep working after the viewer restarts with Hermes. The file stays 0600; any looser file, a
    file owned by someone else, or a malformed key is replaced.
    """
    try:
        st = os.stat(path)
        if st.st_uid == os.getuid() and (st.st_mode & 0o077) == 0:
            existing = read_token(path)
            if existing and len(existing) >= 24 and all(c.isalnum() or c in "-_" for c in existing):
                return existing
    except (OSError, AttributeError):
        pass
    return write_token(path)


def read_token(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            value = fh.read().strip()
    except OSError:
        return None
    return value or None


def token_ok(expected: str | None, presented: str | None) -> bool:
    if expected is None:
        return True
    if not presented:
        return False
    return hmac.compare_digest(str(expected), str(presented))


class TokenMiddleware:
    """Pure ASGI middleware enforcing the per-launch token on /api/ paths.

    The token lives in a shared mutable holder (``token_state``) so a token that is
    generated *after* the app is constructed (written to disk on server bind) still
    takes effect: every request reads the current value from the dict. ``token`` is
    kept as a plain fallback for callers that know the token up front (tests).
    HTTP carries the token only in the ``X-Omni-Token`` header; the ``t=`` query
    parameter is accepted for the WebSocket handshake only (browsers cannot set a
    header on ``new WebSocket``), and never for plain HTTP requests.
    """

    def __init__(self, app: Any, token: str | None = None,
                 token_state: dict[str, str | None] | None = None) -> None:
        self.app = app
        self.token = token
        self.token_state = token_state

    def _effective_token(self) -> str | None:
        if self.token_state is not None:
            candidate = self.token_state.get("token")
            if candidate is not None:
                return candidate
        return self.token

    async def __call__(self, scope: dict, receive: Callable[[], Awaitable[dict]], send: Callable[[dict], Awaitable[None]]) -> None:
        scope_type = scope.get("type")
        if scope_type not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if not path.startswith("/api/"):
            await self.app(scope, receive, send)
            return

        if path == "/api/v1/ping":
            await self.app(scope, receive, send)
            return

        token = self._effective_token()
        if token is None:
            await self.app(scope, receive, send)
            return

        presented = self._presented(scope)
        if token_ok(token, presented):
            await self.app(scope, receive, send)
            return

        if scope_type == "http":
            await self._reject_http(send)
        else:
            await self._reject_websocket(send)

    def _presented(self, scope: dict) -> str | None:
        # The token is never taken from a URL query string — for HTTP it must be the
        # X-Omni-Token header, and for the WebSocket it must be the omni.<token>
        # subprotocol. This keeps the per-launch key out of browser history, referrers
        # and access logs.
        headers = scope.get("headers") or []
        for raw_name, raw_value in headers:
            try:
                name = raw_name.decode("latin-1").lower()
            except Exception:
                continue
            if name == "x-omni-token":
                try:
                    return raw_value.decode("latin-1")
                except Exception:
                    return None
            if scope.get("type") == "websocket" and name == "sec-websocket-protocol":
                try:
                    value = raw_value.decode("latin-1")
                except Exception:
                    return None
                for part in value.split(","):
                    part = part.strip()
                    if part.startswith("omni."):
                        return part[len("omni."):]
        return None

    async def _reject_http(self, send: Callable[[dict], Awaitable[None]]) -> None:
        body = json.dumps({"detail": "token required"}).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def _reject_websocket(self, send: Callable[[dict], Awaitable[None]]) -> None:
        await send({"type": "websocket.close", "code": 4401})
