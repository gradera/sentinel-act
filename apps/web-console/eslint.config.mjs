// Wires apps/web-console into the shared flat ESLint config, same pattern
// as packages/graph-db/eslint.config.js and packages/ui/eslint.config.js.
// This file didn't exist yet — its absence was a pre-existing gap
// (package.json's "lint" script has always run `eslint . --max-warnings
// 0`, but with no eslint.config.js, ESLint 9 refuses to run at all).
//
// No Next.js-specific plugin (eslint-config-next / @next/eslint-plugin-next)
// is wired in here because neither is a dependency of this package yet —
// adding one is a real decision (rule set, React version alignment) for
// whoever owns the Web Governance Console specs (09/10), not something to
// silently bundle in while just unblocking `pnpm lint` repo-wide.
import sharedConfig from "@sentinel-act/eslint-config";

// Spec 10 FR-21 / Task 9 — hard technical boundary: no server code backing
// the Observer-mode audit surface (`app/(observer)/audit/**`) or its API
// routes (`app/api/audit/**`) may import a write path into the Regulatory
// Knowledge Graph from `@sentinel-act/graph-db`. This is enforced here via
// `no-restricted-imports`'s `paths`/`importNames` option rather than by
// code review discipline alone.
//
// Spec 12 FR-22 extends this SAME rule (not a second, separately
// maintained one) to also cover `app/api/assistant/**` — the Conversational
// Assistant's route handler has the identical constraint: it may read via
// AssistantQueryService/AuditQueryService, but must never import a write
// path. See packages/assistant-core/eslint.config.js for the equivalent
// restriction covering that package itself (a separate lint run, so it
// needs its own rule instance — see that file's comment for why that
// isn't "a duplicate" in the sense FR-22 warns against).
//
// Scope of the restricted names:
// - `GraphWriter` — the Orchestrator's only write entry point (§5.7).
//   `commitProposal` itself is a *method* on this class, not a standalone
//   export (see packages/graph-db/src/commit/graph-writer.ts), so
//   `no-restricted-imports` can't name the method directly — forbidding the
//   class import is what actually closes that door.
// - `validateCommitPlan` / `commitPlanSchema` — the commit-plan validator,
//   only meaningful alongside a write; no read-only caller needs these.
// - Every repository class @sentinel-act/graph-db exports
//   (`CircularRepository`, `ClauseRepository`, `ObligationRepository`,
//   `ProcessTaskRepository`, `EvidenceArtifactRepository`,
//   `IntermediaryCategoryRepository`, `HumanReviewRepository`,
//   `BaseRepository`) is forbidden outright, not just their write methods —
//   verified against the actual Spec 10 route files
//   (`app/api/audit/reviews/route.ts`, `reviews/[reviewId]/route.ts`,
//   `export/route.ts`, `export/[exportId]/route.ts`,
//   `export/[exportId]/download/route.ts`) that none of them import any
//   repository class today; every read goes through `AuditQueryService`
//   (backed by its own `session.executeRead`-only Cypher, NFR-4) or
//   `ExportJobStore` (whose writes only ever touch the non-canonical
//   `:ExportJob` bookkeeping label — see that file's own header comment).
//   Blocking the whole class is simpler to enforce than trying to name
//   just `create*`/`update*`/`supersede*` methods, and forces all reads in
//   this unit through the one module (`AuditQueryService`) that is
//   read-only by construction.
// `getDriver` is deliberately NOT restricted — every audit route
// legitimately constructs `new AuditQueryService(getDriver())` /
// `new ExportJobStore(getDriver())` itself (these services take a driver
// via their constructor, they don't reach for one internally), so the
// routes need this import to exist at all.
const graphDbNoWriteImports = {
  name: "sentinel-act/observer-audit-no-graph-write",
  files: ["app/(observer)/audit/**/*.{ts,tsx}", "app/api/audit/**/*.{ts,tsx}", "app/api/assistant/**/*.{ts,tsx}"],
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
              "Spec 10 FR-21 / Spec 12 FR-22: app/(observer)/audit/**, app/api/audit/**, and app/api/assistant/** must never write to the Regulatory Knowledge Graph. Use AuditQueryService, ExportJobStore, or AssistantQueryService (all read-only) instead."
          }
        ]
      }
    ]
  }
};

export default [
  ...sharedConfig,
  {
    ignores: [".next/**", "next-env.d.ts", "**/*.config.ts", "**/*.config.mjs", "**/*.config.js"]
  },
  graphDbNoWriteImports
];
