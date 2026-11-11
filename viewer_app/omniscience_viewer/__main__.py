"""``python -m omniscience_viewer --db PATH``."""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time


def resolve_db_path(args_db: str | None, environ: dict[str, str]) -> tuple[str, str]:
    if args_db:
        return args_db, "--db"
    env_db = environ.get("OMNISCIENCE_DB")
    if env_db:
        return env_db, "OMNISCIENCE_DB"
    hermes_home = environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    return os.path.join(hermes_home, "plugin-data", "omniscience", "events.db"), "HERMES_HOME default"


def default_db_path() -> str:
    return resolve_db_path(None, dict(os.environ))[0]


def default_static_dir() -> str | None:
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    shipped = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
    for candidate in (os.path.join(repo_root, "web", "dist"), shipped):
        if os.path.isfile(os.path.join(candidate, "index.html")):
            return candidate
    return None


def build_demo_db() -> str:
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    demo_dir = os.path.join(repo_root, "demo")
    if demo_dir not in sys.path:
        sys.path.insert(0, demo_dir)
    import synth

    # Start the showcase run a few minutes ago, so the demo reads as fresh rather than months old.
    synth.BASE_TS = time.time() - 900
    db_path = os.path.join(tempfile.mkdtemp(prefix="omniscience-demo-"), "events.db")
    synth.write_db(db_path, synth.build_showcase_events())
    return db_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the Hermes Omniscience viewer.")
    parser.add_argument("--db", default=None, help="events SQLite DB path")
    parser.add_argument("--demo", action="store_true", help="serve a synthetic demo database")
    parser.add_argument("--host", default="127.0.0.1", help="bind host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8797, help="bind port (default 8797)")
    parser.add_argument("--static", default=None, help="static web/dist directory")
    parser.add_argument("--no-token", action="store_true", help="disable per-launch token auth")
    parser.add_argument(
        "--version",
        action="store_true",
        help="print this build's version, commit and date, then exit",
    )
    args = parser.parse_args(argv)

    if args.version:
        from .version_stamp import describe

        print(describe())
        return 0

    if args.demo and args.db:
        print("omniscience-viewer: --demo and --db cannot be used together", file=sys.stderr)
        return 2

    if args.demo:
        db_path = build_demo_db()
    else:
        db_path, source = resolve_db_path(args.db, dict(os.environ))
        if not os.path.isfile(db_path):
            print(f"omniscience-viewer: no events database at {db_path}", file=sys.stderr)
            print(
                f"omniscience-viewer: resolved from {source}; pass --demo to serve synthetic data",
                file=sys.stderr,
            )
            return 2

    static_dir = args.static if args.static is not None else default_static_dir()

    import uvicorn

    from .app import create_app

    from .app import LOCAL_HOSTS
    from .auth import token_path, write_token

    token: str | None = None
    token_file: str | None = None
    if not args.no_token and not args.demo:  # demo data is synthetic, nothing to protect
        token_file = token_path(db_path)
        # Token will be written after successful bind (see startup event below)

    hosts = LOCAL_HOSTS if args.host in LOCAL_HOSTS else LOCAL_HOSTS + [args.host]
    app = create_app(db_path, static_dir, allowed_hosts=hosts, token=token)

    # Register a startup event that writes the token only after the server has bound.
    # This prevents a second viewer from overwriting the token file before the first
    # viewer has successfully bound to the port.
    if token_file is not None:
        from .auth import ensure_token as _write_token  # stable across restarts (see ensure_token)

        @app.on_event("startup")
        async def _publish_token() -> None:
            nonlocal token
            token = _write_token(token_file)
            # Publish into the same holder the registered TokenMiddleware reads from, so
            # the per-launch token is enforced on every /api request. create_app stored
            # the holder dict on app.state.token_state and gave that same dict to the
            # middleware, so mutating it here updates the live instance.
            state = getattr(app.state, "token_state", None)
            if isinstance(state, dict):
                state["token"] = token

    # Never print the token to stdout/stderr — it must not appear in logs.
    # The user can find it in the token file if needed.

    uvicorn.run(app, host=args.host, port=args.port, access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
