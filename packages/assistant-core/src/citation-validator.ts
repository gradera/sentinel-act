// citation-validator.ts — Spec 12 §5.5, FR-18–FR-19. Builds the
// id -> {type, label, href} lookup from an AssistantGraphContext (§4.6),
// takes the intersection of the synthesis model's citedNodeIds and that
// lookup's keys, and returns Citation[] in the order the model cited them
// (deduplicated). Any id in citedNodeIds that is NOT a key in context is
// silently dropped from the citation list (never rendered as a
// broken/fake link) — this is the last line of defense against a
// hallucinated or injected citation reaching the UI. The caller
// (packages/assistant-core/src/index.ts) is responsible for the NFR-6
// warn-level anomaly log when a drop occurs; this file only decides what
// gets dropped.
import type { AssistantGraphContext } from "@sentinel-act/graph-db";
import type { Citation } from "./types.js";

const REQUIREMENT_TEXT_LABEL_MAX_LENGTH = 60;

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

/** §4.6's exact href convention — every citation type routes into Spec
 *  10's existing /audit page via its already-built searchParams filters,
 *  never a dedicated per-node detail route (none exist outside Observer
 *  mode). */
function buildCitationLookup(context: AssistantGraphContext): Map<string, Citation> {
  const lookup = new Map<string, Citation>();

  for (const circular of context.circulars) {
    lookup.set(circular.circular_id, {
      type: "Circular",
      id: circular.circular_id,
      label: `Circular: ${circular.title}`,
      href: `/audit?circularId=${circular.circular_id}`
    });
  }

  for (const clause of context.clauses) {
    lookup.set(clause.clause_id, {
      type: "Clause",
      id: clause.clause_id,
      label: `Clause ¶${clause.para_ref}`,
      // Clause has no standalone route — links to its parent Circular's
      // audit page (§4.6).
      href: `/audit?circularId=${clause.circular_id}`
    });
  }

  for (const obligation of context.obligations) {
    lookup.set(obligation.obligation_id, {
      type: "Obligation",
      id: obligation.obligation_id,
      label: `Obligation (${truncate(obligation.requirement_text, REQUIREMENT_TEXT_LABEL_MAX_LENGTH)})`,
      href: `/audit?obligationId=${obligation.obligation_id}`
    });
  }

  for (const task of context.processTasks) {
    lookup.set(task.task_id, {
      type: "ProcessTask",
      id: task.task_id,
      label: `ProcessTask: ${task.task_name}`,
      // Links to the parent Obligation's audit page via ProcessTask.obligation_id (§4.6).
      href: `/audit?obligationId=${task.obligation_id}`
    });
  }

  for (const review of context.humanReviews) {
    lookup.set(review.review_id, {
      type: "HumanReview",
      id: review.review_id,
      label: `HumanReview: ${review.decision} by ${review.reviewer_id}`,
      // Links to the reviewed Obligation's audit page via HumanReview.obligation_id (§4.6).
      href: `/audit?obligationId=${review.obligation_id}`
    });
  }

  return lookup;
}

/** §5.5: intersection of citedNodeIds and the context's real node ids,
 *  deduplicated, in the order the model cited them. Any id in
 *  citedNodeIds that is not a key in the lookup is silently dropped from
 *  the returned array (FR-18) — never rendered as a broken/fake link. The
 *  caller (index.ts) computes which ids were dropped itself (a trivial
 *  diff against citedNodeIds) when it needs that for NFR-6's warn-level
 *  hallucination/injection anomaly log; this function's return type
 *  matches §5.5's literal `Citation[]` signature exactly. */
export function buildValidatedCitations(citedNodeIds: string[], context: AssistantGraphContext): Citation[] {
  const lookup = buildCitationLookup(context);
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const id of citedNodeIds) {
    if (seen.has(id)) {
      continue; // dedup — already included once, in first-cited order
    }
    const citation = lookup.get(id);
    if (!citation) {
      continue; // FR-18: never rendered as a broken/fake link
    }
    seen.add(id);
    citations.push(citation);
  }

  return citations;
}
