import sys
from pathlib import Path

import tempfile as _tempfile

REPO = Path(__file__).resolve().parents[1]
# The repo root IS the plugin (so `hermes plugins install KeyArgo/hermes-omniscience` works).
# Tests import it as the package `omniscience` through a link in a temp dir.
PLUGIN_DIR = Path(_tempfile.mkdtemp(prefix="omni-pkg-"))
(PLUGIN_DIR / "omniscience").symlink_to(REPO, target_is_directory=True)
sys.path.insert(0, str(PLUGIN_DIR))
import os as _os0
_os0.environ["OMNI_TEST_PKG_DIR"] = str(PLUGIN_DIR)

# Never start a real viewer from tests.
import os as _os
_os.environ.setdefault("OMNISCIENCE_VIEWER_AUTOSTART", "0")
_os.environ.setdefault("OMNISCIENCE_IMPORT_HISTORY", "0")
