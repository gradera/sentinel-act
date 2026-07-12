// --scenario=dev-sample fixture: a broader synthetic queue for local dev
// and the Web Governance Console demo — multiple circulars/obligations
// spanning Tier A/B/C/escalated statuses and two IntermediaryCategory
// values, plus five Clause nodes with populated embedding_ref vectors
// (the minimum the vector-index integration test needs to exercise
// `findSimilarClauses` meaningfully — see spec Acceptance Criterion 7).
// Same idempotency mechanism as the other fixtures: fixed proposalId
// ("seed-dev-sample") + fixed UUIDs throughout.
import type { CommitPlan } from "../../src/types.js";
import { STOCKBROKER_CATEGORY_ID } from "./cuspa-pre-amendment.js";

export const INVESTMENT_ADVISER_CATEGORY_ID = "c3c3c3c3-0000-4000-8000-000000000099";

const CIRCULAR_IDS = [
  "c3c3c3c3-0001-4001-8001-000000000001",
  "c3c3c3c3-0001-4001-8001-000000000002"
] as const;

const CLAUSE_IDS = [
  "c3c3c3c3-0002-4002-8002-000000000001",
  "c3c3c3c3-0002-4002-8002-000000000002",
  "c3c3c3c3-0002-4002-8002-000000000003",
  "c3c3c3c3-0002-4002-8002-000000000004",
  "c3c3c3c3-0002-4002-8002-000000000005"
] as const;

const OBLIGATION_IDS = [
  "c3c3c3c3-0003-4003-8003-000000000001",
  "c3c3c3c3-0003-4003-8003-000000000002",
  "c3c3c3c3-0003-4003-8003-000000000003",
  "c3c3c3c3-0003-4003-8003-000000000004",
  "c3c3c3c3-0003-4003-8003-000000000005"
] as const;

const TASK_IDS = [
  "c3c3c3c3-0004-4004-8004-000000000001",
  "c3c3c3c3-0004-4004-8004-000000000002",
  "c3c3c3c3-0004-4004-8004-000000000003",
  "c3c3c3c3-0004-4004-8004-000000000004",
  "c3c3c3c3-0004-4004-8004-000000000005"
] as const;

function placeholderEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed * 0.017 + i * 0.031));
}

