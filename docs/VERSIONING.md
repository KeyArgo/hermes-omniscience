# Versioning and documentation currency

One rule under everything here: **a person must be able to tell, from inside the product, exactly
which build they are looking at, and whether the docs on screen describe it.** Everything below
exists to make that true without anyone remembering to do it.

## What the number means right now

There are two numbers, and confusing them is what makes "is it 1.0.0?" unanswerable:

| | Value today | Meaning |
|---|---|---|
| **Release the tree targets** | `1.0.0` (in `plugin.yaml`) | the number that will be tagged when the release is published |
| **This build** | `1.0.0-dev.183` (in `BUILD_INFO.json`) | pre-release: 183 commits into that target |

The build number is `git rev-list --count HEAD`, written by `deploy.sh` on every deploy. So no two
builds share a name, a build never claims to be a release it is not, and the count only resets when
a release is actually tagged. The header chip shows all three facts — `v1.0.0-dev.183 · 2026-11-09 ·
ec95a4cb` — because a version without a date cannot say whether a screenshot is from this morning or
last week.

**Nothing is tagged yet.** `git tag` currently holds one historic `v0.1.0` from an early branch, and
no tag is an ancestor of `main`. Until `v1.0.0` is created, every build reads `-dev.N`, which is the
honest answer to "is it released?".

Alpha/beta labels are deliberately not used: a phase name says nothing about which code is running,
and `-dev.183` does. If a freeze is wanted before the demo, `1.0.0-rc.1` is the SemVer-correct way to
say it, and it sorts below `1.0.0`.

## The version number

SemVer, and the public release of every plugin in the suite is **1.0.0**. The 0.x history belongs
in `CHANGELOG.md`, not in the version string.

| Change | Bump |
|---|---|
| a fix | `PATCH` |
| a new feature | `MINOR` |
| a manifest or config break | `MAJOR` |

The number lives in exactly one place, `plugin.yaml`, and is read at runtime. It is never compiled
into the bundle: a version typed into JavaScript drifts the moment the manifest moves, and the
drift is invisible.

**Never put a commit or a date in `version:`.** It cannot be ordered by tooling, and a date is
wrong the moment you rebuild. Commit and date belong in the build stamp.

Dev builds, when they need naming, are `1.0.0-dev.12+g12e8535`: SemVer-legal, sorts correctly,
and unmistakably not a release.

## Three layers, three questions

| Layer | Written by | Answers |
|---|---|---|
| `version:` in `plugin.yaml` | you | what `hermes plugins list` shows |
| `BUILD_INFO.json` in the installed plugin | `scripts/deploy.sh` | which commit and date the running code came from, and whether the tree was dirty |
| `.install-metadata.json` under `~/.hermes/plugins/` | Hermes at install | which source and revision Hermes installed |

`BUILD_INFO.json` is generated at deploy time, never committed: a committed stamp is stale by the
next commit.

## Where a person sees it

- **In the app:** a chip in the header, `v1.0.0 · 12e8535`, read from `GET /api/v1/version`. It
  turns amber and says `modified` when the installed copy came from a dirty tree. Clicking it
  copies the line for a bug report.
- **On the command line:** `omniscience_viewer --version` prints the same line.
- **Over HTTP:** `GET /api/v1/version` returns version, full commit, commit date, build time,
  dirty flag, and the build marker of the static bundle being served.

All three read `version_stamp.py` (vendored from the suite template), which resolves
`BUILD_INFO.json` → live `git` → `plugin.yaml` → `unknown`. It never invents a commit.

## Deploying, the one-command way

```bash
bash scripts/deploy.sh
```

It builds, installs, **syncs the built tree over the install** (Hermes re-applies local edits on
top of an update, which is how a file can keep serving old code), stamps `BUILD_INFO.json` in the
installed root and the installed package, restarts the viewer by pid, and prints the live line:

```
==> Live build:
  1.0.0 · 12e8535 · 2026-11-09
  build marker 1794271820-843
```

If that line is not what you expect, the page you are looking at is not what you built.

## Documentation currency

Docs rot in a specific way: a feature changes and the guide keeps describing the old one. The fix
is mechanical, not disciplinary.

Every living guide opens with:

```
> **Applies to:** Omniscience 1.0.0 · written at commit ec95a4c
> **Revised:** 2026-11-09 · **Body hash:** a559900f


```

- **Applies to** comes from `plugin.yaml` and git at stamp time.
- **Revised** moves only when the body actually changes, because the hash says so.
- **Body hash** is the enforcement: edit a guide and the hash stops matching.

```bash
python3 scripts/docs-stamp.py --check    # exit 1 when any guide is behind
python3 scripts/docs-stamp.py --write    # restamp what changed, today's date
python3 scripts/docs-stamp.py --index    # rebuild docs/DOC-INDEX.md
python3 scripts/docs-stamp.py --all      # index, write, check
```

`tests/test_docs_currency.py` runs `--check` in the suite, so a guide that no longer matches the
code fails the tests. Dated snapshots (`docs/handover/`, `docs/design/`) are excluded on purpose:
a handover describes one moment, and restamping it would make it describe a build it never saw.

## Release checklist

1. `plugin.yaml` version bumped to the number this release will carry; `CHANGELOG.md` entry written
   under that version, with the date.
2. `python3 scripts/docs-stamp.py --write` then `--index`, and **read the diff**: every guide must
   still describe the product, not merely carry a fresh stamp. The stamp proves you looked; it
   cannot prove you looked carefully.
3. Full suites green: Python and web.
4. `bash scripts/deploy.sh`; the printed line matches the version and commit you intend to release.
5. Reload the page; the header chip matches that line.
6. `git tag -a v<version> -m "<one line>"`, push the tag with the branch.
7. Publish: the public repo gets a clean `Initial release` commit (see the suite publishing
   standard), not this development history. After tagging, the next `deploy.sh` reports
   `1.0.0` with no `-dev` suffix, because the count restarts from the tag.

## Pitfalls that produce a confident wrong answer

- **An install is a copy, not a symlink.** Editing the dev tree changes nothing that runs. Prove it
  with `readlink -f ~/.hermes/plugins/omniscience`; `deploy.sh` is the fix.
- **`hermes plugins update --force` restores local edits.** It prints "Local changes were
  re-applied on top of the update", which means an edited installed file can keep its old content
  while the repo moves on. `deploy.sh` syncs over it; if you deploy by hand, check the file, not
  the command's exit code.
- **The security scan blocks the update** on this repo (`CAUTION`, findings mostly in handover docs
  quoting shell commands), hence `--force`.
- **A stamp written before the commit is a lie.** Stamp after committing, or accept
  `(modified)` and fix it before release.
