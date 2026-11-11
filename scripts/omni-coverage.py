"""Statement coverage for the plugin without installing anything.

The project venv has no pip, so pytest-cov is unavailable. This walks the AST to count statements
per module, then runs the suite under sys.settrace and records which of those lines executed.

    PYTHONPATH=viewer:viewer_app:. .venv/bin/python scripts/omni-coverage.py
"""

import ast
import collections
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIRS = ("viewer/omniscience_viewer", "dashboard", "analysis/omniscience_analysis")

targets = {}
for d in DIRS:
    for name in sorted(os.listdir(os.path.join(ROOT, d))):
        if not name.endswith(".py"):
            continue
        path = os.path.join(ROOT, d, name)
        tree = ast.parse(open(path, encoding="utf-8").read(), path)
        lines = {
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.stmt) and not isinstance(node, (ast.FunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom))
        }
        targets[os.path.realpath(path)] = lines

executed = collections.defaultdict(set)


def tracer(frame, event, arg):
    if event != "line":
        return tracer
    name = frame.f_code.co_filename
    if name in targets:
        executed[name].add(frame.f_lineno)
    return tracer


def main():
    import pytest

    sys.settrace(tracer)
    code = pytest.main(["-q", "tests", "-p", "no:cacheprovider", "-x", "--deselect=tests/test_scale.py"])
    sys.settrace(None)

    rows = []
    total_hit = total_all = 0
    for path, lines in targets.items():
        if not lines:
            continue
        hit = len(lines & executed.get(path, set()))
        total_hit += hit
        total_all += len(lines)
        rows.append((hit / len(lines), hit, len(lines), os.path.relpath(path, ROOT)))

    rows.sort()
    print("\n" + "=" * 78)
    print(f"{'cover':>6} {'hit':>5} {'stmts':>6}  module")
    for pct, hit, alln, rel in rows:
        flag = "" if pct > 0.6 else ("   <-- thin" if pct > 0.15 else "   <-- UNTESTED")
        print(f"{pct*100:5.1f}% {hit:5d} {alln:6d}  {rel}{flag}")
    print(f"{'':>6} {total_hit:5d} {total_all:6d}  TOTAL {total_hit/total_all*100:.1f}%")
    return code


if __name__ == "__main__":
    sys.exit(main())
