// --scenario=cuspa-pre fixture (FR-17): exactly the pre-3-July-2026 graph
// state the live CUSPA / Paragraph 46 demo needs, expressed as a
// CommitPlan so it loads through the same GraphWriter.commitProposal path
// as every other write in this package (no bespoke seed-only Cypher).
// Fixed proposalId ("seed-cuspa-pre") is what makes re-running this
// scenario idempotent (FR-15/FR-19/AC5) — the second call short-circuits
// on the :CommitLog marker and returns the cached CommitResult instead of
// re-running any writes.
//
// All ids below are fixed, hardcoded UUIDs (not crypto.randomUUID()) per
// FR-19, so this fixture's identity is stable across every seed run,
// every test run, and the live demo rehearsal.
import type { CommitPlan } from "../../src/types.js";

export const CUSPA_PRE_CIRCULAR_ID = "a1a1a1a1-0001-4001-8001-000000000001";
export const CUSPA_PRE_CLAUSE_ID = "a1a1a1a1-0002-4002-8002-000000000002";
export const CUSPA_PRE_OBLIGATION_ID = "a1a1a1a1-0003-4003-8003-000000000003";
export const CUSPA_PRE_TASK_ID = "a1a1a1a1-0004-4004-8004-000000000004";
export const STOCKBROKER_CATEGORY_ID = "a1a1a1a1-0005-4005-8005-000000000005";

/** Small, deterministic placeholder vector (not a real embedding model
 *  output — no spec has picked one yet, see spec §13 open question #3).
 *  1536-dim to match migrations/004_vector_index.cypher's configured
 *  vector.dimensions. */
function placeholderEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed * 0.017 + i * 0.031));
}

export function buildCuspaPreAmendmentPlan(): CommitPlan {
  return {
    proposalId: "seed-cuspa-pre",
    nodes: {
      circulars: [
        {
          circular_id: CUSPA_PRE_CIRCULAR_ID,
          title: "Master Circular for Stock Brokers — Client Unpaid Securities Handling",
          type: "master_circular",
          category: "market_intermediaries",
          date_issued: "2026-01-10",
          date_effective: "2026-01-15",
          source_hash: "3f1b2c4d5e6f7089a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071",
          supersedes_circular_id: null,
          valid_from: "2026-01-15",
          valid_to: null
        }
      ],
      clauses: [
        {
          clause_id: CUSPA_PRE_CLAUSE_ID,
          circular_id: CUSPA_PRE_CIRCULAR_ID,
          para_ref: "46",
          text:
            "Para 46: Where securities of a client remain unpaid, the stock broker shall deal with such client unpaid " +
            "securities account (CUSPA) strictly in accordance with the procedure prescribed under this circular, " +
            "including timelines for disposal and client intimation.",
          embedding_ref: JSON.stringify(placeholderEmbedding(46)),
          valid_from: "2026-01-15",
          valid_to: null
        }
      ],
      obligations: [
        {
          obligation_id: CUSPA_PRE_OBLIGATION_ID,
          derived_from_clause_id: CUSPA_PRE_CLAUSE_ID,
          category: "client_asset_protection",
          requirement_text:
            "Stock brokers must dispose of client unpaid securities per the CUSPA procedure and intimate clients " +
            "within the prescribed window.",
          trigger_event: "client_securities_unpaid",
          deadline_rule: "T+5 trading days from unpaid status",
          responsible_role: "Compliance Officer",
          evidence_required: "CUSPA disposal log and client intimation record",
          penalty_ref: null,
          confidence_score: 0.95,
          grounding_score: 0.95,
          status: "committed",
          valid_from: "2026-01-15",
          valid_to: null
        }
      ],
      processTasks: [
        {
          task_id: CUSPA_PRE_TASK_ID,
          obligation_id: CUSPA_PRE_OBLIGATION_ID,
          task_name: "Process CUSPA disposal and client intimation",
          owner_role: "Compliance Officer",
          sla_hours: 120,
          system_touchpoint: "Back-office CUSPA ledger",
          risk_score: 0.3,
          valid_from: "2026-01-15",
          valid_to: null
        }
      ],
      intermediaryCategories: [{ category_id: STOCKBROKER_CATEGORY_ID, name: "Stockbroker" }]
    },
    edges: [
      { type: "PART_OF", clause_id: CUSPA_PRE_CLAUSE_ID, circular_id: CUSPA_PRE_CIRCULAR_ID },
      { type: "DERIVED_FROM", obligation_id: CUSPA_PRE_OBLIGATION_ID, clause_id: CUSPA_PRE_CLAUSE_ID },
      { type: "MAPPED_TO", obligation_id: CUSPA_PRE_OBLIGATION_ID, task_id: CUSPA_PRE_TASK_ID },
      { type: "APPLIES_TO", obligation_id: CUSPA_PRE_OBLIGATION_ID, category_id: STOCKBROKER_CATEGORY_ID }
    ]
  };
}
