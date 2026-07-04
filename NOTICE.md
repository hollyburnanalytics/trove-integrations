# Notices

## Trademarks

This repository references many third-party products, services, and websites by
name (e.g. as source and toolkit identities and in documentation). All product names,
logos, and brands are the property of their respective owners. Their use here is
for **identification and interoperability only** and does **not** imply any
affiliation with, sponsorship by, or endorsement by those owners.

## Third-party software

The sources ship a single third-party runtime package:

- [`node-html-parser`](https://github.com/taoqf/node-html-parser) — MIT

The toolkits additionally run on the `@ontrove/mcp` SDK and `zod` when deployed
— both MIT. Everything else is build- and test-time tooling (Biome, ESLint and its
plugins, TypeScript, Zod, etc.); it is used to develop the project, not
linked into or redistributed with the published source. One of those dev
dependencies carries a weak-copyleft license (LGPL-3.0 for `eslint-plugin-sonarjs`);
because it is not distributed here, its terms do not extend to this MIT-licensed
source.
