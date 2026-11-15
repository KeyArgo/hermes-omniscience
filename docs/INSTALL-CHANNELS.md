# Omniscience install channels

> **Applies to:** Omniscience 1.0.0 · written at commit 2f13567
> **Revised:** 2026-11-14 · **Body hash:** f7b8e37b




Use one explicitly named source per channel. Always resolve and report the full commit SHA; an installed file and a running Desktop pane may be different versions until Hermes is reloaded.

## Stable

The stable catalog build is the commit pinned by the official Hermes catalog. Do not describe an unmerged test or development build as stable.

## Test

The current test source is `refs/heads/fix/omni-cross-platform` in `KeyArgo/hermes-omniscience`. Resolve that exact ref to a full commit SHA, then install that commit. As of this policy draft it contains the Teknium review and cross-platform fixes; the interface redesign is a separate, unfinished branch.

Before changing the test source, verify the intended commit and its checks, preserve a rollback path, and obtain the owner's approval for the push. Report the channel, full SHA, test results, and any unverified platforms. Never promote uncommitted or untested work.

The draft helper `scripts/install-omniscience-test.py` uses the same authoritative test ref on all platforms, displays the resolved SHA, and does not silently fall back to a different branch. Run it from a copy of this repository with `python3 scripts/install-omniscience-test.py` on Linux or `py -3 scripts/install-omniscience-test.py` on Windows (`python` is an alternative if `py` is unavailable). Add `--dry-run` to resolve the commit without installing. Git, Python, Hermes and internet access are required. A real run uses `--force` and `--enable`: it replaces the installed Omniscience build with the test build and enables it. Hermes may ask for dependency consent. The helper is not available to other machines from the public repository until it is published.

After installing, reload Hermes when sessions are idle and verify the running Desktop pane as well as the files on disk. The helper resolves a branch; it does not itself verify CI or protect against an unreviewed change to that branch. Those are promotion responsibilities.

`test/omniscience` is a proposed clearer permanent branch name, not an existing channel. Do not switch an installer or these instructions to it until the branch has been published with the owner's approval. Make that a single documented cutover: there must not be two competing test pointers.

## For agents

Read this file before selecting, installing, or updating an Omniscience build. Do not infer the right commit from a local worktree, a stale screenshot, or a different plugin. Keep the stable, test, and unfinished redesign sources distinct. Report what was actually installed and what still needs a restart or platform test.

Agent instructions only apply when the agent receives and follows them. In particular, Hermes safe mode skips custom instructions, so it cannot enforce this policy by itself.
