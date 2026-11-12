# Third-party notices

Omniscience is built for [Hermes Agent](https://github.com/NousResearch/hermes-agent), which
provides the observer hooks and ships FastAPI and uvicorn for the viewer.

The repository uses these projects. Each is covered by its own license; see the linked project for
the exact text.

| Project | Used for | Link |
|---|---|---|
| FastAPI | Viewer HTTP API | <https://github.com/fastapi/fastapi> |
| uvicorn | Viewer server | <https://github.com/encode/uvicorn> |
| websockets | Live feed | <https://github.com/python-websockets/websockets> |
| React | Web UI | <https://github.com/facebook/react> |
| @xyflow/react (React Flow) | Graph canvas | <https://github.com/xyflow/xyflow> |
| @dagrejs/dagre | Deterministic graph layout | <https://github.com/dagrejs/dagre> |
| Vite | Web build | <https://github.com/vitejs/vite> |
| Vitest | Front-end tests | <https://github.com/vitest-dev/vitest> |
| pytest | Python tests | <https://github.com/pytest-dev/pytest> |
| Hypothesis | Property-based tests | <https://github.com/HypothesisWorks/hypothesis> |
| httpx | Test HTTP client | <https://github.com/encode/httpx> |

The plugin runtime itself is standard-library only. Node and npm are needed only to rebuild `web/`.
