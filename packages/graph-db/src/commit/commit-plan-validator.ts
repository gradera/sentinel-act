// zod schema for CommitPlan (FR-13). commitProposal MUST validate the
// incoming plan against this schema before opening any transaction —
// required fields present, effectiveDate/valid_from/valid_to are valid
// ISO dates, confidence_score/grounding_score/risk_score in [0,1].
import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { CommitPlan } from "../types.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");
const isoDateNullable = isoDate.nullable();
const unitInterval = z.number().min(0).max(1);
const nonEmptyString = z.string().min(1);

const bitemporalCreateFields = {
  valid_from: isoDate,
  valid_to: isoDateNullable
};

const circularSchema = z.object({
  ...bitemporalCreateFields,
  circular_id: nonEmptyString,
  title: nonEmptyString,
  type: nonEmptyString,
  category: nonEmptyString,
  date_issued: isoDate,
  date_effective: isoDate,
  source_hash: nonEmptyString,
  supersedes_circular_id: z.string().nullable()
});

const clauseSchema = z.object({
  ...bitemporalCreateFields,
  clause_id: nonEmptyString,
  circular_id: nonEmptyString,
  para_ref: nonEmptyString,
  text: nonEmptyString,
  embedding_ref: z.string()
});

const obligationStatusSchema = z.enum([
  "proposed",
  "tier_a_committed",
  "tier_b_review",
  "tier_c_review",
  "escalated",
  "committed",
  "rejected"
]);

const obligationSchema = z.object({
  ...bitemporalCreateFields,
  obligation_id: nonEmptyString,
  derived_from_clause_id: nonEmptyString,
  category: nonEmptyString,
  requirement_text: nonEmptyString,
  trigger_event: nonEmptyString,
  deadline_rule: nonEmptyString,
  responsible_role: nonEmptyString,
  evidence_required: nonEmptyString,
  penalty_ref: z.string().nullable(),
  confidence_score: unitInterval,
  grounding_score: unitInterval,
  status: obligationStatusSchema
});

const processTaskSchema = z.object({
  ...bitemporalCreateFields,
  task_id: nonEmptyString,
  obligation_id: nonEmptyString,
  task_name: nonEmptyString,
  owner_role: nonEmptyString,
  sla_hours: z.number().nonnegative(),
  system_touchpoint: nonEmptyString,
  risk_score: unitInterval
});

const evidenceArtifactSchema = z.object({
  ...bitemporalCreateFields,
  evidence_id: nonEmptyString,
  task_id: nonEmptyString,
  type: nonEmptyString,
  hash: nonEmptyString,
  uploaded_at: nonEmptyString,
  uploaded_by: nonEmptyString
});

const intermediaryCategorySchema = z.object({
  category_id: nonEmptyString,
  name: nonEmptyString
});

const humanReviewSchema = z.object({
  ...bitemporalCreateFields,
  review_id: nonEmptyString,
  obligation_id: nonEmptyString,
  reviewer_id: nonEmptyString,
  tier: z.enum(["A", "B", "C"]),
  decision: z.enum(["approve", "reject"]),
  rationale: z.string().nullable(),
  decided_at: nonEmptyString
});

const supersedesEdgeSchema = z.object({
  type: z.literal("SUPERSEDES"),
  from_id: nonEmptyString,
  to_id: nonEmptyString
});
const partOfEdgeSchema = z.object({
  type: z.literal("PART_OF"),
  clause_id: nonEmptyString,
  circular_id: nonEmptyString
});
const derivedFromEdgeSchema = z.object({
  type: z.literal("DERIVED_FROM"),
  obligation_id: nonEmptyString,
  clause_id: nonEmptyString
});
const appliesToEdgeSchema = z.object({
  type: z.literal("APPLIES_TO"),
  obligation_id: nonEmptyString,
  category_id: nonEmptyString
});
const mappedToEdgeSchema = z.object({
  type: z.literal("MAPPED_TO"),
  obligation_id: nonEmptyString,
  task_id: nonEmptyString
});
const evidencedByEdgeSchema = z.object({
  type: z.literal("EVIDENCED_BY"),
  task_id: nonEmptyString,
  evidence_id: nonEmptyString
});
const reviewedByEdgeSchema = z.object({
  type: z.literal("REVIEWED_BY"),
  obligation_id: nonEmptyString,
  review_id: nonEmptyString
});

const graphEdgeSchema = z.discriminatedUnion("type", [
  supersedesEdgeSchema,
  partOfEdgeSchema,
  derivedFromEdgeSchema,
  appliesToEdgeSchema,
  mappedToEdgeSchema,
  evidencedByEdgeSchema,
  reviewedByEdgeSchema
]);

const supersessionInstructionSchema = z.object({
  kind: z.enum(["Circular", "Obligation"]),
  oldId: nonEmptyString,
  effectiveDate: isoDate
});

// NOTE (FR-13): "ids referenced by edges exist somewhere in the plan or
// are assumed to already exist in the graph" is deliberately NOT
// enforced here as a hard structural check — the spec itself allows an
// edge to reference an already-committed node that isn't part of this
// plan at all, which zod (a pure-data validator with no DB access)
// cannot distinguish from a genuinely missing id. That existence check
// happens at Cypher-execution time in GraphWriter.commitProposal (a
// MATCH that finds zero rows for an edge endpoint throws CommitError and
// rolls back the whole transaction — see Acceptance Criterion 2).
export const commitPlanSchema = z.object({
  proposalId: nonEmptyString,
  nodes: z.object({
    circulars: z.array(circularSchema).optional(),
    clauses: z.array(clauseSchema).optional(),
    obligations: z.array(obligationSchema).optional(),
    processTasks: z.array(processTaskSchema).optional(),
    evidenceArtifacts: z.array(evidenceArtifactSchema).optional(),
    intermediaryCategories: z.array(intermediaryCategorySchema).optional(),
    humanReviews: z.array(humanReviewSchema).optional()
  }),
  edges: z.array(graphEdgeSchema),
  supersessions: z.array(supersessionInstructionSchema).optional()
});

/** Validates and returns a CommitPlan, or throws ValidationError with a
 *  field-level zod issue list. Never runs any Cypher. */
export function validateCommitPlan(plan: unknown): CommitPlan {
  const result = commitPlanSchema.safeParse(plan);
  if (!result.success) {
    throw new ValidationError("CommitPlan failed validation.", result.error.issues);
  }
  return result.data as CommitPlan;
}
