// migrations/runner.test.ts (spec §10): checksum mismatch on a
// previously-applied migration file throws rather than silently
// reapplying or skipping; a new migration file is applied and recorded;
// a matching checksum is skipped. FR-5, FR-6.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/migrations/runner.js";
import { GraphDbSchemaError } from "../../src/errors.js";
import { createMockDriver, mockRecord } from "../helpers/mock-driver.js";

function checksumOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const SAMPLE_MIGRATION = "CREATE CONSTRAINT test_unique IF NOT EXISTS FOR (n:Test) REQUIRE n.id IS UNIQUE;";

describe("runMigrations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "graph-db-migrations-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("applies a new (never-before-seen) migration file and records it", async () => {
    await writeFile(path.join(dir, "001_test.cypher"), SAMPLE_MIGRATION);
    const { driver, calls } = createMockDriver((cypher) => {
      if (cypher.includes("MATCH (m:SchemaMigration")) return { records: [] };
      return { records: [] };
    });

    const result = await runMigrations(driver, dir);

    expect(result.applied).toEqual(["001_test.cypher"]);
    expect(result.skipped).toEqual([]);
    expect(calls.some((c) => c.cypher.includes("CREATE CONSTRAINT test_unique"))).toBe(true);
    expect(calls.some((c) => c.cypher.includes("MERGE (m:SchemaMigration"))).toBe(true);
  });

  it("skips an already-applied migration whose checksum matches", async () => {
    await writeFile(path.join(dir, "001_test.cypher"), SAMPLE_MIGRATION);
    const recordedChecksum = checksumOf(SAMPLE_MIGRATION);
    const { driver, calls } = createMockDriver((cypher) => {
      if (cypher.includes("MATCH (m:SchemaMigration")) {
        return { records: [mockRecord({ checksum: recordedChecksum })] };
      }
      return { records: [] };
    });

    const result = await runMigrations(driver, dir);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["001_test.cypher"]);
    // Nothing beyond the SchemaMigration lookup should have run — the
    // constraint statement itself must not be re-executed.
    expect(calls.some((c) => c.cypher.includes("CREATE CONSTRAINT test_unique"))).toBe(false);
  });

  it("throws GraphDbSchemaError when a previously-applied file's checksum no longer matches", async () => {
    await writeFile(path.join(dir, "001_test.cypher"), SAMPLE_MIGRATION);
    const { driver } = createMockDriver((cypher) => {
      if (cypher.includes("MATCH (m:SchemaMigration")) {
        return { records: [mockRecord({ checksum: "stale-checksum-from-a-different-file-version" })] };
      }
      return { records: [] };
    });

    await expect(runMigrations(driver, dir)).rejects.toBeInstanceOf(GraphDbSchemaError);
  });

  it("applies multiple files in filename-sorted order", async () => {
    await writeFile(path.join(dir, "002_second.cypher"), "CREATE INDEX second_idx IF NOT EXISTS FOR (n:B) ON (n.x);");
    await writeFile(path.join(dir, "001_first.cypher"), "CREATE INDEX first_idx IF NOT EXISTS FOR (n:A) ON (n.x);");
    const { driver } = createMockDriver((cypher) => {
      if (cypher.includes("MATCH (m:SchemaMigration")) return { records: [] };
      return { records: [] };
    });

    const result = await runMigrations(driver, dir);

    expect(result.applied).toEqual(["001_first.cypher", "002_second.cypher"]);
  });

  it("regression: a `//` comment containing a semicolon must not produce a bogus statement", async () => {
    // Reproduces the exact shape of 001_constraints.cypher's header
    // comment ("...concurrent Regulatory Watch polls; see spec §8).")
    // which, before the stripLineComments fix, got split mid-comment into
    // a fragment ("see spec §8).") that was sent to Neo4j as a statement
    // and threw a real Neo.ClientError.Statement.SyntaxError against a
    // live database — caught by manual testing, not by this suite, which
    // is exactly why this regression test exists now.
    const content = [
      "// FR-1: uniqueness constraint on the primary key of every node label,",
      "// be atomic under concurrent Regulatory Watch polls; see spec §8).",
      "CREATE CONSTRAINT circular_id_unique IF NOT EXISTS FOR (n:Circular) REQUIRE n.circular_id IS UNIQUE;"
    ].join("\n");
    await writeFile(path.join(dir, "001_test.cypher"), content);

    const statementsRun: string[] = [];
    const { driver } = createMockDriver((cypher) => {
      if (cypher.includes("MATCH (m:SchemaMigration")) return { records: [] };
      if (!cypher.startsWith("MERGE (m:SchemaMigration")) statementsRun.push(cypher.trim());
      return { records: [] };
    });

    await runMigrations(driver, dir);

    expect(statementsRun).toHaveLength(1);
    expect(statementsRun[0]).toBe("CREATE CONSTRAINT circular_id_unique IF NOT EXISTS FOR (n:Circular) REQUIRE n.circular_id IS UNIQUE");
    expect(statementsRun.some((s) => s.includes("see spec"))).toBe(false);
  });
});
