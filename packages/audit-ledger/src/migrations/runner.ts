// Applies `.sql` migration files idempotently, tracking applied
// migrations in a `schema_migrations` table. Adapted from
// packages/graph-db/src/migrations/runner.ts's pattern (Spec 07 §11
// task 3 explicitly says "reuse/adapt", not copy verbatim — that runner
// is Cypher-file-based and splits on `;` itself because the Bolt
// protocol executes one statement per call; `pg`'s simple query
// protocol (used here by passing a whole multi-statement file to
// `client.query(text)` with no parameters) natively supports a
// semicolon-separated batch of statements as one implicit transaction,
// so no fragile manual statement-splitting is needed here — critical
// because 001_ledger_table.sql's `reject_ledger_mutation()` function
// body is itself `$$`-quoted plpgsql containing internal semicolons that
// a naive split-on-`;` would corrupt).
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { AuditLedgerSchemaError } from "../errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Directory this module itself lives in — the migration `.sql` files
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

async function readMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    CHAR(64) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies every `*.sql` file in `migrationsDir` (default: this module's
 * own directory) in filename-sorted order, exactly once each, tracked
 * via a `schema_migrations` table.
 *
 * - A migration never before applied runs inside one transaction
 *   (BEGIN/COMMIT), then its checksum is recorded in the same
 *   transaction — if the migration's own SQL fails, the whole thing
 *   rolls back and no marker row is written.
 * - A migration already applied with a matching checksum is skipped.
 * - A migration already applied with a *different* checksum (the file
 *   changed on disk since it was applied) throws AuditLedgerSchemaError
 *   rather than silently re-applying or silently skipping.
 */
export async function runMigrations(pool: Pool, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationRunResult> {
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await ensureMigrationsTable(client);
    const files = await readMigrationFiles(migrationsDir);

    for (const filename of files) {
      const filePath = path.join(migrationsDir, filename);
      const content = await readFile(filePath, "utf-8");
      const checksum = checksumOf(content);

      const existing = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE filename = $1", [
        filename
      ]);

      if (existing.rows.length > 0) {
        if (existing.rows[0].checksum !== checksum) {
          throw new AuditLedgerSchemaError(
            `Migration "${filename}" has changed on disk since it was applied ` +
              `(recorded checksum ${existing.rows[0].checksum}, current checksum ${checksum}). ` +
              "Refusing to silently re-apply or skip — create a new migration file instead."
          );
        }
        skipped.push(filename);
        continue;
      }

      await client.query("BEGIN");
      try {
        // Simple-query protocol: a whole multi-statement file sent with
        // no bound parameters runs as one implicit transaction block,
        // including any $$-quoted function bodies containing their own
        // internal semicolons.
        await client.query(content);
        await client.query("INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES ($1, $2, now())", [
          filename,
          checksum
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(filename);
    }
  } finally {
    client.release();
  }

  return { applied, skipped };
}
