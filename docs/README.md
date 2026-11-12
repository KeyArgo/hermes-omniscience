# Omniscience documentation

> **Applies to:** Omniscience 1.0.0 · written at commit aec782c
> **Revised:** 2026-11-11 · **Body hash:** e5d4b925



The index of every guide in this folder. Start with [INSTALL](INSTALL.md) if you are installing,
or [USAGE](USAGE.md) if you already have a recording and want to read it.

## Start here

| Guide | Read it when |
|---|---|
| [INSTALL](INSTALL.md) | You want the plugin and viewer running, upgraded or removed |
| [USAGE](USAGE.md) | You want a short walkthrough of the viewer and `/omni` |
| [USER-GUIDE](USER-GUIDE.md) | You want to understand every view, colour and timing |
| [UI-GUIDE](UI-GUIDE.md) | You want a reference for every control on the screen |
| [FAQ](FAQ.md) | You have a quick question about data, cost or OFFLINE |
| [TROUBLESHOOTING](TROUBLESHOOTING.md) | Something is not working |
| [CONFIGURATION](CONFIGURATION.md) | You need an environment variable or stored setting |
| [REFERENCE](REFERENCE.md) | You need hooks, event kinds, routes, CLI flags or rule thresholds |
| [DEVELOPMENT](DEVELOPMENT.md) | You are changing the code, tests or docs stamps |

## How it works, and what it stores

| Guide | What it covers |
|---|---|
| [ARCHITECTURE](ARCHITECTURE.md) | Components, data flow, the event contract, on-disk locations |
| [COVERAGE](COVERAGE.md) | Which Hermes hooks are recorded and which are deliberately not |
| [HERMES_INTEGRATION](HERMES_INTEGRATION.md) | Verified hook payloads and Hermes version compatibility |
| [SECURITY](SECURITY.md) | Threat model, collection policy and what leaves the machine |
| [SECURITY-AUDIT](SECURITY-AUDIT.md) | A module-by-module security audit |
| [DECISIONS](DECISIONS.md) | The decisions that shaped the design, with the reasoning |
| [VERSIONING](VERSIONING.md) | Version scheme and the documentation currency rule |

## Project and development

| Guide | What it covers |
|---|---|
| [ROADMAP](ROADMAP.md) | What is built, what is next, what is parked |
| [DEMO](DEMO.md) | The 90-second demo script |
| [BUG-LOG](BUG-LOG.md) | Known defects and examined non-defects |
| [DOC-INDEX](DOC-INDEX.md) | Generated table with the build stamp of each guide |
| [dev/PERFORMANCE_TUNING](dev/PERFORMANCE_TUNING.md) | Performance work and measured results |
| [dev/PREVENT_POLLING_REGRESSION](dev/PREVENT_POLLING_REGRESSION.md) | The polling-interval guard |
| [dev/REGRESSION_TESTING](dev/REGRESSION_TESTING.md) | Regression and performance requirements |

## Outside this folder

- [../TESTING.md](../TESTING.md) — how to run each suite and what CI runs.
- [../VERIFY.md](../VERIFY.md) — a short install check.
- [../LIMITS.md](../LIMITS.md) — what the plugin deliberately does not do.
- [../CHANGELOG.md](../CHANGELOG.md) — release history.
- [../CONTRIBUTING.md](../CONTRIBUTING.md), [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) and
  [../SECURITY.md](../SECURITY.md) — contribution and reporting rules.

Every living guide is stamped with the version it describes and a hash of its own body. The check
is part of the Python suite; see [VERSIONING](VERSIONING.md) and `python3 scripts/docs-stamp.py`.
