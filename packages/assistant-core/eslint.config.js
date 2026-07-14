// Wires packages/assistant-core into the shared flat ESLint config, same
// pattern as packages/graph-db/eslint.config.js / packages/report-generation/
// eslint.config.js.
//
// Spec 12 FR-22 — hard technical boundary: no file in this package may
// import GraphWriter, commitProposal, or any repository create()/supersede()
// method from @sentinel-act/graph-db. This unit never writes to the
// Regulatory Knowledge Graph, at three independent layers (§2) — this
// ESLint rule is the application-layer one. It extends the SAME rule
// definition Spec 10 already established for apps/web-console's Observer
// mode (see apps/web-console/eslint.config.mjs's graphDbNoWriteImports),
// not a second, independently-drifting one — this is a genuinely separate
// rule *instance* only because this package has its own `eslint .`
// invocation (a different lint run entirely from apps/web-console's), so
// it needs its own config file to apply to; the restricted import-name
// list below is kept identical to that file's on purpose.
import sharedConfig from "@sentinel-act/eslint-config";

const graphDbNoWriteImports = {
  name: "sentinel-act/assistant-core-no-graph-write",
  // Scoped to everything EXCEPT test/integration/**: FR-22's guarantee is
  // about the answering path (src/**, and this package's regular mocked-
  // driver unit tests under test/*.test.ts, which never need a write
  // either) never reaching a write, since that path's Cypher parameters
  // are ultimately influenced by LLM output (§2/Constraint A's own
  // rationale). test/integration/**'s testcontainers-backed fixture
  // seeding is a different, offline, developer-controlled context with no
  // LLM input anywhere near it — the exact same distinction
  // packages/graph-db's OWN integration tests already rely on (e.g.
  // cuspa-demo-walkthrough.integration.test.ts freely constructs `new
  // GraphWriter(driver)` to seed fixtures, despite graph-db being the
  // very package that owns the write path FR-22 exists to keep this
  // package away from). Discovered when
  // test/integration/assistant-audit-reuse.integration.test.ts (Task 16)
  // needed to seed a HumanReview fixture through the real commit path —
  // the alternative (hand-rolled raw write Cypher in the test file itself
  // instead of the well-tested GraphWriter.commitProposal path) would be
  // strictly worse, not more "read-only."
  ignores: ["test/integration/**"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "@sentinel-act/graph-db",
            importNames: [
              "GraphWriter",
              "validateCommitPlan",
              "commitPlanSchema",
              "BaseRepository",
              "CircularRepository",
              "ClauseRepository",
              "ObligationRepository",
              "ProcessTaskRepository",
              "EvidenceArtifactRepository",
              "IntermediaryCategoryRepository",
              "HumanReviewRepository"
            ],
            message:
              "Spec 12 FR-22: packages/assistant-core must never write to the Regulatory Knowledge Graph. Use AssistantQueryService or AuditQueryService (both read-only) instead."
          }
        ]
      }
    ]
  }
};

export default [
  ...sharedConfig,
  {
    ignores: ["**/*.config.ts", "**/*.config.js", "dist/**"]
  },
  graphDbNoWriteImports
];
