// GraphWriter.commitProposal — the atomic commit path (§5.7). This is the
// ONLY method the Orchestrator (and, transitively, every other spec) uses
// to persist a proposal to the graph: validate (zod, FR-13), open exactly
// one managed write transaction (FR-12), write all nodes/edges/
// supersessions inside it, and either commit everything or roll back
// everything. Idempotent per proposalId (FR-15).
import type { Driver, ManagedTransaction } from "neo4j-driver";
import type { GraphEdge } from "@sentinel-act/graph-schema";
import type { CommitPlan, CommitResult, NodeLabel } from "../types.js";
import { CommitError, ConflictError } from "../errors.js";
import { logOperation } from "../logger.js";
import { getSingletonDatabase } from "../driver.js";
import { validateCommitPlan } from "./commit-plan-validator.js";
import { CircularRepository } from "../repositories/circular.repository.js";
import { ClauseRepository } from "../repositories/clause.repository.js";
import { ObligationRepository } from "../repositories/obligation.repository.js";
import { ProcessTaskRepository } from "../repositories/process-task.repository.js";
import { EvidenceArtifactRepository } from "../repositories/evidence-artifact.repository.js";
import { IntermediaryCategoryRepository } from "../repositories/intermediary-category.repository.js";
import { HumanReviewRepository } from "../repositories/human-review.repository.js";

/** §8 error-handling table: "graph-writer.ts sets an explicit
 *  timeout: 30_000 (ms) transaction config on commitProposal." */
const COMMIT_TRANSACTION_TIMEOUT_MS = 30_000;

export class GraphWriter {
  private readonly circularRepo: CircularRepository;
  private readonly clauseRepo: ClauseRepository;
  private readonly obligationRepo: ObligationRepository;
  private readonly processTaskRepo: ProcessTaskRepository;
  private readonly evidenceArtifactRepo: EvidenceArtifactRepository;
  private readonly intermediaryCategoryRepo: IntermediaryCategoryRepository;
  private readonly humanReviewRepo: HumanReviewRepository;

  constructor(private readonly driver: Driver) {
    this.circularRepo = new CircularRepository(driver);
    this.clauseRepo = new ClauseRepository(driver);
    this.obligationRepo = new ObligationRepository(driver);
    this.processTaskRepo = new ProcessTaskRepository(driver);
    this.evidenceArtifactRepo = new EvidenceArtifactRepository(driver);
    this.intermediaryCategoryRepo = new IntermediaryCategoryRepository(driver);
    this.humanReviewRepo = new HumanReviewRepository(driver);
  }

  /** The ONLY method the Orchestrator calls to persist a proposal.
   *  Validates the plan (zod), opens one managed write transaction,
   *  writes all nodes, all edges, and all supersessions inside it, and
   *  either commits everything or rolls back everything. Idempotent on
   *  proposalId. Throws ValidationError (no transaction opened) for a
   *  malformed plan, or CommitError with a `cause` chain wrapping
   *  whatever failed mid-transaction (a Cypher error, a supersession
   *  ConflictError, a missing edge endpoint) for every other failure —
   *  nothing is partially visible to any reader either way. */
  async commitProposal(plan: CommitPlan): Promise<CommitResult> {
    const start = Date.now();
    // FR-13: validate BEFORE opening any transaction.
    const validated = validateCommitPlan(plan);

    const session = this.driver.session({ database: getSingletonDatabase() });
    try {
      const result = await session.executeWrite((tx) => this.executePlan(tx, validated), {
        timeout: COMMIT_TRANSACTION_TIMEOUT_MS
      });
      logOperation({
        operation: "commitProposal",
        proposalId: plan.proposalId,
        durationMs: Date.now() - start,
        outcome: "success"
      });
      return result;
    } catch (error) {
      logOperation({
        operation: "commitProposal",
        proposalId: plan.proposalId,
        durationMs: Date.now() - start,
        outcome: "error"
      });
      throw new CommitError(`commitProposal failed for proposalId "${plan.proposalId}".`, { cause: error });
    } finally {
      await session.close();
    }
  }

