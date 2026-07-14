// packages/audit-ledger/src/types.ts — Spec 07 §4's second code block,
// copied verbatim. Non-schema types; the Hash-chained Audit Ledger's own
// domain model, deliberately separate from graph-schema per Spec 07 §1/§6.5.

export type LedgerEventType =
  | "AGENT_PROPOSAL" // any of the 5 fanned-out agents' proposal, logged by the Orchestrator
  | "TIER_ROUTING_DECISION" // Spec 05's TierDecision, logged by the Orchestrator
  | "GRAPH_COMMIT" // Spec 01's CommitResult, logged by the Orchestrator
  | "HUMAN_REVIEW_SUBMITTED" // this unit, via recordHumanReview
  | "EVIDENCE_ARTIFACT_INGESTED" // this unit, via ingestEvidenceArtifact (outcome === "ingested" | "duplicate")
  | "EVIDENCE_HASH_MISMATCH" // this unit, via ingestEvidenceArtifact (outcome === "hash_mismatch")
  | "SLA_APPROACHING" // this unit, via scanForSlaGaps state-transition (FR-10)
  | "SLA_BREACHED" // this unit, via scanForSlaGaps state-transition (FR-10)
  | "CHAIN_VERIFICATION_RUN" // this unit, via verifyChainIntegrity (successful runs only, see FR-32)
  // --- Spec 13 (GRC/Ticketing Integration) additive extension. Logged by
  // @sentinel-act/ticketing-adapter's processOutboxOnce (FR-15/FR-17) via
  // this package's AuditLedgerPort, narrowed to AppendLedgerEntryPort on
  // that side. Purely additive — see Spec 13 §13 item 2. ---
  | "TICKET_CREATED"
  | "TICKET_CREATE_FAILED"
  | "TICKET_UPDATED"
  | "TICKET_UPDATE_FAILED";

export interface LedgerActor {
  type: "agent" | "human" | "system";
  /** Agent name (e.g. "monitoring-and-audit", "mapping-and-risk-scoring"),
   *  reviewer_id, or a fixed system identifier (e.g. "sla-scan-cron",
   *  "chain-verification-cron"). */
  id: string;
}

export interface LedgerEntityRef {
  entity_type: "Circular" | "Clause" | "Obligation" | "ProcessTask" | "EvidenceArtifact" | "HumanReview" | null;
  entity_id: string | null;
}

/** One append-only ledger row. `entry_hash` chains to the previous row's
 *  `entry_hash` via `prev_entry_hash` — see §6.5 for the exact hashing
 *  procedure. This type is NOT part of `@sentinel-act/graph-schema`; the
 *  ledger is explicitly independent of the graph (per the architecture
 *  walkthrough's "Hash-chained Audit Ledger ... independent of the graph
 *  itself"). */
export interface LedgerEntry {
  sequence_number: number; // monotonic, gapless, assigned by the ledger store
  timestamp: string; // ISO datetime, ledger-store clock (not caller-supplied)
  event_type: LedgerEventType;
  actor: LedgerActor;
  entity_ref: LedgerEntityRef;
  /** The full event payload, stored alongside the hash (not just the
   *  hash) so the ledger is directly useful for the Compliance Register
   *  Export without a graph join for every field — see §6.7. */
  payload: Record<string, unknown>;
  payload_hash: string; // sha256(canonicalJSON(payload)), hex
  prev_entry_hash: string; // entry_hash of sequence_number - 1; GENESIS_HASH for entry 1
  entry_hash: string; // sha256(`${sequence_number}|${timestamp}|${event_type}|${payload_hash}|${prev_entry_hash}`), hex
}

/** Sentinel value for entry #1's prev_entry_hash — 64 zero characters,
 *  chosen (over a literal string like "GENESIS") so it is
 *  format-compatible with every other prev_entry_hash value and cannot
 *  be confused with a real SHA-256 output (which is drawn from a
 *  uniform-looking hex space but astronomically unlikely to be all
 *  zeros). */
export const GENESIS_HASH = "0".repeat(64);

export interface LedgerAppendInput {
  event_type: LedgerEventType;
  actor: LedgerActor;
  entity_ref: LedgerEntityRef;
  payload: Record<string, unknown>;
}

export interface LedgerQuery {
  entityType?: LedgerEntityRef["entity_type"];
  entityId?: string;
  eventTypes?: LedgerEventType[];
  fromTimestamp?: string;
  toTimestamp?: string;
  fromSequence?: number;
  toSequence?: number;
  limit?: number; // default 100, max 1000 — see NFR-6
}

export interface ChainVerificationResult {
  verifiedRangeStart: number;
  verifiedRangeEnd: number;
  entriesChecked: number;
  intact: boolean;
  /** Populated only when intact === false: the first sequence_number
   *  whose stored entry_hash does not match its recomputed hash, or
   *  whose prev_entry_hash does not match the prior entry's entry_hash. */
  firstBrokenSequenceNumber: number | null;
  ranAt: string;
}

/** The port `MonitoringAuditContext.ledger` is typed against — satisfied
 *  by `@sentinel-act/audit-ledger`'s Postgres-backed implementation
 *  (§6.5), but kept as an interface so unit tests can supply a fake. */
export interface AuditLedgerPort {
  append(input: LedgerAppendInput): Promise<LedgerEntry>;
  query(q: LedgerQuery): Promise<LedgerEntry[]>;
  verifyChainIntegrity(range?: { fromSequence?: number; toSequence?: number }): Promise<ChainVerificationResult>;
  getLatestEntryForEntity(
    entityType: LedgerEntityRef["entity_type"],
    entityId: string,
    eventTypes: LedgerEventType[]
  ): Promise<LedgerEntry | null>;
}
