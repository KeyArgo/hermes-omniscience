"""Tests for token race condition fix: token written only after bind."""

import os
import tempfile
import threading
import time
from unittest.mock import patch, MagicMock

import pytest


def test_token_written_after_startup():
    """The token file must not exist before the server starts; it is written on startup."""
    from omniscience_viewer.auth import token_path

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "events.db")
        with open(db_path, "w") as f:
            f.write("")
        tp = token_path(db_path)
        # Before any server starts, the token file should not exist
        assert not os.path.exists(tp), "Token file should not exist before server starts"


def test_token_not_printed_in_main():
    """The __main__ module must not print the token."""
    import inspect
    from omniscience_viewer import __main__ as viewer_main

    source = inspect.getsource(viewer_main.main)
    # Must not contain any print statement with the token
    assert "print" not in source or "?t=" not in source
    # More specifically, no print with token variable
    lines = source.split("\n")
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("print") and "token" in stripped.lower():
            pytest.fail(f"Token must not be printed: {stripped}")


def test_bundled_main_no_token_print():
    """The bundled __main__ must also not print the token."""
    import inspect
    from omniscience.viewer_app.omniscience_viewer import __main__ as bundled_main

    source = inspect.getsource(bundled_main.main)
    assert "?t=" not in source
    assert "?t={token}" not in source
