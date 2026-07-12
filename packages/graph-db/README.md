# @sentinel-act/graph-db

The Neo4j implementation behind `@sentinel-act/graph-schema`'s pure TypeScript
types. This package owns everything database-shaped for the Regulatory
Knowledge Graph: schema migrations, one repository per node type,
bitemporal ("as of") point-in-time query helpers, the atomic commit path
the Orchestrator uses to persist a proposal, the supersession write
pattern, vector search, and seed/fixture data — including the 3 July 2026
CUSPA / Paragraph 46 amendment demo scenario.

Full functional spec: `docs/specs/01-knowledge-graph-persistence.md`. That
spec (and `docs/specs/00-context-and-conventions.md`, which wins on any
conflict) is authoritative; this README is an operational summary, not a
replacement.

## The one rule every other package must follow

**Never write raw Cypher against this graph outside this package.** Every
other unit — the Orchestrator, the five fanned-out agents, the Web
Governance Console, the Conversational Assistant — reads and writes
through `@sentinel-act/graph-db`'s public API (everything exported from
`src/index.ts`), never by importing `neo4j-driver` directly or hand-writing
Cypher elsewhere in the monorepo. If the API this package exposes doesn't
cover something you need, extend this package (additively — see
"Extending this package" below), don't route around it.

## Environment variables

Read from `process.env` by `getDriver()` (`src/driver.ts`) only — no other
variable names are recognized (older drafts used `GRAPH_DB_URL` /
`VECTOR_STORE_URL`; those are retired, see `docs/specs/README.md`):

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SENTINEL_NEO4J_URI` | yes | — | `bolt://localhost:7687` (local), `neo4j+s://<id>.databases.neo4j.io` (Aura — TLS scheme required, NFR-3) |
| `SENTINEL_NEO4J_USER` | yes | — | |
| `SENTINEL_NEO4J_PASSWORD` | yes | — | |
| `SENTINEL_NEO4J_DATABASE` | no | `neo4j` | |

Copy `.env.example` to `.env` for local dev (a local Neo4j 5.13+ instance,
e.g. via Docker, is still required — this package doesn't ship one).

## CLI commands

```bash
# Apply all migrations (constraints, indexes, vector index). Idempotent —
# safe to re-run; a changed migration file's checksum mismatch fails loudly.
pnpm --filter @sentinel-act/graph-db migrate

# Seed scenarios (all go through the real GraphWriter.commitProposal path):
pnpm --filter @sentinel-act/graph-db seed --scenario=cuspa-pre     # pre-amendment state (live demo starting point)
pnpm --filter @sentinel-act/graph-db seed --scenario=cuspa-post    # the amendment, for rehearsal/integration tests
pnpm --filter @sentinel-act/graph-db seed --scenario=dev-sample    # broader synthetic queue (console demo, local dev)
pnpm --filter @sentinel-act/graph-db seed --reset                  # wipes all nodes/edges (dev/CI only)
pnpm --filter @sentinel-act/graph-db seed --reset --scenario=cuspa-pre

# Refused against an Aura-looking host (*.databases.neo4j.io) unless:
pnpm --filter @sentinel-act/graph-db seed --reset --i-understand-this-is-not-local
```

## Development

```bash
pnpm --filter @sentinel-act/graph-db typecheck   # tsc --noEmit (src, seed, test)
pnpm --filter @sentinel-act/graph-db lint        # eslint . --max-warnings 0
pnpm --filter @sentinel-act/graph-db build       # tsc -p tsconfig.build.json (src only -> dist)
pnpm --filter @sentinel-act/graph-db test        # unit tests, mocked neo4j-driver, no DB needed
pnpm --filter @sentinel-act/graph-db test:integration  # real Neo4j via testcontainers — requires a local Docker daemon
```

`test:integration` starts a fresh `neo4j:5.23-community` container per test
file (via `@testcontainers/neo4j`), runs the real migration runner against
it, and exercises the real repositories/`GraphWriter` — no mocks. It needs
a working container runtime (Docker or a compatible alternative) on the
machine running it; without one, every integration test file fails fast
with `Could not find a working container runtime strategy`, which is
expected in a container-less environment.

## What lives where

```
src/
├── driver.ts            # Driver singleton, env config, verifyConnectivity
├── errors.ts             # ConflictError, ValidationError, NotFoundError,
│                          # CommitError, GraphDbUnavailableError, GraphDbSchemaError
├── types.ts               # CommitPlan, CommitResult, PointInTimeQuery, VectorSearchQuery/Result
├── logger.ts               # Structured JSON logging (NFR-5)
├── migrations/            # 001-004 .cypher files + the idempotent runner
├── repositories/            # One class per node type + shared base.repository.ts
├── point-in-time.ts          # pointInTimeWhereClause + findObligationsAsOf
├── vector-search.ts           # findSimilarClauses (GraphRAG)
└── commit/
    ├── commit-plan-validator.ts  # zod schema for CommitPlan (FR-13)
    └── graph-writer.ts            # GraphWriter.commitProposal — the atomic write path
seed/
├── fixtures/                # cuspa-pre-amendment.ts, cuspa-post-amendment.ts, dev-sample-set.ts
└── seed.ts                   # CLI entrypoint
test/
├── repositories/, commit/, migrations/, vector-search.test.ts  # unit tests, mocked driver
└── integration/                # real-Neo4j tests via testcontainers
```

## Known open items (see spec §13 for full detail — not silently resolved)

- **`Clause.embedding_ref`** is typed `string` in `graph-schema` but Neo4j's
  vector index needs `LIST<FLOAT>`. This package's repository layer
  (`repositories/clause.repository.ts`) owns that serialize/deserialize
  boundary — treat `embedding_ref` as a JSON-stringified `number[]` at
  every call site outside this package.
- **Embedding dimension is 1536** (`migrations/004_vector_index.cypher`) —
  a placeholder pending an actual embedding model choice. Changing it
  later means dropping and recreating the vector index.
- **`CommitPlan` does not yet carry** `obligationStatusTransitions` /
  `finalizeSupersessions`, which Specs 06/08 are expected to need
  (`src/types.ts` has a `TODO(spec-06/08)` comment at the exact spot).
  Coordinate before extending it.
- **Concurrency control is optimistic** (`supersede`'s guard predicate +
  caller-side retry), not pessimistic locking — fine for a single-writer
  Orchestrator, unverified under horizontal scaling.

## Extending this package

Adding a new query or write path for an existing node type: extend the
relevant class in `repositories/`. Adding a genuinely new write shape that
several other specs will need: extend `CommitPlan` in `src/types.ts`
additively (never remove/rename an existing field — every other spec
imports this package's public API unchanged) and re-export from
`src/index.ts`.
