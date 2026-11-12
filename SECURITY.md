# Security policy

Applies to **Omniscience 1.0.x**. Revised **2026-11-11**.

## Reporting a vulnerability

Please report security problems privately through GitHub's **Security → Report a vulnerability**
form on this repository:

<https://github.com/KeyArgo/hermes-omniscience/security/advisories/new>

Do not open a public issue for a vulnerability. Include the version, the steps to reproduce, and
what you think is exposed. Reports are handled confidentially.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| Earlier | No |

## What the product does with data

Omniscience records sanitized metadata from Hermes observer hooks into a local SQLite database. It
does not store prompts, conversation text, tool arguments, tool results, request or response bodies,
headers, environment values or credentials. Free-text fields it keeps are truncated and passed
through pattern-based redaction; error messages are stored only as a length.

The viewer binds `127.0.0.1` by default, opens the database read-only, and guards `/api` with a
per-install key. The recorder makes no network calls. Two opt-in features can reach the network:
**Ask a Model** sends a metadata-only digest to a provider the user picks, and the **DGX Sparks**
usage source polls hosts the user configures.

The full threat model and collection policy are in [docs/SECURITY.md](docs/SECURITY.md). The
module-by-module audit is in [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md).
