# Notices

## Trademarks

This repository references many third-party products, services, and websites by
name (e.g. as connector identities and in documentation). All product names,
logos, and brands are the property of their respective owners. Their use here is
for **identification and interoperability only** and does **not** imply any
affiliation with, sponsorship by, or endorsement by those owners.

## Third-party software

The only third-party package this project ships at runtime is:

- [`node-html-parser`](https://github.com/taoqf/node-html-parser) — MIT

Everything else is build- and test-time tooling (Biome, ESLint and its plugins,
TypeScript, Playwright, Vitest, Zod, etc.). That tooling is used to develop the
project; it is not linked into or redistributed with the published source. A few
of those dev/build dependencies carry weak-copyleft licenses (e.g. LGPL-3.0 for
`eslint-plugin-sonarjs`, MPL-2.0 for `lightningcss`); because they are not
distributed here, their terms do not extend to this MIT-licensed source.
