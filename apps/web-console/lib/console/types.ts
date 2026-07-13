// Spec 09 §4 — Web Console Operator Mode data contracts.
//
// IMPORTANT — this file adapts Spec 09's original (pre-implementation)
// prose contract to the REAL shapes shipped by Specs 01/05/06/07/08,
// which did not exist yet when Spec 09 was written. Every divergence
// from the spec's literal §4 code block is called out inline below.
//
// Cross-app importability note (read before adding more mirrored
// types): `apps/orchestrator` has no `main`/`types`/`exports` field in
// its package.json — it is a Mastra app, not a publishable library — and
// is not listed as a dependency of `apps/web-console`. That means
// nothing in `apps/orchestrator/src/**` (ReviewGateView, ProcessTaskDiff/
// ProcessTaskRedline, ContradictionDetail, HumanReviewSubmittedEvent,
// TierDecision, ...) can be `import type`-ed from here today. Every type
// below whose canonical source is apps/orchestrator is therefore a
// STRUCTURAL COPY, clearly labeled with its source file, not a re-export.
// If the orchestrator's real shape changes, these copies must be updated
// by hand — see orchestrator-client.ts for the fuller writeup and the
// recommendation to fix this (make apps/orchestrator importable, or
// extract a shared `@sentinel-act/console-contracts` package per Spec 09
// §13's own suggestion).
//
// Everything sourced from `@sentinel-act/graph-schema` below IS a real
// `import type` — that package has no importability problem.

import type {
  Obligation,
  ObligationStatus,
  ProcessTask,
  Clause,
  Circular,
  HumanReview,
  ReviewTier,
  ReviewDecision
} from "@sentinel-act/graph-schema";
import type { LineageStep } from "@sentinel-act/ui/components/governance/lineage-breadcrumb";

// ---------------------------------------------------------------------------
// Session (application-level, not a graph node) — unchanged from Spec 09 §4.
// ---------------------------------------------------------------------------

export type ReviewerRole =
  | "compliance_officer" // Tier B primary reviewer
  | "senior_compliance_officer" // Tier C reviewer
  | "backup_reviewer" // appears only on SLA breach reassignment
  | "compliance_head"; // read-only, Observer mode (Spec 10) — 403 on this app's write routes

export interface ReviewerSession {
  reviewerId: string; // stable id, matches HumanReview.reviewer_id once a decision is recorded
  name: string;
  email: string;
  role: ReviewerRole;
}

// ---------------------------------------------------------------------------
// SLA state (queue + detail). See sla.ts for the derivation function and
// the named `reviewSlaHours`/`SLA_DUE_SOON_WINDOW_HOURS` constants.
//
// Deliberately a 3-value vocabulary, distinct from packages/ui's 3-value
// `UrgencyLevel` ("now"/"in-motion"/"archive", Tier-1/2/3 progressive
// disclosure) per docs/specs/00-context-and-conventions.md's "risk tier
// vs urgency tier" convention: SlaState is Spec 09's own reviewer-SLA
// vocabulary ("ok"/"due_soon"/"breached"), not the UrgencyBadge one, even
// though sla.ts's threshold logic intentionally mirrors computeUrgency's
// semantics (decided items and threshold math), because a later stage
// still needs to map SlaState -> UrgencyLevel wherever UrgencyBadge is
// reused (Spec 09 Task 6, SlaBanner).
// ---------------------------------------------------------------------------

export type SlaState = "ok" | "due_soon" | "breached";

// ---------------------------------------------------------------------------
// Orchestrator's real WIRE review-gate contract (FR-24a).
//
// UPDATED (spec-09-stage-2): apps/orchestrator now has an HTTP layer
// (apps/orchestrator/src/server/http-server.ts) that does NOT hand back
// its own internal 4-value `ReviewGateStatus`/`ReviewGateView`
// (orchestrator.logic.ts's `deriveReviewGateView`) directly. Instead it
// runs that internal view through
// `apps/orchestrator/src/mastra/workflows/orchestrator.review-gate-view.ts`'s
// `toWireReviewGateView`, which produces exactly this spec's originally
// proposed §4 shape — a `kind`-discriminated union with the 5-value
// `TierCGateStatus` — so, contrary to the previous revision of this file's
// comment, the wire shape now DOES match Spec 09 §4 literally. This is a
// STRUCTURAL COPY of `WireReviewGateView` from that file (see the
// importability note at the top of this file for why it can't be a real
// `import type`) — keep in lockstep by hand if the orchestrator's wire
// transform changes. See review-gate-adapter.ts for the mapping helpers a
// later stage uses to bridge this shape to packages/ui's `IndependenceGate`
// component (which uses yet a different vocabulary, `IndependenceState`).
// ---------------------------------------------------------------------------

