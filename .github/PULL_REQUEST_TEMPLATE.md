## What & why

<!-- What does this change and why? Link any related issue. -->

## Type

- [ ] New connector
- [ ] Bug fix
- [ ] Refactor / chore
- [ ] Docs

## Checklist

- [ ] `bun run lint` passes
- [ ] `bun run lint:sonar` passes
- [ ] `bun run test` passes (fetches mocked — no network in tests)
- [ ] `bun run validate` passes (registry consistent)
- [ ] New/changed connectors return the full `{ documents, cursor, stats }` envelope
- [ ] IDs are stable across syncs
