# Spec 09 FR/AC Test-Traceability Ledger

This file is the honest ledger the Definition of Done (`docs/specs/09-web-console-operator-mode.md`
§12: "All FR-1 through FR-32 have at least one passing unit or integration
test that names the FR in a comment or test description") asked for. Every
FR/AC below is either:

- **Tagged in a test** — grep `FR-<N>` or `AC-<N>` across
  `apps/web-console/lib/console/**/*.test.ts` and
  `apps/web-console/app/api/console/**/*.test.ts` to find it, or
- **Listed here** because the underlying behavior is genuinely not testable
  in this sandbox (no live Neo4j/Orchestrator process, no browser/RTL, or —
  in a few cases — no implementation exists at all to test).

This file does not pad coverage with tests that assert `true === true` or
merely check a function exists. Where an FR has NO real implementation to
test, that is stated plainly, not disguised as a passing test.

## Functional Requirements not (or only partially) testable here

| FR | Why |
|---|---|
| FR-3 | Orchestrator-side computation (`slaDueAt = suspendedAt + reviewSlaHours(tier)`) is not on the wire at all — `queue/route.ts`/`items/[obligationId]/route.ts` both hardcode `slaDueAt: null` (documented gap, verified against `apps/orchestrator`'s suspend payload, which never persists `suspendedAt` in `SuspendedRunIndexEntry` or returns it over HTTP). Only the placeholder constants (`REVIEW_SLA_HOURS_TIER_B/C`) are implemented in this app and are tested (`sla.test.ts`). |
| FR-6 | "`isEscalated: true` items MUST render with the `--risk-escalate` token via `RiskTierBadge`'s `ESCALATE` variant" is a component-rendering requirement. This suite runs in `environment: "node"` (see `vitest.config.ts`'s own doc comment) with no `jsdom`/React Testing Library dependency — there is no way to render `RiskTierBadge` or inspect its CSS token here. |
| FR-9 (partial) | The data half (literal, unmodified `Clause.text`) IS tested (`items/[obligationId]/route.test.ts`, "FR-9" describe block). The other half — visually distinguishing the block (quote styling / distinct background) from every other block on the page — is UI rendering, not testable here. |
| FR-10 | "The Obligation fields shown beside the source clause MUST be exactly: ..." is entirely about which fields the UI *chooses to render* from the full `Obligation` object the API already returns — a component-rendering decision, not a data-contract one (the API returns the whole `Obligation` node regardless). Not testable without RTL. |
| FR-13 (partial) | The threshold *logic* (`needsDiffToggle`/`countChangedFields`) is fully tested (`diff-adapter.test.ts`). Whether `ProcessTaskDiffView` actually renders inline vs. behind a toggle is component rendering, not testable here. |
| FR-14 (partial) | Lineage *data assembly* (`[Circular, Clause, Obligation, ProcessTask]`, in order, with the Obligation step linked) is tested (`items/[obligationId]/route.test.ts`, "FR-14" describe block). The `EvidenceArtifact` step FR-14 also calls for is a known, separately-documented gap (`OBLIGATION_DETAIL_CYPHER` never fetches it) — not newly introduced by this pass, not faked here. |
| FR-15, FR-16 | The entire contradiction feature is unimplemented: `items/[obligationId]/route.ts` hardcodes `contradiction: null` for every item, including `tier: "ESCALATE"` ones. Verified: Spec 04's `ContradictionDetail` output is never persisted as a queryable graph node/edge anywhere in `@sentinel-act/graph-schema` — there is nothing this BFF could read to reconstruct it, and this is a pre-existing, already-documented gap (`route.ts`'s own top-of-file comment), not something introduced or left untested by this pass. |
| FR-17 (partial) | The server-side behavior ("empty rationale is valid at Tier B, submission succeeds") is fully tested (`decisions/route.test.ts`). Button presence/visibility in the sign-off panel UI is not testable here. |
| FR-18 | The core "compute per-caller, never from a shared/cached object" redaction logic lives entirely in `apps/orchestrator` (`toWireReviewGateView`/`deriveReviewGateView`/`getReviewsVisibleTo`), outside this app's own test-runner scope (`apps/web-console/lib/console` + `apps/web-console/app/api/console`). What IS tested here is that this app's BFF faithfully passes through whatever per-reviewerId view the (mocked) Orchestrator returns, without leaking anything itself — see the NFR-Security-1 describe block in `items/[obligationId]/route.test.ts`, tagged FR-18/FR-26. |
| FR-20 (partial) | The BFF-level passthrough (a 409 from the Orchestrator's claim endpoint maps to `SLOT_UNAVAILABLE`) is tested (`claim/route.test.ts`). The Orchestrator-side logic that actually assigns slots and distinguishes "already claimed by self" from "no slots left" lives in `apps/orchestrator` and is outside this app's test scope. |
| FR-21 | "The UI MUST show the same ... messaging ... with no indication of whether the other slot is claimed" is UI copy, not testable here. |
| FR-24 | Requires observing `workflowState`/`Obligation.status` transitions that happen inside the Orchestrator's own Mastra workflow engine plus a real graph write — not observable through this app's wire contract at all (confirmed: `SubmitDecisionResponse`/the real `POST .../resume` response never carries a `workflowState` field; `decisions/route.ts`'s own GAP comment documents this) and would require a live Neo4j/Orchestrator process regardless. |
| FR-28 | **NOT satisfied by the implementation, not just untested.** See the dedicated comment in `decisions/route.test.ts` right above the "escalate_to_tier_c" describe block: `escalate_to_tier_c` returns `501 NOT_IMPLEMENTED` rather than performing the transition FR-28 requires, because (verified against the real orchestrator workflow graph) no corresponding state transition exists to perform — an ESCALATE item is already in the same dual-review flow as Tier C from the moment it's routed. This is a pre-existing, deliberate, already-documented architectural gap from an earlier stage, not something this pass introduced; the test documents the gap honestly rather than asserting FR-28 is met. |
| FR-29 | The entire SLA-breach/backup-reviewer-reassignment mechanism is unimplemented anywhere in `apps/orchestrator` (confirmed: no "reassign"/"backup_reviewer" logic exists in orchestrator source; the only SLA-breach detection implemented, `monitoring-and-audit.agent.ts`'s `scanForSlaGaps`, is for *operational* `ProcessTask.sla_hours` compliance post-commit, an unrelated concept). `escalationReason` is hardcoded `null` everywhere. Nothing to test without inventing the feature, which is out of scope for a traceability pass. |
| FR-31 | **Now enforced and tested, closing the gap this ledger previously flagged.** `resumeOrchestratorRun` (`apps/orchestrator/src/mastra/workflows/orchestrator.workflow.ts`) now checks, for any dual-review (Tier C / ESCALATE, `review.tier === "C"` on the wire) resume, that `event.review.reviewer_id` genuinely holds the claimed maker/checker slot (`SuspendedRunIndexPort.getClaimSlots`) BEFORE calling `recordHumanReview` — same "cheap early rejection" pattern as the pre-existing `ReviewerIndependenceError` check, positioned immediately after it. An unassigned/wrong reviewer gets a new `NotAssignedError`, mapped by `apps/orchestrator/src/server/http-server.ts` to `403 NOT_ASSIGNED`, which this app's `decisions/route.ts` passes straight through unchanged (same generic `OrchestratorResponseError` passthrough as `SELF_REVIEW_FORBIDDEN` — no duplicate check added here, the Orchestrator remains the sole authority on slot assignment). Tier B never claims a slot at all (confirmed: the BFF's `claim/route.ts` 422s `NOT_TIER_C` for any non-Tier-C item) and is unaffected. Tested at both layers: `apps/orchestrator/src/mastra/workflows/__tests__/orchestrator.workflow.test.ts`'s "FR-20/FR-31 claimed-slot enforcement" describe block (unclaimed/wrong-reviewer/correctly-claimed, both maker and checker slots, plus a Tier-B-is-unaffected case), and `decisions/route.test.ts`'s "403 NOT_ASSIGNED passes through" test here in this app. |
| FR-32 | `resumeOrchestratorRun` (`apps/orchestrator`) calls Spec 07's `recordHumanReview` + the audit-log hook synchronously before `engine.resume(...)` — verified by reading that function in full (see `decisions/route.ts`'s own top-of-file doc comment) — but this is `apps/orchestrator`-internal sequencing, outside this app's test-runner scope (`apps/web-console/lib/console` + `apps/web-console/app/api/console`) to exercise directly. |

## Acceptance Criteria (§9) not (or only partially) testable here

| AC | Why |
|---|---|
| AC-1 (partial) | "Submission succeeds, `HumanReview.rationale` is `null`" IS tested (`decisions/route.test.ts`, "Tier B does NOT require rationale" test). "The queue no longer lists the item" requires a real Obligation-status transition observed through a live Neo4j `WHERE status IN [...]` query — `fetchQueueItems` is mocked in every BFF test here, so asserting this would only be testing the mock, not real behavior. |
| AC-3 (partial) | The "both `HumanReview` records revealed, disagreement is explicit" half IS tested (`items/[obligationId]/route.test.ts`, "resolved_disagree" test). The `Obligation.status becomes "escalated"` / `workflowState: "resumed_escalated"` half is the same FR-24 gap above — not observable through this app's wire contract, and would need a live graph regardless. |
| AC-5 | Same as FR-29 — the feature does not exist. |
| AC-7 (partial) | The BFF-level 409 passthrough IS tested (`claim/route.test.ts`, tagged FR-20/AC-7). Whether the Orchestrator's claim logic itself distinguishes "self-review" from "no slots left" is `apps/orchestrator`-internal and outside this app's test scope. |

## A terminology note on AC-8 (not a gap — just a wording mismatch worth flagging)

AC-8's prose says "`processTaskDiff` is `null`" for a first-version
Obligation with no prior `ProcessTask`. In the actual implementation
(`items/[obligationId]/route.ts`), `processTaskDiff` is null ONLY when the
Obligation has no `ProcessTask` mapped at all; a first-version Obligation
that DOES have a `ProcessTask` (the normal/common case — Spec 05 always maps
one) gets a non-null `processTaskDiff` with `redline.oldTaskId: null` and
`overallStatus: "new"`, which is what actually drives the "New task" plain-
list rendering (`diff-adapter.ts`'s `deriveEmptyOldLabel`/`needsDiffToggle`).
Functionally this satisfies FR-12's real goal (never an empty/misleading
diff); AC-8's specific field-name assertion just doesn't match this
implementation's chosen representation. Both real data states are covered
by tests — see `items/[obligationId]/route.test.ts`'s "FR-12 / AC-8" describe
block.

## Everything else

Every other FR (FR-1, FR-2, FR-4, FR-5, FR-7, FR-8, FR-11, FR-12, FR-19,
FR-22, FR-23, FR-25, FR-26, FR-27, FR-30) and AC (AC-2, AC-4, AC-6, AC-8) is
tagged with an explicit `// FR-<N>:` / `// AC-<N>:` comment (or an `FR-<N>`/
`AC-<N>` token in a `describe`/`it` description) directly above or inside
the specific test(s) that exercise it — grep `FR-` or `AC-` across
`apps/web-console/lib/console/*.test.ts` and
`apps/web-console/app/api/console/**/*.test.ts` to find each one.