export type TierCGateStatus =
  | "unclaimed" // no reviewer has claimed either slot yet (or viewer is not entitled to know more)
  | "claimed_by_viewer" // viewer holds a slot, has not decided
  | "viewer_submitted_awaiting_peer" // viewer decided, peer has not (yet) — independence boundary
  | "resolved_agree" // both decided, same decision -> committed/rejected
  | "resolved_disagree"; // both decided, different decision -> escalated

/** THE independence guarantee lives in this type: `reveal` is only ever
 *  non-null when `status` starts with `"resolved_"` — i.e. after BOTH
 *  reviewers have submitted. There is no field on this type, at any
 *  nesting depth, that can carry one reviewer's decision/rationale to the
 *  other before that point. Computed server-side by
 *  `toWireReviewGateView`, which is itself backed by Spec 07's
 *  `getReviewsVisibleTo` per-caller redaction — never filtered
 *  client-side. */
export interface TierCReviewGateView {
  kind: "tier_c";
  rationaleRequired: true;
  viewerSlot: "maker" | "checker" | null;
  status: TierCGateStatus;
  reveal: { reviews: HumanReview[]; agreement: boolean } | null;
}

export interface TierBReviewGateView {
  kind: "tier_b";
  rationaleRequired: false;
  existingDecision: HumanReview | null; // non-null once decided (renders as read-only confirmation)
}

export interface EscalateReviewGateView {
  kind: "escalate";
  rationaleRequired: true; // required to reject; approve is not offered at all (FR-27)
  existingDecision: HumanReview | null;
}

export type ReviewGateView = TierBReviewGateView | TierCReviewGateView | EscalateReviewGateView;

// ---------------------------------------------------------------------------
// Queue (screen 1)
// ---------------------------------------------------------------------------

/** Per-obligation Tier C claim/gate summary shown in the queue row.
 *  `status` is the real 4-value `ReviewGateStatus` above (see its doc
 *  comment for why this diverges from Spec 09's original proposed
 *  5-value `TierCGateStatus`). `viewerSlot` comes from a *separate*
 *  Orchestrator concept (`SuspendedRunIndexPort.claim` /
 *  `handleClaimRequest`, orchestrator.logic.ts) than `status` (which
 *  comes from `handleReviewGateRequest` / `deriveReviewGateView`) — a
 *  later BFF stage must call both and merge them here; this type does
 *  not assume they always arrive from the same call. */
export interface TierCViewerQueueState {
  viewerSlot: "maker" | "checker" | null; // null = viewer has not claimed a slot yet
  status: TierCGateStatus;
}

export interface QueueItemSummary {
  obligationId: string;
  circularTitle: string;
  category: string;
  summary: string; // one-line; see FR-2 for how it's derived (reuse Spec 05's truncation helper)
  /** Real `ReviewTier` is "A"|"B"|"C" only; "ESCALATE" is an
   *  orchestrator-level tier decision (risk-score.scorer.ts's
   *  `TierDecision.tier`), not a `ReviewTier` value — Tier A MUST never
   *  appear here per FR-1 (Tier A has no reviewer UI). */
  tier: ReviewTier | "ESCALATE";
  tierReasons: string[]; // best-effort from Spec 07's ledger; [] if unavailable, never blocks render
  confidenceScore: number; // Obligation.confidence_score
  groundingScore: number; // Obligation.grounding_score
  riskScore: number; // ProcessTask.risk_score
  status: ObligationStatus;
  slaDueAt: string | null; // ISO datetime — review SLA, distinct from ProcessTask.sla_hours (see FR-3)
  slaState: SlaState;
  isEscalated: boolean; // true for contradiction/grounding-failure OR SLA-breach reassignment
  escalationReason: string | null; // e.g. "SLA missed, reassigned from priya.k" or a contradiction summary
  assignedReviewerId: string | null; // current owner of this item, post reassignment if any
  tierCViewerState: TierCViewerQueueState | null; // present only when tier === "C"
}

export interface QueueListRequest {
  tiers?: Array<"B" | "C" | "ESCALATE">; // default: all three; Tier A is never listed (UX brief §8)
  statuses?: ObligationStatus[]; // default: ["tier_b_review", "tier_c_review", "escalated"]
  assignedToMe?: boolean; // default true for compliance_officer/senior_compliance_officer
  cursor?: string;
  limit?: number; // default 25, max 100
}

