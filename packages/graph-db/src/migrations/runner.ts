// Applies migration files idempotently, tracking applied migrations in a
// :SchemaMigration {filename, checksum, applied_at} node (FR-6). Safe to
// re-run against an already-migrated database (FR-5).
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Driver } from "neo4j-driver";
import { GraphDbSchemaError } from "../errors.js";
import { getSingletonDatabase } from "../driver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Directory this module itself lives in — the migration .cypher files
 *  ship alongside runner.ts and are read from disk at runtime (this
 *  package's CLI scripts run via tsx against src/, not a built dist/,
 *  so this resolves correctly without a separate asset-copy step). */
export const DEFAULT_MIGRATIONS_DIR = __dirname;

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
}

function checksumOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Strips `//` line comments before statement-splitting. Naively
 *  filtering out chunks that *start* with `//` after splitting on `;` (the
 *  previous approach) breaks as soon as a comment's prose contains a
 *  semicolon — e.g. "...concurrent Regulatory Watch polls; see spec
 *  §8)." in 001_constraints.cypher's header comment — because the split
 *  itself happens mid-comment, leaving a non-`//`-prefixed fragment
 *  ("see spec §8).") that gets sent to Neo4j as a bogus statement and
 *  throws a syntax error. Stripping comment text line-by-line first,
 *  *before* splitting on `;`, removes any semicolons the comment prose
 *  contains along with the comment itself, so this can't happen. (No
 *  migration file's actual Cypher content uses `//` for anything other
 *  than comments, so a plain per-line `//` cut is safe here.) */
function stripLineComments(cypher: string): string {
  return cypher
    .split("\n")
    .map((line) => {
      const commentIndex = line.indexOf("//");
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    })
    .join("\n");
}

/** Splits a .cypher file into individual statements on top-level
 *  semicolons, after comments have been stripped. The Bolt protocol (and
 *  therefore neo4j-driver's session.run) executes exactly one statement
 *  per call, so a migration file containing several
 *  `CREATE CONSTRAINT ...;` lines must be run statement-by-statement. */
function splitStatements(cypher: string): string[] {
  return stripLineComments(cypher)
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function readMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((entry) => entry.endsWith(".cypher")).sort();
}

/**
 * Applies every `*.cypher` file in `migrationsDir` (default: this
 * module's own directory) in filename-sorted order, exactly once each,
 * tracked via `:SchemaMigration` nodes.
 *
 * - A migration never before applied is executed statement-by-statement
 *   inside one write transaction, then recorded.
 * - A migration already applied with a matching checksum is skipped.
 * - A migration already applied with a *different* checksum (the file
 *   changed on disk since it was applied) throws `GraphDbSchemaError`
 *   rather than silently re-applying or silently skipping (FR-6).
 */
export async function runMigrations(
  driver: Driver,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
  database?: string
): Promise<MigrationRunResult> {
  const files = await readMigrationFiles(migrationsDir);
  const applied: string[] = [];
  const skipped: string[] = [];
  const targetDatabase = database ?? getSingletonDatabase();
  const session = driver.session({ database: targetDatabase });

  try {
    for (const filename of files) {
      const filePath = path.join(migrationsDir, filename);
      const content = await readFile(filePath, "utf-8");
      const checksum = checksumOf(content);

      const existingChecksum = await session.executeRead(async (tx) => {
        const result = await tx.run(
          "MATCH (m:SchemaMigration {filename: $filename}) RETURN m.checksum AS checksum",
          { filename }
        );
        return (result.records[0]?.get("checksum") as string | undefined) ?? null;
      });

      if (existingChecksum !== null) {
        if (existingChecksum !== checksum) {
          throw new GraphDbSchemaError(
            `Migration "${filename}" has changed on disk since it was applied ` +
              `(recorded checksum ${existingChecksum}, current checksum ${checksum}). ` +
              "Refusing to silently re-apply or skip — create a new migration file instead."
          );
        }
        skipped.push(filename);
        continue;
      }

      // Two separate transactions, not one: Neo4j hard-forbids mixing a
      // schema-modification statement (CREATE CONSTRAINT/INDEX, what every
      // statement in 001-004 *.cypher is) with an ordinary data-write
      // statement (the :SchemaMigration marker MERGE below) in the same
      // transaction — it throws
      // Neo.ClientError.Transaction.ForbiddenDueToTransactionType ("Tried
      // to execute Write query after executing Schema modification") at
      // the marker write, discovered by running this against a real
      // Neo4j 5.23 instance (mocked-driver unit tests can't catch this
      // class of bug, since the mock doesn't enforce Neo4j's own
      // transaction-type rules).
      //
      // Splitting them is safe without an explicit cross-transaction
      // rollback: every migration statement is written `IF NOT EXISTS`
      // (FR-5), so if the schema transaction commits but the process dies
      // before the marker transaction runs, the next runMigrations() call
      // just re-applies the same (already-idempotent) schema statements
      // and then successfully writes the marker — no manual cleanup
      // needed either way.
      const statements = splitStatements(content);
      await session.executeWrite(async (tx) => {
        for (const statement of statements) {
          await tx.run(statement);
        }
      });
      await session.executeWrite(async (tx) => {
        await tx.run(
          "MERGE (m:SchemaMigration {filename: $filename}) " +
            "ON CREATE SET m.checksum = $checksum, m.applied_at = datetime()",
          { filename, checksum }
        );
      });
      applied.push(filename);
    }
  } finally {
    await session.close();
  }

  return { applied, skipped };
}
