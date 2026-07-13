// Read-only contradiction-candidate lookup for the Grounding and
// Verification Agent (Spec 04 §4, §5, §11 task 2). Opens a session via
// `driver.session(...)` and calls ONLY `session.executeRead(...)` — never
// `executeWrite` — and this file never emits a write-Cypher keyword
// (CREATE, MERGE, SET, DELETE), enforced as defense in depth against a
// prompt-injection attempt embedded in clause text (§7 NFR "Read-only
// graph access").
//
// Per Spec 04 §0 "Do not invent your own Neo4j connection/pooling code
// here; per Spec 04 §3, that setup belongs to Spec 01" — this reuses
// @sentinel-act/graph-db's getDriver()/getSingletonDatabase() singleton,
// exactly like tools/graphrag.tools.ts does for Spec 03.
//
// Deterministic-retrieval note (mirrors Spec 03's FR-2 convention,
// implemented in graphrag.tools.ts): grounding-verification.agent.ts's
// verifyGrounding() always calls runContradictionLookup() directly, up
// front, before the LLM call — it does not rely on the model's own
// tool-calling discretion to decide whether to look up candidates (FR-9
// requires the lookup to always happen). The Mastra `Tool` wrapper below
// exists so the Agent definition can still list it per spec §5, but the
// primary code path calls the plain async function directly, which is
// what makes the "assert on the params object passed to run()" unit test
// (§10) possible without a live model call.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getDriver, getSingletonDatabase } from "@sentinel-act/graph-db";

type Neo4jDriver = ReturnType<typeof getDriver>;
type Neo4jSession = ReturnType<Neo4jDriver["session"]>;

async function withReadSession<T>(driver: Neo4jDriver, work: (session: Neo4jSession) => Promise<T>): Promise<T> {
  const session = driver.session({ database: getSingletonDatabase() });
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

export const ContradictionCandidateSchema = z.object({
  obligation_id: z.string(),
  category: z.string(),
  requirement_text: z.string(),
  trigger_event: z.string(),
  deadline_rule: z.string(),
  responsible_role: z.string(),
  penalty_ref: z.string().nullable(),
  status: z.string(),
  source_para_ref: z.string().nullable(),
  source_circular_title: z.string().nullable()
});

export type ContradictionCandidate = z.infer<typeof ContradictionCandidateSchema>;

export interface ContradictionLookupParams {
  responsible_role: string;
  category: string;
  trigger_event: string;
  /** Non-null only for re-verification runs (§8 "duplicate event") —
   *  excludes a prior *proposed-but-not-yet-committed* Obligation for the
   *  same clause so the contradiction check does not flag the new
   *  proposal against its own stale predecessor. A brand-new proposal
   *  (FR-9's normal case) always passes `null` here. */
  exclude_obligation_id: string | null;
  /** ISO date string. FR-9: sourced from
   *  GroundingVerificationInput.source.circular.date_effective, falling
   *  back to today's date if that is null — never the proposed
   *  Obligation's `valid_from` (ProposedObligation deliberately excludes
   *  the bitemporal triple, see grounding-verification.types.ts). */
  as_of: string;
}

// §4 Cypher query shape, verbatim. A candidate-retrieval query only —
// deliberately permissive (substring overlap on trigger_event, since
// trigger events are free-text extracted by Spec 03 and won't always
// match verbatim). `category` and `responsible_role` are matched exactly
// (controlled/near-controlled vocabulary). `status IN
// ["tier_a_committed", "committed"]` restricts to Obligations that are
// actually live governance facts, not other in-flight proposals (§8
// "Concurrent write" — a known, explicitly flagged gap, not silently
// ignored, see Spec 04 §13).
const CONTRADICTION_LOOKUP_CYPHER = `
MATCH (o:Obligation)
WHERE o.responsible_role = $responsible_role
  AND o.category = $category
  AND o.status IN ["tier_a_committed", "committed"]
  AND o.valid_from <= date($as_of)
  AND (o.valid_to IS NULL OR o.valid_to > date($as_of))
  AND ($exclude_obligation_id IS NULL OR o.obligation_id <> $exclude_obligation_id)
  AND (
    o.trigger_event = $trigger_event
    OR toLower(o.trigger_event) CONTAINS toLower($trigger_event)
    OR toLower($trigger_event) CONTAINS toLower(o.trigger_event)
  )
OPTIONAL MATCH (o)-[:DERIVED_FROM]->(c:Clause)-[:PART_OF]->(circ:Circular)
RETURN o.obligation_id AS obligation_id,
       o.category AS category,
       o.requirement_text AS requirement_text,
       o.trigger_event AS trigger_event,
       o.deadline_rule AS deadline_rule,
       o.responsible_role AS responsible_role,
       o.penalty_ref AS penalty_ref,
       o.status AS status,
       c.para_ref AS source_para_ref,
       circ.title AS source_circular_title
ORDER BY o.recorded_at DESC
LIMIT 20
`.trim();

/** Runs the §4 Cypher query against the injected driver, read-only.
 *  Returns [] (never throws) only for "no candidates found" — a genuine
 *  Neo4j failure propagates to the caller, which (per §8's
 *  Neo4j-unavailable row) is responsible for the graceful-degradation
 *  policy, not this function. */
export async function runContradictionLookup(driver: Neo4jDriver, params: ContradictionLookupParams): Promise<ContradictionCandidate[]> {
  return withReadSession(driver, async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(CONTRADICTION_LOOKUP_CYPHER, {
        responsible_role: params.responsible_role,
        category: params.category,
        trigger_event: params.trigger_event,
        exclude_obligation_id: params.exclude_obligation_id,
        as_of: params.as_of
      })
    );
    return result.records.map((record) =>
      ContradictionCandidateSchema.parse({
        obligation_id: record.get("obligation_id"),
        category: record.get("category"),
        requirement_text: record.get("requirement_text"),
        trigger_event: record.get("trigger_event"),
        deadline_rule: record.get("deadline_rule"),
        responsible_role: record.get("responsible_role"),
        penalty_ref: record.get("penalty_ref"),
        status: record.get("status"),
        source_para_ref: record.get("source_para_ref"),
        source_circular_title: record.get("source_circular_title")
      })
    );
  });
}

// ============================================================================
// Mastra Tool wrapper (spec §5) — thin adapter over the plain function
// above, wired to the process-wide getDriver() singleton. Listed on
// groundingVerificationAgent's `tools` per §5, but not the primary
// invocation path (see file header).
// ============================================================================
export const contradictionLookupTool = createTool({
  id: "contradiction-lookup",
  description:
    "Finds currently live Obligations sharing the same responsible_role and category, " +
    "with an overlapping trigger_event, as candidates for contradiction comparison.",
  inputSchema: z.object({
    responsible_role: z.string(),
    category: z.string(),
    trigger_event: z.string(),
    exclude_obligation_id: z.string().nullable(),
    as_of: z.string()
  }),
  outputSchema: z.object({
    candidates: z.array(ContradictionCandidateSchema)
  }),
  execute: async (inputData) => {
    const candidates = await runContradictionLookup(getDriver(), inputData as ContradictionLookupParams);
    return { candidates };
  }
});