export interface QueueListResponse {
  items: QueueItemSummary[];
  nextCursor: string | null;
  /** Spec 09 §8's queue/detail degraded-read row: `true` when the
   *  Orchestrator's batched review-gate call failed for this page (network
   *  error, non-2xx, or `ORCHESTRATOR_BASE_URL` unconfigured) — `items` is
   *  still populated from Neo4j alone, but every item's `slaState`/
   *  `tierCViewerState` are the neutral/unavailable placeholders described
   *  on those fields' own doc comments, not a guessed real value. The
   *  route handler MUST NOT let the UI treat a degraded page the same as
   *  a genuinely-empty/resolved gate — this flag is how the client tells
   *  the difference (added this stage; not in Spec 09 §4's original code
   *  block, which predates the Orchestrator's real HTTP layer existing). */
  orchestratorUnavailable: boolean;
}

// ---------------------------------------------------------------------------
// Item detail (screen 2) — Change-and-Delta diff contract.
//
// Structural copy of apps/orchestrator/src/mastra/agents/
// change-and-delta.types.ts's REAL `FieldDiffStatus`/`ProcessTaskFieldDiff`/
// `ProcessTaskRedline` (Spec 06, already shipped) — NOT Spec 09's original
// proposed `ProcessTaskFieldDiff { field, before, after, changed }` shape,
// which predates Spec 06's implementation and does not match it (real
// shape uses `oldValue`/`newValue`/`status: FieldDiffStatus`, not
// `before`/`after`/`changed: boolean`). See diff-adapter.ts for the
// mapping into packages/ui's `RedlineDiff` component's `DiffField` prop
// shape (a fourth, UI-layer vocabulary).
// ---------------------------------------------------------------------------

export type FieldDiffStatus = "unchanged" | "changed" | "added" | "removed";

export interface ProcessTaskFieldDiff {
  field: "task_name" | "owner_role" | "sla_hours" | "system_touchpoint" | "risk_score";
  oldValue: string | number | null;
  newValue: string | number | null;
  status: FieldDiffStatus;
}

/** `ProcessTaskDraft` per risk-score.scorer.ts — everything needed to
 *  create a ProcessTask minus fields the Orchestrator assigns at commit
 *  time. Reproduced here via `Omit<ProcessTask, ...>` (not a mirrored
 *  interface) since it is a pure derivation of a real graph-schema type,
 *  not new shape apps/orchestrator invents. */
export type ProcessTaskDraft = Omit<ProcessTask, "task_id" | "valid_from" | "valid_to" | "recorded_at">;

export interface ProcessTaskRedline {
  /** null when there is no prior ProcessTask to diff against (a brand
   *  new Obligation, or a superseded Obligation with no live
   *  ProcessTask). Drives diff-adapter.ts's FR-11/FR-12 "new task" path. */
  oldTaskId: string | null;
  oldObligationId: string | null;
  newProcessTaskDraft: ProcessTaskDraft;
  /** Opaque here — this layer only ever reads `newProcessTaskDraft`/
   *  `fields`/`oldTaskId`/`oldObligationId` off a `ProcessTaskRedline`.
   *  Real shape is apps/orchestrator's `ObligationProposal`
   *  (obligation-extraction.types.ts); not reproduced since unused, to
   *  avoid a second copy that can silently drift. */
  newObligationProposal: Record<string, unknown>;
  fields: ProcessTaskFieldDiff[]; // always exactly 5 entries, one per ProcessTask field
  overallStatus: "new" | "modified";
}

/** BFF-assembled item-detail diff payload (this app's own shape, not a
 *  1:1 mirror of ProcessTaskRedline) — `null` when the Obligation has no
 *  Change-and-Delta origin at all (first-version obligation), matching
 *  Spec 09 FR-12's "New task" rendering path (see diff-adapter.ts). */
export interface ProcessTaskDiff {
  obligationId: string;
  redline: ProcessTaskRedline;
}

/** Structural copy of apps/orchestrator/src/mastra/agents/
 *  grounding-verification.types.ts's REAL `ContradictionDetail` (Spec
 *  04) — NOT Spec 09's original proposed shape (which used
 *  `conflictingObligationId`/`conflictingField`/`proposedValue`/
 *  `existingValue` camelCase names and a 4-field `conflictingField`
 *  union that included `"responsible_role"`, since removed upstream).
 *  `conflictingObligationSummary` is a BFF-only addition (not present on
 *  the real type) — Spec 09 FR-15 needs a human-readable summary of the
 *  conflicting Obligation to render the side-by-side panel, and the real
 *  type only carries the id; a later BFF stage must resolve it via
 *  `graph-queries.ts`. */