export function buildDevSampleSetPlan(): CommitPlan {
  return {
    proposalId: "seed-dev-sample",
    nodes: {
      circulars: [
        {
          circular_id: CIRCULAR_IDS[0],
          title: "Circular on Investment Adviser Disclosure Norms",
          type: "circular",
          category: "investment_advisers",
          date_issued: "2025-11-01",
          date_effective: "2025-11-15",
          source_hash: "1111111111111111111111111111111111111111111111111111111111111a",
          supersedes_circular_id: null,
          valid_from: "2025-11-15",
          valid_to: null
        },
        {
          circular_id: CIRCULAR_IDS[1],
          title: "Circular on Stockbroker Risk Management Systems",
          type: "circular",
          category: "market_intermediaries",
          date_issued: "2025-12-01",
          date_effective: "2025-12-10",
          source_hash: "2222222222222222222222222222222222222222222222222222222222222b",
          supersedes_circular_id: null,
          valid_from: "2025-12-10",
          valid_to: null
        }
      ],
      clauses: [
        {
          clause_id: CLAUSE_IDS[0],
          circular_id: CIRCULAR_IDS[0],
          para_ref: "3.1",
          text: "Investment advisers shall disclose all material conflicts of interest to clients in writing prior to advice.",
          embedding_ref: JSON.stringify(placeholderEmbedding(1)),
          valid_from: "2025-11-15",
          valid_to: null
        },
        {
          clause_id: CLAUSE_IDS[1],
          circular_id: CIRCULAR_IDS[0],
          para_ref: "4.2",
          text: "Investment advisers shall maintain records of client risk profiling for a minimum of five years.",
          embedding_ref: JSON.stringify(placeholderEmbedding(2)),
          valid_from: "2025-11-15",
          valid_to: null
        },
        {
          clause_id: CLAUSE_IDS[2],
          circular_id: CIRCULAR_IDS[1],
          para_ref: "12",
          text: "Stock brokers shall implement automated risk management systems with real-time position monitoring.",
          embedding_ref: JSON.stringify(placeholderEmbedding(3)),
          valid_from: "2025-12-10",
          valid_to: null
        },
        {
          clause_id: CLAUSE_IDS[3],
          circular_id: CIRCULAR_IDS[1],
          para_ref: "18",
          text: "Stock brokers shall report risk management system outages to the exchange within one hour of detection.",
          embedding_ref: JSON.stringify(placeholderEmbedding(4)),
          valid_from: "2025-12-10",
          valid_to: null
        },
        {
          clause_id: CLAUSE_IDS[4],
          circular_id: CIRCULAR_IDS[1],
          para_ref: "22",
          text: "Stock brokers shall conduct an annual independent audit of their risk management systems.",
          embedding_ref: JSON.stringify(placeholderEmbedding(5)),
          valid_from: "2025-12-10",
          valid_to: null
        }
      ],
      obligations: [
        {
          // Tier A — high confidence/grounding, low risk, auto-committed.
          obligation_id: OBLIGATION_IDS[0],
          derived_from_clause_id: CLAUSE_IDS[0],
          category: "disclosure",
          requirement_text: "Disclose material conflicts of interest to clients in writing prior to advice.",
          trigger_event: "advice_rendered",
          deadline_rule: "prior_to_advice",
          responsible_role: "Investment Adviser",
          evidence_required: "Signed disclosure record",
          penalty_ref: null,
          confidence_score: 0.96,
          grounding_score: 0.97,
          status: "tier_a_committed",
          valid_from: "2025-11-15",
          valid_to: null
        },
        {
          // Tier B — medium confidence, single-reviewer queue.
          obligation_id: OBLIGATION_IDS[1],
          derived_from_clause_id: CLAUSE_IDS[1],
          category: "recordkeeping",
          requirement_text: "Maintain client risk profiling records for a minimum of five years.",
          trigger_event: "client_onboarded",
          deadline_rule: "retain_5_years",
          responsible_role: "Investment Adviser",
          evidence_required: "Archived risk profiling records",
          penalty_ref: null,
          confidence_score: 0.72,
          grounding_score: 0.75,
          status: "tier_b_review",
          valid_from: "2025-11-15",
          valid_to: null
        },
        {
          // Tier C — high risk (penalty-bearing), maker-checker.
          obligation_id: OBLIGATION_IDS[2],
          derived_from_clause_id: CLAUSE_IDS[2],
          category: "risk_management",
          requirement_text: "Implement automated risk management systems with real-time position monitoring.",
          trigger_event: "trading_system_go_live",
          deadline_rule: "before_go_live",
          responsible_role: "Chief Risk Officer",
          evidence_required: "System validation report",
          penalty_ref: "SEBI/RMS/2025/PEN-12",
          confidence_score: 0.68,
          grounding_score: 0.7,
          status: "tier_c_review",
          valid_from: "2025-12-10",
          valid_to: null
        },
        {
          // Escalated — grounding failure / contradiction path.
          obligation_id: OBLIGATION_IDS[3],
          derived_from_clause_id: CLAUSE_IDS[3],
          category: "incident_reporting",
          requirement_text: "Report risk management system outages to the exchange within one hour of detection.",
          trigger_event: "system_outage_detected",
          deadline_rule: "T+1 hour",
          responsible_role: "Compliance Officer",
          evidence_required: "Outage report acknowledgement",
          penalty_ref: "SEBI/RMS/2025/PEN-14",
          confidence_score: 0.55,
          grounding_score: 0.4,
          status: "escalated",
          valid_from: "2025-12-10",
          valid_to: null
        },
        {
          // Freshly proposed — still at the top of the queue.
          obligation_id: OBLIGATION_IDS[4],
          derived_from_clause_id: CLAUSE_IDS[4],
          category: "audit",
          requirement_text: "Conduct an annual independent audit of risk management systems.",
          trigger_event: "fiscal_year_end",
          deadline_rule: "annual",
          responsible_role: "Chief Risk Officer",
          evidence_required: "Independent audit report",
          penalty_ref: null,
          confidence_score: 0.6,
          grounding_score: 0.65,
          status: "proposed",
          valid_from: "2025-12-10",
          valid_to: null
        }
      ],
      processTasks: [
        {
          task_id: TASK_IDS[0],
          obligation_id: OBLIGATION_IDS[0],
          task_name: "Send written conflict-of-interest disclosure",
          owner_role: "Investment Adviser",
          sla_hours: 24,
          system_touchpoint: "CRM disclosure workflow",
          risk_score: 0.15,
          valid_from: "2025-11-15",
          valid_to: null
        },
        {
          task_id: TASK_IDS[1],
          obligation_id: OBLIGATION_IDS[1],
          task_name: "Archive client risk profiling record",
          owner_role: "Investment Adviser",
          sla_hours: 48,
          system_touchpoint: "Document management system",
          risk_score: 0.45,
          valid_from: "2025-11-15",
          valid_to: null
        },
        {
          task_id: TASK_IDS[2],
          obligation_id: OBLIGATION_IDS[2],
          task_name: "Validate real-time RMS position monitoring",
          owner_role: "Chief Risk Officer",
          sla_hours: 72,
          system_touchpoint: "Risk management system",
          risk_score: 0.8,
          valid_from: "2025-12-10",
          valid_to: null
        },
        {
          task_id: TASK_IDS[3],
          obligation_id: OBLIGATION_IDS[3],
          task_name: "File exchange outage report",
          owner_role: "Compliance Officer",
          sla_hours: 1,
          system_touchpoint: "Exchange reporting portal",
          risk_score: 0.85,
          valid_from: "2025-12-10",
          valid_to: null
        },
        {
          task_id: TASK_IDS[4],
          obligation_id: OBLIGATION_IDS[4],
          task_name: "Commission independent RMS audit",
          owner_role: "Chief Risk Officer",
          sla_hours: 720,
          system_touchpoint: "Vendor management system",
          risk_score: 0.5,
          valid_from: "2025-12-10",
          valid_to: null
        }
      ],
      intermediaryCategories: [
        { category_id: STOCKBROKER_CATEGORY_ID, name: "Stockbroker" },
        { category_id: INVESTMENT_ADVISER_CATEGORY_ID, name: "Investment Adviser" }
      ]
    },
    edges: [
      { type: "PART_OF", clause_id: CLAUSE_IDS[0], circular_id: CIRCULAR_IDS[0] },
      { type: "PART_OF", clause_id: CLAUSE_IDS[1], circular_id: CIRCULAR_IDS[0] },
      { type: "PART_OF", clause_id: CLAUSE_IDS[2], circular_id: CIRCULAR_IDS[1] },
      { type: "PART_OF", clause_id: CLAUSE_IDS[3], circular_id: CIRCULAR_IDS[1] },
      { type: "PART_OF", clause_id: CLAUSE_IDS[4], circular_id: CIRCULAR_IDS[1] },

      { type: "DERIVED_FROM", obligation_id: OBLIGATION_IDS[0], clause_id: CLAUSE_IDS[0] },
      { type: "DERIVED_FROM", obligation_id: OBLIGATION_IDS[1], clause_id: CLAUSE_IDS[1] },
      { type: "DERIVED_FROM", obligation_id: OBLIGATION_IDS[2], clause_id: CLAUSE_IDS[2] },
      { type: "DERIVED_FROM", obligation_id: OBLIGATION_IDS[3], clause_id: CLAUSE_IDS[3] },
      { type: "DERIVED_FROM", obligation_id: OBLIGATION_IDS[4], clause_id: CLAUSE_IDS[4] },

      { type: "MAPPED_TO", obligation_id: OBLIGATION_IDS[0], task_id: TASK_IDS[0] },
      { type: "MAPPED_TO", obligation_id: OBLIGATION_IDS[1], task_id: TASK_IDS[1] },
      { type: "MAPPED_TO", obligation_id: OBLIGATION_IDS[2], task_id: TASK_IDS[2] },
      { type: "MAPPED_TO", obligation_id: OBLIGATION_IDS[3], task_id: TASK_IDS[3] },
      { type: "MAPPED_TO", obligation_id: OBLIGATION_IDS[4], task_id: TASK_IDS[4] },

      { type: "APPLIES_TO", obligation_id: OBLIGATION_IDS[0], category_id: INVESTMENT_ADVISER_CATEGORY_ID },
      { type: "APPLIES_TO", obligation_id: OBLIGATION_IDS[1], category_id: INVESTMENT_ADVISER_CATEGORY_ID },
      { type: "APPLIES_TO", obligation_id: OBLIGATION_IDS[2], category_id: STOCKBROKER_CATEGORY_ID },
      { type: "APPLIES_TO", obligation_id: OBLIGATION_IDS[3], category_id: STOCKBROKER_CATEGORY_ID },
      { type: "APPLIES_TO", obligation_id: OBLIGATION_IDS[4], category_id: STOCKBROKER_CATEGORY_ID }
    ]
  };
}
