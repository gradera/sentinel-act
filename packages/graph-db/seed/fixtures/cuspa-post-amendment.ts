// --scenario=cuspa-post fixture (FR-18): the 3 July 2026 CUSPA / Paragraph
// 46 amendment itself, expressed as a CommitPlan that exercises the real
// GraphWriter.commitProposal + supersede path — a new Circular
// (supersedes_circular_id set), a new Clause, a new Obligation linked
// -[:SUPERSEDES]-> the pre-amendment Obligation, effectiveDate
// "2026-07-03". This is for integration tests and dry-run rehearsal, NOT
// for the live demo itself (which triggers this via the real Watch ->
// Orchestrator pipeline, not the seed script — see FR-18's own note).
//
// Depends on --scenario=cuspa-pre having already been applied (the
// supersessions below target CUSPA_PRE_CIRCULAR_ID / CUSPA_PRE_OBLIGATION_ID).
import type { CommitPlan } from "../../src/types.js";
import { CUSPA_PRE_CIRCULAR_ID, CUSPA_PRE_OBLIGATION_ID, STOCKBROKER_CATEGORY_ID } from "./cuspa-pre-amendment.js";

export const CUSPA_POST_CIRCULAR_ID = "b2b2b2b2-0001-4001-8001-000000000001";
export const CUSPA_POST_CLAUSE_ID = "b2b2b2b2-0002-4002-8002-000000000002";
export const CUSPA_POST_OBLIGATION_ID = "b2b2b2b2-0003-4003-8003-000000000003";

export const CUSPA_AMENDMENT_EFFECTIVE_DATE = "2026-07-03";

function placeholderEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed * 0.017 + i * 0.031));
}

export function buildCuspaPostAmendmentPlan(): CommitPlan {
  return {
    proposalId: "seed-cuspa-post",
    nodes: {
      circulars: [
        {
          circular_id: CUSPA_POST_CIRCULAR_ID,
          title: "Amendment to Master Circular for Stock Brokers — Client Unpaid Securities Handling (Para 46)",
          type: "amendment_circular",
          category: "market_intermediaries",
          date_issued: "2026-06-28",
          date_effective: CUSPA_AMENDMENT_EFFECTIVE_DATE,
          source_hash: "9e8d7c6b5a4938271605f4e3d2c1b0a99887766554433221100ffeeddccbbaa",
          supersedes_circular_id: CUSPA_PRE_CIRCULAR_ID,
          valid_from: CUSPA_AMENDMENT_EFFECTIVE_DATE,
          valid_to: null
        }
      ],
      clauses: [
        {
          clause_id: CUSPA_POST_CLAUSE_ID,
          circular_id: CUSPA_POST_CIRCULAR_ID,
          para_ref: "46",
          text:
            "Para 46 (amended): Where securities of a client remain unpaid, the stock broker shall dispose of such " +
            "client unpaid securities account (CUSPA) within a revised, shortened timeline and shall intimate the " +
            "client through the additional revised channels prescribed under this amendment.",
          embedding_ref: JSON.stringify(placeholderEmbedding(4600)),
          valid_from: CUSPA_AMENDMENT_EFFECTIVE_DATE,
          valid_to: null
        }
      ],
      obligations: [
        {
          obligation_id: CUSPA_POST_OBLIGATION_ID,
          derived_from_clause_id: CUSPA_POST_CLAUSE_ID,
          category: "client_asset_protection",
          requirement_text:
            "Stock brokers must dispose of client unpaid securities per the revised CUSPA procedure and intimate " +
            "clients within the shortened window using the additional prescribed channels.",
          trigger_event: "client_securities_unpaid",
          deadline_rule: "T+3 trading days from unpaid status",
          responsible_role: "Compliance Officer",
          evidence_required: "CUSPA disposal log, multi-channel client intimation record",
          penalty_ref: null,
          confidence_score: 0.93,
          grounding_score: 0.9,
          status: "committed",
          valid_from: CUSPA_AMENDMENT_EFFECTIVE_DATE,
          valid_to: null
        }
      ]
    },
    edges: [
      { type: "PART_OF", clause_id: CUSPA_POST_CLAUSE_ID, circular_id: CUSPA_POST_CIRCULAR_ID },
      { type: "DERIVED_FROM", obligation_id: CUSPA_POST_OBLIGATION_ID, clause_id: CUSPA_POST_CLAUSE_ID },
      { type: "APPLIES_TO", obligation_id: CUSPA_POST_OBLIGATION_ID, category_id: STOCKBROKER_CATEGORY_ID },
      { type: "SUPERSEDES", from_id: CUSPA_POST_CIRCULAR_ID, to_id: CUSPA_PRE_CIRCULAR_ID },
      { type: "SUPERSEDES", from_id: CUSPA_POST_OBLIGATION_ID, to_id: CUSPA_PRE_OBLIGATION_ID }
    ],
    supersessions: [
      { kind: "Circular", oldId: CUSPA_PRE_CIRCULAR_ID, effectiveDate: CUSPA_AMENDMENT_EFFECTIVE_DATE },
      { kind: "Obligation", oldId: CUSPA_PRE_OBLIGATION_ID, effectiveDate: CUSPA_AMENDMENT_EFFECTIVE_DATE }
    ]
  };
}
