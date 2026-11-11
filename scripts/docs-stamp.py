#!/usr/bin/env python3
"""Keep the documentation honest about which build it describes.

Every guide in `docs/` opens with a stamp:

    > **Applies to:** Omniscience 1.0.0 · commit 12e8535
    > **Revised:** 2026-11-09 · **Body hash:** 4f1c9ab2

Three things make that stamp worth reading:

* **Version and commit** come from `plugin.yaml` and git at stamp time, so a reader knows the
  doc describes the build they are running, or that it does not.
* **Revised** is a date, not a hope: it moves only when the body actually changes, because the
  body hash is stored next to it.
* **The hash** is the enforcement. `--check` fails when a body has been edited without being
  re-stamped, which is how "we changed a colour and forgot the docs" gets caught instead of
  discovered months later.

Usage:

    python3 scripts/docs-stamp.py --check      # exit 1 if any doc is behind
    python3 scripts/docs-stamp.py --write      # restamp what changed, today's date
    python3 scripts/docs-stamp.py --index      # rewrite docs/DOC-INDEX.md
    python3 scripts/docs-stamp.py --all        # index, then write, then check
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DOCS = REPO / "docs"
INDEX = DOCS / "DOC-INDEX.md"

# Directories that hold dated snapshots rather than living guides. A handover describes one
# moment and must not be restamped: rewriting its version would make it describe a build it
# never saw.
SKIP_DIRS = {"handover", "design", "img"}

STAMP_RE = re.compile(r"^> \*\*Applies to:\*\* (.+?)$", re.MULTILINE)
REVISED_RE = re.compile(r"^> \*\*Revised:\*\* (\d{4}-\d{2}-\d{2}) · \*\*Body hash:\*\* ([0-9a-f]{8})$", re.MULTILINE)

# What each document is for, in one line. Kept here so the index cannot drift from the docs.
COVERS: dict[str, str] = {
    "README": "What the plugin is, how to install it, what it looks like",
    "ARCHITECTURE": "Components, data flow, the event store and the viewer",
    "COVERAGE": "Which Hermes hooks are subscribed to, and what is deliberately not seen",
    "DECISIONS": "The decisions that shaped the design, with the reasoning",
    "DEMO": "The 90-second demo script and the shots it needs",
    "DOC-INDEX": "This map: every document, what it covers, which build it describes",
    "DRYRUN": "A recorded first-run on Windows 11, step by step",
    "FAQ": "Short answers to the questions that come up first",
    "HERMES_INTEGRATION": "Verified hook payloads and Hermes version compatibility",
    "INSTALL": "Install, run, upgrade and remove the plugin",
    "ISSUE-TRACKER": "Every known defect, unproven claim and queued request, with status",
    "REQUESTS-AUDIT": "Every request, its status, and what the owner should check",
    "RESEARCH": "Prior art and where Omniscience differs",
    "ROADMAP": "What is built, what is next, what is parked",
    "SECURITY": "Threat model, collection policy, what leaves the machine",
    "TROUBLESHOOTING-DIRECTION": "The product contract for finding a problem and explaining it",
    "USER-GUIDE": "How to read the viewer: views, colours, timings, exports",
    "VERSIONING": "The version scheme, the build stamp, and the documentation currency rule",
}


@dataclass
class Doc:
    path: Path
    text: str
    body: str

    @property
    def rel(self) -> str:
        return str(self.path.relative_to(REPO))

    @property
    def name(self) -> str:
        return self.path.stem

    @property
    def title(self) -> str:
        match = re.search(r"^# (.+)$", self.body, re.MULTILINE)
        return match.group(1).strip() if match else self.name.replace("_", " ").title()

    @property
    def stamped_version(self) -> str | None:
        """Just the version ("1.0.0").

        The commit is recorded as *when the statement was true*, not as a thing to match: every
        commit after a guide is stamped would otherwise mark every guide behind, and a check that
        fails constantly gets ignored. What must match is the version and the body hash.
        """
        match = STAMP_RE.search(self.text)
        if not match:
            return None
        line = match.group(1).strip().removeprefix("Omniscience ").strip()
        return line.split(" · ")[0].strip()

    @property
    def revised(self) -> str | None:
        match = REVISED_RE.search(self.text)
        return match.group(1) if match else None

    @property
    def stored_hash(self) -> str | None:
        match = REVISED_RE.search(self.text)
        return match.group(2) if match else None

    def computed_hash(self) -> str:
        # Blank-line runs are normalised so inserting the stamp itself cannot change the hash.
        canonical = re.sub(r"\n{3,}", "\n\n", self.body.strip())
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:8]


def manifest_version() -> str:
    for line in (REPO / "plugin.yaml").read_text(encoding="utf-8").splitlines():
        if line.startswith("version:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return "unknown"


def head_commit() -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO), "rev-parse", "--short=7", "HEAD"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        return out.stdout.strip() or "unknown"
    except OSError:
        return "unknown"


def split_stamp(text: str) -> tuple[str, str]:
    """Return (body, header) where header is the stamped block, or ("", body)."""
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith("> **Applies to:**"):
            end = index
            while end < len(lines) and (lines[end].startswith(">") or not lines[end].strip()):
                end += 1
            header = "".join(lines[index:end])
            body = "".join(lines[:index] + lines[end:])
            return body, header
    return text, ""


def load_docs() -> list[Doc]:
    docs: list[Doc] = []
    for path in sorted(DOCS.rglob("*.md")):
        if any(part in SKIP_DIRS for part in path.relative_to(DOCS).parts[:-1]):
            continue
        if path.name == "DOC-INDEX.md":
            continue
        text = path.read_text(encoding="utf-8")
        body, _ = split_stamp(text)
        docs.append(Doc(path=path, text=text, body=body))
    return docs


def stamp_for(version: str, commit: str, revised: str, body_hash: str) -> str:
    return (
        f"> **Applies to:** Omniscience {version} · written at commit {commit}\n"
        f"> **Revised:** {revised} · **Body hash:** {body_hash}\n\n"
    )


def insert_stamp(doc: Doc, block: str) -> str:
    """Put the stamp right after the title, so it reads before the first paragraph."""
    lines = doc.body.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith("# "):
            lines.insert(index + 1, "\n" + block)
            return "".join(lines)
    return block + doc.body


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="report docs that are behind; exit 1 if any")
    parser.add_argument("--write", action="store_true", help="restamp docs whose body changed")
    parser.add_argument("--index", action="store_true", help="rewrite docs/DOC-INDEX.md")
    parser.add_argument("--all", action="store_true", help="index, write, then check")
    parser.add_argument("--date", default=None, help="revised date to use (default: today)")
    args = parser.parse_args(argv)

    if args.all:
        args.index = args.write = args.check = True
    if not (args.check or args.write or args.index):
        parser.print_help()
        return 2

    version = manifest_version()
    commit = head_commit()
    today = args.date or _dt.date.today().isoformat()

    docs = load_docs()
    problems: list[str] = []
    changed: list[str] = []

    if args.write:
        for doc in docs:
            body_hash = doc.computed_hash()
            if doc.stored_hash == body_hash and doc.stamped_version == version:
                continue
            revised = doc.revised if doc.stored_hash == body_hash and doc.revised else today
            block = stamp_for(version, commit, revised, body_hash)
            new_text = insert_stamp(doc, block) if doc.stored_hash is None else _replace_header(doc, block)
            doc.path.write_text(new_text, encoding="utf-8")
            changed.append(doc.rel)
        docs = load_docs()

    for doc in docs:
        if doc.stamped_version is None:
            problems.append(f"{doc.rel}: no 'Applies to' stamp")
            continue
        if doc.stamped_version != version:
            problems.append(f"{doc.rel}: stamped for {doc.stamped_version!r}, manifest is {version}")
        if doc.stored_hash != doc.computed_hash():
            problems.append(f"{doc.rel}: body changed since it was stamped ({doc.revised})")

    if args.index:
        INDEX.write_text(render_index(docs, version, commit, today), encoding="utf-8")
        print(f"wrote {INDEX.relative_to(REPO)}")

    for rel in changed:
        print(f"stamped {rel}")

    if args.check:
        if problems:
            print(f"{len(problems)} document(s) behind the code:", file=sys.stderr)
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            print("run: python3 scripts/docs-stamp.py --write", file=sys.stderr)
            return 1
        print(f"all {len(docs)} documents describe {version} (tree at {commit})")
    return 0


def _replace_header(doc: Doc, block: str) -> str:
    text = doc.text
    start = text.find("> **Applies to:**")
    if start < 0:
        return insert_stamp(doc, block)
    end = start
    while end < len(text):
        line_end = text.find("\n", end)
        if line_end < 0:
            end = len(text)
            break
        if not text[end:line_end].startswith(">"):
            break
        end = line_end + 1
    return text[:start] + block + text[end:]


def render_index(docs: list[Doc], version: str, commit: str, today: str) -> str:
    rows = []
    for doc in docs:
        covers = COVERS.get(doc.name, "")
        revised = doc.revised or "—"
        behind = "behind" if doc.stored_hash != doc.computed_hash() else "current"
        rows.append(f"| [{doc.name}]({doc.name}.md) | {doc.title} | {covers} | {revised} | {behind} |")
    table = "\n".join(rows)
    return f"""# Documentation index

Every guide below describes **Omniscience {version}** (commit {commit}). The date on each row is
the last time its body changed; a row reading *behind* means the file was edited without being
restamped, and `python3 scripts/docs-stamp.py --check` treats that as an error.

Regenerate this page with `python3 scripts/docs-stamp.py --index`. Generated {today}.

| Document | Title | What it covers | Revised | State |
|---|---|---|---|---|
{table}

## How the stamp works

Each document opens with the build it was written against and a hash of its own body:

```
> **Applies to:** Omniscience {version} · commit {commit}
> **Revised:** <date the body last changed> · **Body hash:** <first 8 hex of sha256(body)>
```

The version comes from `plugin.yaml`, the commit from git, and the hash from the text, so none of
the three can be typed in wrong and left there. Edit a guide and the hash stops matching; the check
then fails until the stamp is rewritten, which is the moment to re-read whether the guide still
describes the product.

Dated snapshots — `docs/handover/`, `docs/design/` — are deliberately excluded: a handover
describes one moment and restamping it would make it describe a build it never saw.
"""


if __name__ == "__main__":
    raise SystemExit(main())