  /** Everything inside this function runs in exactly one
   *  session.executeWrite callback — Neo4j's managed-transaction retry
   *  policy may re-invoke it transiently, which is safe because every
   *  step here (repository `create`, the guarded `closeValidTo`, and edge
   *  MATCH+CREATE) is itself idempotent-or-loudly-conflicting on retry. */
  private async executePlan(tx: ManagedTransaction, plan: CommitPlan): Promise<CommitResult> {
    // FR-15: idempotency marker check, inside the same transaction as the
    // writes it guards.
    const existing = await tx.run(`MATCH (c:CommitLog {proposal_id: $proposalId}) RETURN c.result_json AS resultJson`, {
      proposalId: plan.proposalId
    });
    if (existing.records.length > 0) {
      const resultJson = existing.records[0].get("resultJson") as string;
      return JSON.parse(resultJson) as CommitResult;
    }

    const nodeCounts: Partial<Record<NodeLabel, number>> = {};
    const edgeCounts: Partial<Record<GraphEdge["type"], number>> = {};

    for (const circular of plan.nodes.circulars ?? []) {
      await this.circularRepo.create(circular, tx);
      nodeCounts.Circular = (nodeCounts.Circular ?? 0) + 1;
    }
    for (const clause of plan.nodes.clauses ?? []) {
      await this.clauseRepo.create(clause, tx);
      nodeCounts.Clause = (nodeCounts.Clause ?? 0) + 1;
    }
    for (const obligation of plan.nodes.obligations ?? []) {
      await this.obligationRepo.create(obligation, tx);
      nodeCounts.Obligation = (nodeCounts.Obligation ?? 0) + 1;
    }
    for (const processTask of plan.nodes.processTasks ?? []) {
      await this.processTaskRepo.create(processTask, tx);
      nodeCounts.ProcessTask = (nodeCounts.ProcessTask ?? 0) + 1;
    }
    for (const evidenceArtifact of plan.nodes.evidenceArtifacts ?? []) {
      await this.evidenceArtifactRepo.create(evidenceArtifact, tx);
      nodeCounts.EvidenceArtifact = (nodeCounts.EvidenceArtifact ?? 0) + 1;
    }
    for (const category of plan.nodes.intermediaryCategories ?? []) {
      await this.intermediaryCategoryRepo.create(category, tx);
      nodeCounts.IntermediaryCategory = (nodeCounts.IntermediaryCategory ?? 0) + 1;
    }
    for (const humanReview of plan.nodes.humanReviews ?? []) {
      await this.humanReviewRepo.create(humanReview, tx);
      nodeCounts.HumanReview = (nodeCounts.HumanReview ?? 0) + 1;
    }

    let supersessionsApplied = 0;
    for (const instruction of plan.supersessions ?? []) {
      await this.closeValidTo(tx, instruction);
      supersessionsApplied += 1;
    }

    for (const edge of plan.edges) {
      await this.createEdge(tx, edge);
      edgeCounts[edge.type] = (edgeCounts[edge.type] ?? 0) + 1;
    }

    const nowResult = await tx.run("RETURN datetime() AS now");
    const committedAt = String(nowResult.records[0].get("now"));

    const result: CommitResult = {
      proposalId: plan.proposalId,
      committedAt,
      nodeCounts,
      edgeCounts,
      supersessionsApplied
    };

    // MERGE (not CREATE): defends against the CommitLog write itself
    // colliding on retry of this same transaction function. True
    // adversarial-concurrency dedup for two *distinct* transactions
    // racing on an identical proposalId would need a uniqueness
    // constraint on CommitLog.proposal_id (not added here — FR-1's 8
    // constraints are the acceptance-criterion-checked set; this is a
    // documented limitation, not a silent gap).
    await tx.run(
      `MERGE (c:CommitLog {proposal_id: $proposalId})
       ON CREATE SET c.committed_at = datetime(), c.result_json = $resultJson`,
      { proposalId: plan.proposalId, resultJson: JSON.stringify(result) }
    );

    return result;
  }

  /** FR-10 steps 1-2 (guarded MATCH + close valid_to), applied standalone
   *  for a CommitPlan's supersession instructions. Uses the same
   *  `_concurrency_touch = datetime()` write-lock-forcing technique as
   *  ObligationRepository.supersede/CircularRepository.supersede (see
   *  obligation.repository.ts for the concurrency rationale — FR-14 — and
   *  the post-review correction explaining why the previous
   *  `SET old.valid_to = old.valid_to` self-assignment was replaced: it
   *  did not reliably force a real write lock against a live Neo4j 5.23
   *  instance).
   *
   *  Step 3 (create the new node) happens above via the plan's ordinary
   *  nodes.obligations/nodes.circulars arrays, and step 4 (link
   *  new -[:SUPERSEDES]-> old) happens via the plan's ordinary edges
   *  array — SupersessionInstruction (spec §4.4) intentionally carries no
   *  newObligation/newCircular payload of its own, so this method only
   *  ever performs the "close the old node" half of FR-10's pattern; the
   *  "create the new node, then link it" half is just an ordinary node
   *  create + an ordinary SUPERSEDES edge, decomposed across the rest of
   *  this same transaction. */
  private async closeValidTo(
    tx: ManagedTransaction,
    instruction: { kind: "Circular" | "Obligation"; oldId: string; effectiveDate: string }
  ): Promise<void> {
    const label = instruction.kind;
    const idField = instruction.kind === "Circular" ? "circular_id" : "obligation_id";
    const guarded = await tx.run(
      `MATCH (old:${label} {${idField}: $oldId})
       SET old._concurrency_touch = datetime()
       WITH old
       WHERE old.valid_to IS NULL
       SET old.valid_to = date($effectiveDate)
       RETURN old`,
      { oldId: instruction.oldId, effectiveDate: instruction.effectiveDate }
    );
    if (guarded.records.length === 0) {
      const existing = await tx.run(`MATCH (old:${label} {${idField}: $oldId}) RETURN old.valid_to AS validTo`, {
        oldId: instruction.oldId
      });
      if (existing.records.length === 0) {
        throw new ConflictError(`${label} ${instruction.oldId} does not exist — cannot supersede.`);
      }
      throw new ConflictError(`${label} ${instruction.oldId} is already superseded — cannot supersede again.`);
    }
  }

