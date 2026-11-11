"""The brake: ask Hermes' own run API to stop a chat, when that API is switched on.

Omniscience records runs; Hermes drives them. The one honest way to stop a run from here is the
host's own control channel (``POST /v1/runs/{run_id}/stop``). That channel is opt-in: ``scripts/
brake.sh on`` enables it and writes the URL and token this module reads. With no such file there is
no brake, and the viewer says so instead of pretending.

Nothing here raises: every failure comes back as ``{"ok": False, "reason": ...}`` in words, because
the answer is shown to a person who just pressed a button.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

TIMEOUT_S = 4.0


def config_path(state_dir: str) -> str:
    return os.path.join(state_dir, "brake.json")


def load_config(state_dir: str) -> dict | None:
    """The brake's URL and token, or None when it is switched off."""
    try:
        with open(config_path(state_dir), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    url = data.get("url")
    token = data.get("token")
    if not isinstance(url, str) or not url.startswith("http"):
        return None
    if not isinstance(token, str) or not token:
        return None
    return {"url": url.rstrip("/"), "token": token}


def find_run(payload: object, session_id: str) -> str | None:
    """Pick the run id that belongs to this chat, from whatever the API listed.

    Accepts both shapes the API has used: a bare list, or ``{"runs": [...]}``. A run may name the
    session as ``session_id``, ``session`` or ``conversation_id``.
    """
    rows: list = []
    if isinstance(payload, dict):
        for key in ("runs", "data", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                rows = value
                break
    elif isinstance(payload, list):
        rows = payload

    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in ("session_id", "session", "conversation_id", "chat_id"):
            if row.get(key) == session_id:
                run_id = row.get("id") or row.get("run_id")
                if isinstance(run_id, str) and run_id:
                    return run_id
    return None


def _request(url: str, token: str, method: str = "GET", body: dict | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


def stop_run(state_dir: str, session_id: str, action: str = "stop") -> dict:
    """Stop the chat behind this session, if the host API is enabled and knows the run."""
    config = load_config(state_dir)
    if config is None:
        return {
            "ok": False,
            "action": action,
            "session_id": session_id,
            "reason": (
                "Omniscience cannot stop or skip anything inside a Hermes run: it records the run, "
                "it does not drive it. Turn the brake on with scripts/brake.sh on to give it that "
                "control, or act from Hermes itself."
            ),
        }
    try:
        listing = _request(f"{config['url']}/v1/runs", config["token"])
    except urllib.error.HTTPError as exc:
        return {"ok": False, "action": action, "session_id": session_id,
                "reason": f"The run API refused the listing ({exc.code})."}
    except (urllib.error.URLError, TimeoutError, ValueError):
        return {"ok": False, "action": action, "session_id": session_id,
                "reason": "The run API is not answering; the brake is on but unreachable."}

    run_id = find_run(listing, session_id)
    if run_id is None:
        return {"ok": False, "action": action, "session_id": session_id,
                "reason": (
                    "The run API does not know this chat as a run — it was most likely started in "
                    "the desktop app or the CLI, which the API does not drive."
                )}
    if action == "skip":
        return {"ok": False, "action": action, "session_id": session_id, "run_id": run_id,
                "reason": "The API can stop a run but cannot skip a single tool call inside it yet."}
    try:
        _request(f"{config['url']}/v1/runs/{run_id}/stop", config["token"], method="POST", body={})
    except urllib.error.HTTPError as exc:
        return {"ok": False, "action": action, "session_id": session_id, "run_id": run_id,
                "reason": f"The run API refused the stop ({exc.code})."}
    except (urllib.error.URLError, TimeoutError, ValueError):
        return {"ok": False, "action": action, "session_id": session_id, "run_id": run_id,
                "reason": "The stop was sent but the run API did not answer."}
    return {"ok": True, "action": action, "session_id": session_id, "run_id": run_id,
            "reason": "Stop requested: the run API was told to end this run."}
