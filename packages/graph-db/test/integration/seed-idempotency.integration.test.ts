// Acceptance Criterion 5: re-running --scenario=cuspa-pre a second time
// leaves node counts for Circular, Clause, Obligation, ProcessTask, and
// IntermediaryCategory unchanged — no duplicates (FR-15, FR-19).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GraphWriter } from "../../src/commit/graph-writer.js";
import { buildCuspaPreAmendmentPlan } from "../../seed/fixtures/cuspa-pre-amendment.js";
import { startNeo4j, stopNeo4j, migrate, resetGraph, countNodesByLabel, type Neo4jTestContext, CONTAINER_STARTUP_TIMEOUT_MS } from "./helpers/setup.js";

const LABELS = ["Circular", "Clause", "Obligation", "ProcessTask", "IntermediaryCategory"] as const;

describe("seed idempotency (integration)", () => {
  let ctx: Neo4jTestContext;

  beforeAll(async () => {
    ctx = await startNeo4j();
    await migrate(ctx.driver);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (ctx) await stopNeo4j(ctx);
  });

  beforeEach(async () => {
    await resetGraph(ctx.driver);
  });

  it("re-running --scenario=cuspa-pre produces no duplicate nodes", async () => {
    const writer = new GraphWriter(ctx.driver);

    await writer.commitProposal(buildCuspaPreAmendmentPlan());
    const firstCounts = await Promise.all(LABELS.map((label) => countNodesByLabel(ctx.driver, label)));

    await writer.commitProposal(buildCuspaPreAmendmentPlan());
    const secondCounts = await Promise.all(LABELS.map((label) => countNodesByLabel(ctx.driver, label)));

    expect(secondCounts).toEqual(firstCounts);
    // Sanity: the first run actually created something (a no-op "unchanged"
    // assertion against two empty runs would be a false positive).
    expect(firstCounts.some((count) => count > 0)).toBe(true);
  }, CONTAINER_STARTUP_TIMEOUT_MS);
});