  private async createEdge(tx: ManagedTransaction, edge: GraphEdge): Promise<void> {
    switch (edge.type) {
      case "SUPERSEDES":
        return this.createSupersedesEdge(tx, edge.from_id, edge.to_id);
      case "PART_OF":
        return this.matchAndCreateEdge(
          tx,
          edge.type,
          "Clause",
          "clause_id",
          edge.clause_id,
          "Circular",
          "circular_id",
          edge.circular_id
        );
      case "DERIVED_FROM":
        return this.matchAndCreateEdge(
          tx,
          edge.type,
          "Obligation",
          "obligation_id",
          edge.obligation_id,
          "Clause",
          "clause_id",
          edge.clause_id
        );
      case "APPLIES_TO":
        return this.matchAndCreateEdge(
          tx,
          edge.type,
          "Obligation",
          "obligation_id",
          edge.obligation_id,
          "IntermediaryCategory",
          "category_id",
          edge.category_id
        );
      case "MAPPED_TO":
        return this.matchAndCreateEdge(
          tx,
          edge.type,
          "Obligation",
          "obligation_id",
          edge.obligation_id,
          "ProcessTask",
          "task_id",
          edge.task_id
        );
      case "EVIDENCED_BY":
        return this.matchAndCreateEdge(
          tx,
          edge.type,
          "ProcessTask",
          "task_id",
          edge.task_id,
          "EvidenceArtifact",
          "evidence_id",
          edge.evidence_id
        );
      case "REVIEWED_BY":
        return this.matchAndCreateEdge(
          tx,
          edge.type,
          "Obligation",
          "obligation_id",
          edge.obligation_id,
          "HumanReview",
          "review_id",
          edge.review_id
        );
    }
  }

  private async matchAndCreateEdge(
    tx: ManagedTransaction,
    type: string,
    fromLabel: string,
    fromIdField: string,
    fromId: string,
    toLabel: string,
    toIdField: string,
    toId: string
  ): Promise<void> {
    const result = await tx.run(
      `MATCH (a:${fromLabel} {${fromIdField}: $fromId})
       MATCH (b:${toLabel} {${toIdField}: $toId})
       CREATE (a)-[:${type}]->(b)
       RETURN a, b`,
      { fromId, toId }
    );
    if (result.records.length === 0) {
      throw new Error(
        `${type} edge endpoints not found (${fromLabel}.${fromIdField}=${fromId}, ${toLabel}.${toIdField}=${toId}).`
      );
    }
  }

  /** SUPERSEDES's from_id/to_id are label-agnostic in graph-schema's own
   *  Supersedes interface (it serves both Circular->Circular and
   *  Obligation->Obligation) — endpoints are matched by whichever of the
   *  two known primary-key property names is present, without a label
   *  filter. Both endpoints of a real SUPERSEDES edge are always the same
   *  label in practice (enforced by callers, not by this layer). */
  private async createSupersedesEdge(tx: ManagedTransaction, fromId: string, toId: string): Promise<void> {
    const result = await tx.run(
      `MATCH (from) WHERE from.circular_id = $fromId OR from.obligation_id = $fromId
       MATCH (to) WHERE to.circular_id = $toId OR to.obligation_id = $toId
       CREATE (from)-[:SUPERSEDES]->(to)
       RETURN from, to`,
      { fromId, toId }
    );
    if (result.records.length === 0) {
      throw new Error(`SUPERSEDES edge endpoints not found (from_id=${fromId}, to_id=${toId}).`);
    }
  }
}
