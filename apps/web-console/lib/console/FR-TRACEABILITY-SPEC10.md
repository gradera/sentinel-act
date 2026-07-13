# Spec 10 FR/AC Test-Traceability Ledger

Companion to `FR-TRACEABILITY.md` (Spec 09, Operator mode) in this same
directory — kept as a **separate file** rather than merged, since Spec 09
and Spec 10 are different units with their own FR/AC numbering (Spec 10's
FR-1 is not Spec 09's FR-1). Same honesty rule as that file: every FR/AC
below is either

- **tagged in a real, passing test** — grep `FR-<N>`/`AC-<N>` across
  `packages/graph-db/test/queries/*.test.ts`,
  `packages/report-generation/test/*.test.ts`,
  `apps/web-console/app/api/audit/**/*.test.ts`, and
  `apps/web-console/scripts/*.test.ts` to find it, or
- **listed here** because the underlying behavior is genuinely not
  testable in this sandbox (no live Neo4j/Docker for an integration test,
  no jsdom/React Testing Library/Playwright for UI rendering, or a
  documented pre-existing implementation gap) — stated plainly, not
  disguised as a passing test.

No test here asserts something trivial just to carry an `FR-N`/`AC-N` tag.
Where a prior stage's test already covered an FR but wasn't tagged, this
pass added the tag to the real test that already exercised it (see
`packages/graph-db/test/queries/audit-query.test.ts` and
`export-job-store.test.ts` — most of FR-1..FR-10 and FR-16's tags were
added during this pass; they were not previously tagged despite already
being covered).

## §12 Definition of Done — the "8 Acceptance Criteria" count is wrong

§12 says "All 8 Acceptance Criteria in §9 pass." §9 actually enumerates
**9**: 1, 2, **2a**, 3, 4, 5, 6, 7, 8. AC-2a is explicitly introduced mid-
spec as "(FR-11a, post-review addition)" — added after the original
numbering was set, and §12's count was never updated to match. This is a
spec-document inconsistency, not a coverage gap on this unit's part;
flagged here so nobody chases a phantom "9th criterion doesn't exist"
question later.

## Functional Requirements not (or only partially) testable here

| FR | Why |
|---|---|
| FR-3 (partial) | `circularId` being wired through as a literal parameter into the correct Cypher shape (the `Circular <- PART_OF <- Clause <- DERIVED_FROM <- Obligation -> REVIEWED_BY -> HumanReview` traversal) IS tested (`audit-query.test.ts`, "wires circularId through" + the shape test). What is NOT provable with a mocked driver is that this traversal actually aggregates every `HumanReview` across every `Obligation` derived from any `Clause` of a given `Circular` against real multi-Obligation graph data — the mock returns canned records regardless of the Cypher's real semantics. That end-to-end claim is Acceptance Criterion 2, which needs a real Neo4j integration test (not present in this sandbox — see below). |
| FR-7 (partial) | The service-layer half (`findByObligationId` returns both Tier C maker+checker `HumanReview` rows, ordered `decided_at` ascending) IS tested (`audit-query.test.ts`, "returns both rows (maker + checker) for a resolved Tier C obligation"). The UI half (`audit-results-table.tsx` rendering them grouped under a single "Tier C — 2 of 2 reviews" heading) is component rendering — this suite runs in `environment: "node"` with no jsdom/React Testing Library, so it cannot render or inspect that component (mirrors Spec 09's own FR-6/FR-10 entries for the identical reason). |
| FR-13 (honest caveat, not a test gap) | The async job lifecycle (queued -> running -> completed/failed, 202 returned before generation finishes) IS tested at the mock level (`app/api/audit/export/route.test.ts`). The route handler's own top-of-file comment documents a real, load-bearing limitation this test suite cannot exercise: `runExportJobInBackground` is a fire-and-forget `void` async call with no durable queue/worker behind it — correct under `next dev`/a persistent `next start` process, but would be killed mid-flight by a serverless runtime that freezes the execution environment after the HTTP response is sent. Not fixed here (would require adding real queue infrastructure, out of scope for this stage) — flagged exactly as the route file itself already flags it. |
| FR-16 (scheduler wiring, deliberate deferral, not a gap) | `ExportJobStore.deleteExpired()`'s Cypher (7-day retention, cutoff comparison, returning `filePaths`) IS tested (`export-job-store.test.ts`). The new cleanup script's orchestration (`scripts/cleanup-expired-exports.ts`) — call `deleteExpired()`, then delete every non-null `filePath` via `export-storage.ts`'s new `deleteExportFile` helper, tolerate/report per-file failures — IS tested (`scripts/cleanup-expired-exports.test.ts`, 4 tests, mocked store + mocked file-deleter). What is NOT built or testable here is an actual scheduler invoking that script (Vercel Cron/k8s CronJob/host crontab) — Spec 10 §11 Task 11 explicitly scopes this stage to "a locally-runnable script plus a documented deployment TODO," not a working scheduler; this is a spec-acknowledged deferral (§13 Open Question 9), not an unaddressed gap. |
| FR-19 (partial) | The structural half — Tier A rows can never appear in `GET /api/audit/reviews` results because `AuditQueryService.search`'s Cypher requires a real `REVIEWED_BY` match (`MATCH (o:Obligation)-[:REVIEWED_BY]->(hr:HumanReview)`, not `OPTIONAL MATCH`), and Tier A obligations have no `HumanReview` node at all — is provably true from the same Cypher-shape assertions that back FR-6's test, so no Tier A pseudo-row can structurally reach the search table. The export panel's help-text copy ("includes Tier A auto-committed items; the search table above does not...") is UI copy, not testable here. |
| FR-20 | "Zero elements with an `onClick`/form `action` targeting a write-capable endpoint" is Acceptance Criterion 8's Playwright DOM-scan requirement — no Playwright/browser is available in this sandbox. A manual grep-based structural check was performed instead (see "No-direct-write verification" below): `apps/web-console/components/audit/*.tsx` and `app/(observer)/audit/**` contain exactly one network-mutating call site (`export-panel.tsx`'s `auditFetch("/api/audit/export", ...)`, the one exception FR-20 itself carves out) and zero references to `/api/queue/*` or any other write endpoint. This is real evidence, but it is a grep audit, not the automated Playwright DOM assertion the spec's own Test Plan (§10) and Definition of Done (§12) require. |
| FR-21 (enforcement mechanism, not a vitest test) | Enforced by the ESLint `no-restricted-imports` rule (`apps/web-console/eslint.config.mjs`, scoped to `app/(observer)/audit/**` and `app/api/audit/**`) rather than by a unit test — there is no vitest test that imports a forbidden symbol and asserts ESLint rejects it (that would require running ESLint programmatically from within a test, which this stage did not add). Verified two ways instead: (1) `eslint . --max-warnings 0` runs clean in `apps/web-console` (this pass reran it), meaning the rule is active and nothing currently violates it; (2) a manual grep confirmed zero `executeWrite`/`GraphWriter`/`commitProposal`/repository-write-method calls anywhere under the scoped paths, and `audit-query.ts` is 100% `session.executeRead` (see "No-direct-write verification" below). |

## Acceptance Criteria (§9) not (or only partially) testable here

| AC | Why |
|---|---|
| AC-1 (partial) | The row-shape/mapping logic (`AuditTrailRow` correctly assembled from an `Obligation`+`HumanReview`+`Clause`+`Circular`+`ProcessTask[]` record) IS tested (`audit-query.test.ts`, "maps a full record ... into an AuditTrailRow"), using synthetic fixture data shaped like the CUSPA post-amendment scenario (`clause.para_ref: "46"`, a circular title). The literal acceptance criterion — seed the real `cuspa-post` fixture into a real Neo4j instance and query it — needs `test/integration/audit-search.integration.test.ts` (referenced in the spec's own §10 Test Plan) against a `testcontainers`-managed Neo4j 5.13+ container. This sandbox has no docker/podman binary and no docker socket (confirmed), so that integration test cannot be written or run here, exactly the same hard blocker `audit-query.test.ts`'s own top-of-file comment already documents. |
| AC-2 | Same integration-test gap as FR-3 above and AC-1: proving the `circularId` traversal returns every `HumanReview` across every `Obligation` derived from any `Clause` of a real seeded `Circular` needs a live Neo4j instance with the CUSPA fixtures loaded. Not testable here. |
| **AC-2a** | **The spec's own Definition of Done treats a REAL Neo4j integration test for this criterion as non-negotiable, and it has NOT been done — same as Spec 09's own hard-blocker gaps.** What IS genuinely, thoroughly tested: the Cypher-shape/predicate-placement logic, against a mocked driver, in `audit-query.test.ts` — specifically the "includes the FR-11a guard" assertions on `search`/`findByReviewId`/`findByObligationId`, and the dedicated `describe("AuditQueryService.findRegisterAsOf — FR-11a placement (§4.4)")` block that asserts the guard clause is positioned *inside* the `REVIEWED_BY OPTIONAL MATCH`'s own `WHERE` (not the outer `WHERE`) — a real, specific, non-trivial structural check, not padding. What this CANNOT prove, because the mock driver never evaluates Cypher semantics: that a real Neo4j instance, given a Tier C Obligation genuinely in `status: "tier_c_review"` with one `HumanReview` (`tier: "C"`) linked via `REVIEWED_BY`, actually excludes that record from a real query response — and, critically, that after the checker submits and `Obligation.status` transitions to `"committed"`, the SAME query against the SAME (now-updated) graph state reverses and returns both records. That reversal behavior is the entire point of AC-2a (proving the exclusion is time-bound, not a permanent redaction) and is inherently a live-database, two-step-mutation-then-requery test — it cannot be faked with static mocked records. This sandbox has no docker/podman binary and no docker socket, so `test/integration/audit-search.integration.test.ts` (the vehicle the spec's own §10 Test Plan names for this) does not exist and cannot be run here. This is the single most important honest gap in this ledger. |
| AC-3 (partial) | The service-layer half (both Tier C rows returned, ordered ascending) IS tested. The UI half ("Tier C — 2 of 2 reviews" grouping, rendered) is not testable here — same jsdom/RTL absence as FR-7. |
| AC-4 | The bitemporal boundary itself (`valid_from`/`valid_to` windowing so a pre- vs. post-amendment `Obligation` version is selected correctly by `asOfDate`) reuses Spec 01's `pointInTimeWhereClause` helper verbatim — that helper's own correctness is already proven at Spec 01's repository level (that spec's own Acceptance Criterion 4). This spec's AC-4 is the *export-level*, end-to-end version of the same claim (two real `POST /api/audit/export` calls against a real two-version CUSPA fixture, asserting the two generated registers differ exactly as expected) — that needs a live Neo4j instance with the fixture applied via the real `GraphWriter.commitProposal` path (per Spec 01's seed convention) and is not testable here for the same docker/testcontainers reason as AC-1/AC-2/AC-2a. |
| AC-7 (partial: latency not asserted) | The 202-before-generation-completes behavior IS tested (`app/api/audit/export/route.test.ts`, "async path (rowCount > threshold)"), as is the eventual `completed` status with a working download link (`export/[exportId]/route.test.ts`'s "200 with a completed job" + `export/[exportId]/download/route.test.ts`'s "200 with correct headers" tests). The criterion's specific "within 500ms" latency claim (the estimate query only, not full generation) is NOT asserted anywhere — no test measures wall-clock time against a 500ms budget. Not a correctness gap, but a genuinely untested performance claim; would need either a real timing assertion against a real driver (fragile in CI) or is more honestly treated as a manual/load-test concern, consistent with how the spec's own NFR-1 flags itself as "a design target, not a load-tested SLA." |
| AC-8 | Same as FR-20 above: this is explicitly a Playwright DOM-scan requirement (§10's own e2e test plan names `e2e/audit.spec.ts` as the vehicle) and no Playwright/browser is available in this sandbox. The manual grep-based structural check performed instead (see below) is real evidence but not the automated test the spec requires. |

## No-direct-write verification (performed this pass, not a vitest test)

Grepped `apps/web-console/app/(observer)/audit/**`, `apps/web-console/app/api/audit/**` (source files, not `.test.ts`), and `packages/graph-db/src/queries/audit-query.ts` for `executeWrite`, `GraphWriter`, `commitProposal`, and repository `create()`/`supersede()` calls:

- `app/(observer)/audit/**`: zero matches.
- `app/api/audit/**`: the only two matches are doc comments in `export/route.ts` and `reviews/route.ts` explicitly stating "No import of GraphWriter/commitProposal/..." — i.e. the code documents the absence, it does not contain the thing itself.
- `audit-query.ts`: every graph call is `session.executeRead` (5 call sites); zero `executeWrite`. `AuditQueryService` is 100% read-only, exactly as NFR-4/FR-21 require.
- `ExportJobStore` (the one documented, narrow exception) writes only `:ExportJob` nodes — non-canonical, infra-only bookkeeping, never a canonical Regulatory Knowledge Graph label — per its own top-of-file comment, unchanged by this pass.
- Component-level grep (`components/audit/*.tsx`) found exactly one network-mutating call site anywhere in the audit UI tree: `export-panel.tsx`'s `auditFetch("/api/audit/export", ...)` — the one exception FR-20 itself names. No reference to `/api/queue/*` or any other write endpoint exists anywhere in `app/(observer)/audit/**`.

## Everything else

Every other FR (FR-1, FR-2, FR-4, FR-5, FR-6, FR-8, FR-9, FR-10, FR-11, FR-11a (Cypher-shape level — see AC-2a above for the real-Neo4j caveat), FR-12, FR-14, FR-15, FR-16 (store + script level — see FR-16 entry above for the scheduler-wiring caveat), FR-17, FR-18) and AC (AC-5, AC-6) is tagged with an explicit `// FR-<N>:` / `// AC-<N>:` comment directly above the specific test(s) that exercise it — grep `FR-` or `AC-` across:

- `packages/graph-db/test/queries/audit-query.test.ts`
- `packages/graph-db/test/queries/export-job-store.test.ts`
- `packages/report-generation/test/to-register-rows.test.ts`
- `packages/report-generation/test/xlsx-generator.test.ts`
- `packages/report-generation/test/pdf-generator.test.ts`
- `apps/web-console/app/api/audit/reviews/route.test.ts`
- `apps/web-console/app/api/audit/reviews/[reviewId]/route.test.ts`
- `apps/web-console/app/api/audit/export/route.test.ts`
- `apps/web-console/app/api/audit/export/[exportId]/route.test.ts`
- `apps/web-console/scripts/cleanup-expired-exports.test.ts`

to find each one. A number of these tags (most of FR-1/2/4/5/8/9/10 in
`audit-query.test.ts`, FR-16 in `export-job-store.test.ts`, and the NFR-5/
FR-1/FR-10/FR-11/FR-12/FR-13/NFR-7 tags in the API route test files) were
added during this stage — the underlying tests already existed and
already passed from a prior stage, they simply weren't labeled yet. No
test's assertions were changed to make a tag "fit"; where an existing
test's assertions didn't actually prove the FR/AC being considered, no
tag was added and the gap is listed in the tables above instead.
