// base.repository.test.ts (spec §10): findAsOf must generate the exact
// predicate from §4.3 for every one of the six bitemporal labels.
import { describe, expect, it } from "vitest";
import { pointInTimeWhereClause } from "../../src/point-in-time.js";
import { CircularRepository } from "../../src/repositories/circular.repository.js";
import { ClauseRepository } from "../../src/repositories/clause.repository.js";
import { ObligationRepository } from "../../src/repositories/obligation.repository.js";
import { ProcessTaskRepository } from "../../src/repositories/process-task.repository.js";
import { EvidenceArtifactRepository } from "../../src/repositories/evidence-artifact.repository.js";
import { HumanReviewRepository } from "../../src/repositories/human-review.repository.js";
import { createMockDriver } from "../helpers/mock-driver.js";

const EXPECTED_PREDICATE = pointInTimeWhereClause("n", "asOfDate");

describe("BaseRepository.findAsOf", () => {
  it("generates the exact §4.3 bitemporal predicate string", () => {
    expect(EXPECTED_PREDICATE).toBe(
      "n.valid_from <= date($asOfDate) AND (n.valid_to IS NULL OR n.valid_to > date($asOfDate))"
    );
  });

  const cases: Array<{
    name: string;
    build: (driver: ReturnType<typeof createMockDriver>["driver"]) => { findAsOf: (id: string, asOfDate: string) => Promise<unknown> };
    label: string;
    idField: string;
  }> = [
    { name: "Circular", build: (d) => new CircularRepository(d), label: "Circular", idField: "circular_id" },
    { name: "Clause", build: (d) => new ClauseRepository(d), label: "Clause", idField: "clause_id" },
    { name: "Obligation", build: (d) => new ObligationRepository(d), label: "Obligation", idField: "obligation_id" },
    { name: "ProcessTask", build: (d) => new ProcessTaskRepository(d), label: "ProcessTask", idField: "task_id" },
    {
      name: "EvidenceArtifact",
      build: (d) => new EvidenceArtifactRepository(d),
      label: "EvidenceArtifact",
      idField: "evidence_id"
    },
    { name: "HumanReview", build: (d) => new HumanReviewRepository(d), label: "HumanReview", idField: "review_id" }
  ];

  it.each(cases)("$name.findAsOf embeds the exact predicate and scopes it to the primary key", async ({ build, label, idField }) => {
    const { driver, calls } = createMockDriver(() => ({ records: [] }));
    const repo = build(driver);

    await repo.findAsOf("some-id", "2026-07-05");

    expect(calls).toHaveLength(1);
    expect(calls[0].cypher).toContain(EXPECTED_PREDICATE);
    expect(calls[0].cypher).toContain(`MATCH (n:${label} {${idField}: $id})`);
    expect(calls[0].params).toEqual({ id: "some-id", asOfDate: "2026-07-05" });
  });

  it("returns null when nothing matches", async () => {
    const { driver } = createMockDriver(() => ({ records: [] }));
    const repo = new ObligationRepository(driver);
    const result = await repo.findAsOf("missing-id", "2026-07-05");
    expect(result).toBeNull();
  });
});
