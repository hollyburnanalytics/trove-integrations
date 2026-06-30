# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's
[security advisories](https://github.com/hollyburnanalytics/trove-integrations/security/advisories/new)
("Report a vulnerability"). We aim to acknowledge reports within a few business
days and will keep you updated on remediation.

When reporting, please include:

- A description of the issue and its potential impact.
- Steps to reproduce (a connector ID and minimal input is ideal).
- Any relevant logs (with secrets redacted).

## Scope & handling secrets

These connectors handle credentials you supply (API keys, cookies, session
tokens). Keep the following in mind:

- **Never commit secrets.** Use environment variables / `.env` (git-ignored) and
  the host's secret store. See [`.env.example`](.env.example) for the variables
  connectors read.
- Secrets are sourced at runtime (macOS Keychain for sources, `ctx.secret` for
  MCP servers) and must never be logged or bundled.
- If you discover a secret accidentally committed to history, report it privately
  as above so we can rotate and purge it.

## Supported versions

This project is pre-1.0; security fixes are applied to the `main` branch.
