# Changesets

Spec 15 §6 FR-38: version bumps/changelogs for the internally-shared,
semver-meaningful packages consumed across apps and by each other.
Scoped (see `.changeset/config.json`'s `ignore` list) to everything under
`packages/` except `packages/config/*` (build tooling, not
semver-meaningful) — `apps/orchestrator` and `apps/web-console` are never
versioned this way (FR-39: they're `"private": true`, continuously
deployed, release identity is the deployed Git SHA / a `prod-YYYY-MM-DD-
<sha>` tag instead).

Note this list is broader than FR-38's original four packages
(`ui`, `graph-schema`, `graph-db`, `audit-ledger`) — `review-contracts`,
`report-generation`, `assistant-core`, and `ticketing-adapter` landed
later (Specs 09/10/11/12/13) and are equally shared across app/package
boundaries, so they're tracked here too as part of Spec 15's continuous
env/dependency-surface sync (§3).

## Adding a changeset

```sh
pnpm changeset
```

Answer the prompts (which packages changed, patch/minor/major, a short
summary) — this writes a new `.changeset/<random-name>.md` file to commit
alongside your PR.

## Releasing (maintainer-run, not part of CI in this hackathon-scoped build)

```sh
pnpm changeset:version   # consumes pending changeset files, bumps package.json versions + CHANGELOG.md
pnpm changeset:publish   # no-op here — every tracked package is "private": true, nothing is pushed to a registry
```

See full docs: https://github.com/changesets/changesets
