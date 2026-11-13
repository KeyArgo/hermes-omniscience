# Documentation index

Every guide below describes **Omniscience 1.0.0** (commit 3ee0d28). The date on each row is
the last time its body changed; a row reading *behind* means the file was edited without being
restamped, and `python3 scripts/docs-stamp.py --check` treats that as an error.

Regenerate this page with `python3 scripts/docs-stamp.py --index`. Generated 2026-11-13.

| Document | Title | What it covers | Revised | State |
|---|---|---|---|---|
| [ARCHITECTURE](ARCHITECTURE.md) | Architecture | Components, data flow, the event store and the viewer | 2026-11-11 | current |
| [BUG-LOG](BUG-LOG.md) | Defect log |  | 2026-11-09 | current |
| [CONFIGURATION](CONFIGURATION.md) | Configuration |  | 2026-11-11 | current |
| [COVERAGE](COVERAGE.md) | What Omniscience can and can't see | Which Hermes hooks are subscribed to, and what is deliberately not seen | 2026-11-11 | current |
| [DECISIONS](DECISIONS.md) | Decisions | The decisions that shaped the design, with the reasoning | 2026-11-11 | current |
| [DEMO](DEMO.md) | Demo video script (90 seconds) | The 90-second demo script and the shots it needs | 2026-11-09 | current |
| [DEVELOPMENT](DEVELOPMENT.md) | Development |  | 2026-11-11 | current |
| [FAQ](FAQ.md) | FAQ | Short answers to the questions that come up first | 2026-11-13 | current |
| [HERMES_INTEGRATION](HERMES_INTEGRATION.md) | Hermes Integration — verified hooks, payloads, limitations | Verified hook payloads and Hermes version compatibility | 2026-11-11 | current |
| [INSTALL](INSTALL.md) | Install & operate Hermes Omniscience | Install, run, upgrade and remove the plugin | 2026-11-11 | current |
| [README](README.md) | Omniscience documentation | What the plugin is, how to install it, what it looks like | 2026-11-11 | current |
| [REFERENCE](REFERENCE.md) | Reference |  | 2026-11-13 | current |
| [ROADMAP](ROADMAP.md) | Roadmap | What is built, what is next, what is parked | 2026-11-13 | current |
| [SECURITY-AUDIT](SECURITY-AUDIT.md) | Security audit — module by module |  | 2026-11-11 | current |
| [SECURITY](SECURITY.md) | Security — threat model, collection policy, privacy | Threat model, collection policy, what leaves the machine | 2026-11-13 | current |
| [TROUBLESHOOTING](TROUBLESHOOTING.md) | Troubleshooting |  | 2026-11-13 | current |
| [UI-GUIDE](UI-GUIDE.md) | Omniscience — a guide to the screen |  | 2026-11-10 | current |
| [USAGE](USAGE.md) | Usage |  | 2026-11-11 | current |
| [USER-GUIDE](USER-GUIDE.md) | Omniscience — User Guide | How to read the viewer: views, colours, timings, exports | 2026-11-13 | current |
| [VERSIONING](VERSIONING.md) | Versioning and documentation currency | The version scheme, the build stamp, and the documentation currency rule | 2026-11-11 | current |
| [PERFORMANCE_TUNING](PERFORMANCE_TUNING.md) | Omniscience Performance Tuning — Completed Changes |  | 2026-11-11 | current |
| [PREVENT_POLLING_REGRESSION](PREVENT_POLLING_REGRESSION.md) | Omniscience Polling Regression — Prevention Checklist |  | 2026-11-13 | current |
| [REGRESSION_TESTING](REGRESSION_TESTING.md) | Omniscience Viewer — Regression Testing & Performance Requirements |  | 2026-11-11 | current |

## How the stamp works

Each document opens with the build it was written against and a hash of its own body:

```
> **Applies to:** Omniscience 1.0.0 · commit 3ee0d28
> **Revised:** <date the body last changed> · **Body hash:** <first 8 hex of sha256(body)>
```

The version comes from `plugin.yaml`, the commit from git, and the hash from the text, so none of
the three can be typed in wrong and left there. Edit a guide and the hash stops matching; the check
then fails until the stamp is rewritten, which is the moment to re-read whether the guide still
describes the product.

Dated snapshots — `docs/handover/`, `docs/design/` — are deliberately excluded: a handover
describes one moment and restamping it would make it describe a build it never saw.