export interface ContradictionDetail {
  conflicting_obligation_id: string;
  conflicting_obligation_summary: string;
  divergent_field: "deadline_rule" | "requirement_text" | "penalty_ref";
  proposed_value: string;
  existing_value: string;
  explanation: string;
}

export interface ObligationDetailResponse {
  obligation: Obligation;
  sourceClause: { clauseId: string; paraRef: string; text: string };
  sourceCircular: { circularId: string; title: string; dateEffective: string };
  processTaskDiff: ProcessTaskDiff | null; // null when this Obligation has no Change-and-Delta origin
  lineage: LineageStep[]; // matches LineageBreadcrumb's prop shape directly
  contradiction: ContradictionDetail | null; // non-null only when tier === "ESCALATE"
  tier: ReviewTier | "ESCALATE";
  tierReasons: string[];
  reviewGate: ReviewGateView;
  slaDueAt: string | null;
  slaState: SlaState;
  escalationReason: string | null;
  /** Spec 09 §8's item-detail degraded-read row: `true` when the
   *  Orchestrator's `GET .../review-gate` call failed for this obligation
   *  — `reviewGate` above is then a synthesized, maximally-restrictive
   *  placeholder (never a guessed real decision state; see
   *  items/[obligationId]/route.ts's doc comment for the exact shape) and
   *  the sign-off panel MUST disable submission while this is `true`
   *  ("this protects the independence guarantee itself, since a degraded
   *  read is exactly the condition under which a stale/incorrect gate
   *  state would be dangerous"). Added this stage; not in Spec 09 §4's
   *  original code block. */
  reviewGateUnavailable: boolean;
}

// ---------------------------------------------------------------------------
// Decision submission (screen 3 / sign-off panel)
// ---------------------------------------------------------------------------

/** GAP vs the real data model, intentionally left as an extension point:
 *  the real `ReviewDecision` (graph-schema/src/nodes.ts) is exactly
 *  `"approve" | "reject"` — there is no `"escalate_to_tier_c"` value, and
 *  `recordHumanReview` (monitoring-and-audit.agent.ts) would reject any
 *  other string with a `ValidationError`. `"escalate_to_tier_c"` is a
 *  BFF-level *routing* concept (Spec 09 FR-28: an ESCALATE item's
 *  `Obligation.status` moves to `"tier_c_review"` and it re-enters the
 *  Tier C maker-checker flow) — it is NOT submitted to
 *  `recordHumanReview`/`resumeOrchestratorRun` as a `HumanReview.decision`
 *  at all. A later stage (BFF route handlers) must branch on this value
 *  BEFORE calling orchestrator-client.ts's `submitDecision`, not pass it
 *  through.
 *  RESOLVED (spec-09-stage-2): no such mechanism exists, and — per the
 *  full analysis in items/[obligationId]/decisions/route.ts's top-of-file
 *  doc comment — none can, given the real workflow graph (ESCALATE items
 *  already run through the exact same dual-review suspend/claim flow as
 *  Tier C from the moment they're routed, so there is no separate
 *  pre-Tier-C state to transition out of). That route returns `501
 *  NOT_IMPLEMENTED` for `escalate_to_tier_c` on an ESCALATE item rather
 *  than fake a transition or write to the graph directly. */
export type DecisionAction = "approve" | "reject" | "escalate_to_tier_c";

export interface SubmitDecisionRequest {
  decision: DecisionAction;
  rationale: string | null; // required (non-empty, trimmed) whenever the gate requires it (Tier C / ESCALATE reject)
}

export interface SubmitDecisionResponse {
  obligationStatus: ObligationStatus;
  humanReview: HumanReview; // the fact just written — for MY OWN decision only, never the peer's
  reviewGate: ReviewGateView; // updated view, same redaction rules as GET detail apply
}

// ---------------------------------------------------------------------------
// Re-exports for convenience — callers of this module should not need a
// second import from @sentinel-act/graph-schema for these.
// ---------------------------------------------------------------------------

export type { Obligation, ObligationStatus, ProcessTask, Clause, Circular, HumanReview, ReviewTier, ReviewDecision };
