// Local data-contract module for the Regulatory Watch and Ingestion
// Agent (Spec 02 §4). Types below are copied verbatim from the spec —
// do not drift the shape without updating the spec, since Spec 06
// (Change and Delta) consumes AmendmentContext/RegulatoryWatchTriggerEvent
// as a fixed contract.
import type { Circular, Clause } from "@sentinel-act/graph-schema";

// ---- Raw fetch results (pre-graph-shape) --------------------------------

/** One row parsed off a SEBI circular listing page, before detail fetch. */
export interface ListingEntry {
  detailUrl: string; // absolute URL to the circular's detail/PDF-index page
  listingTitle: string; // title text as shown in the listing row
  listingDateText: string; // raw date string as shown in the listing (unparsed)
  listingCategoryHint: string; // category/department column text, if present
}

/** Result of fetching + canonicalizing one circular's detail page. */
export interface FetchedCircularPage {
  detailUrl: string;
  rawHtml: string; // full HTML as fetched, retained for audit/debug only
  canonicalText: string; // cleaned body text used for hashing + chunking (see FR-11)
  sourceHash: string; // sha256(canonicalText), maps to Circular.source_hash
  fetchedAt: string; // ISO datetime
}

// ---- Candidates proposed to the Orchestrator -----------------------------

/**
 * A candidate Circular node. All Bitemporal + Circular fields except
 * circular_id/recorded_at are derived from the fetched page; circular_id is
 * generated client-side (uuid v4) since dedupe is keyed on source_hash, not
 * on id. recorded_at is left for the persistence layer (Spec 01) to stamp
 * at actual write time, since "recorded_at" must reflect when the fact was
 * asserted into the graph, not when Watch merely proposed it.
 */
export interface CircularCandidate extends Omit<Circular, "recorded_at"> {
  recorded_at: null; // stamped by the persistence layer on commit
}

/**
 * A candidate Clause node. clause_id is generated client-side (uuid v4);
 * embedding_ref is intentionally left empty — Watch does not compute
 * embeddings (see §1, Out of scope; §13 open question on ownership).
 */
export interface ClauseCandidate extends Omit<Clause, "recorded_at" | "embedding_ref"> {
  recorded_at: null;
  embedding_ref: ""; // populated at persistence time, not by Watch
}

export type ChangeType = "new" | "amendment" | "unchanged";

/**
 * Structured hint about which existing circular/paragraph a newly detected
 * page appears to amend. Confidence-scored because the extraction is
 * regex/heuristic, not a legal parse — see FR-16..FR-19.
 */
export interface AmendmentContext {
  /** Best-guess circular_id of the instrument being amended, if resolved. */
  targetCircularId: string | null;
  /** Free-text match used to resolve targetCircularId, for audit/debug. */
  targetMatchedOnTitle: string | null;
  /** para_ref values (e.g. "46") the amendment text says it changes. */
  amendedParaRefs: string[];
  /** 0..1 heuristic confidence in targetCircularId + amendedParaRefs. */
  confidence: number;
}

/** One full cron tick's worth of listing-page work. */
export interface PollRun {
  pollRunId: string; // uuid v4
  startedAt: string; // ISO datetime
  finishedAt: string | null;
  listingUrlsPolled: string[];
  entriesSeen: number;
  triggersEmitted: number;
  errors: PollError[];
}

export interface PollError {
  stage: "listing_fetch" | "detail_fetch" | "clean_chunk" | "change_detect" | "trigger_emit";
  detailUrl: string | null;
  message: string;
  occurredAt: string;
}

// ---- Trigger event handed to the Orchestrator ----------------------------

export interface RegulatoryWatchTriggerEvent {
  eventId: string; // uuid v4, idempotency key for this specific trigger
  pollRunId: string; // uuid v4, correlates to the PollRun that produced it
  emittedAt: string; // ISO datetime
  changeType: Exclude<ChangeType, "unchanged">; // "unchanged" never triggers
  circular: CircularCandidate;
  clauses: ClauseCandidate[];
  amendmentContext: AmendmentContext | null; // present only when changeType === "amendment"
}

// ---- Ops alert emitted on selector/structural failure --------------------

export interface WatchOpsAlert {
  alertId: string; // uuid v4
  severity: "warning" | "critical";
  kind: "selector_mismatch" | "upstream_unavailable" | "concurrent_run_skipped";
  detailUrl: string | null;
  message: string;
  pollRunId: string;
  occurredAt: string;
}
