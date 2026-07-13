// Postgres pool singleton + env config, mirroring
// packages/graph-db/src/driver.ts's pattern (getDriver()/closeDriver()/
// verifyConnectivity()) for the equivalent Postgres role in this package.
import { Pool, type PoolConfig, types } from "pg";
import { AuditLedgerUnavailableError } from "./errors.js";

// FR-30(e)'s entry_hash formula hashes the literal `timestamp` string
// captured at insert time. node-postgres's default type parser turns a
// TIMESTAMPTZ column into a JS `Date`, which only has millisecond
// precision — re-serializing that Date with `.toISOString()` on a later
// read would not bit-for-bit reproduce a microsecond-precision Postgres
// timestamp, silently breaking every `entry_hash`/`prev_entry_hash`
// verification. Overriding the TIMESTAMPTZ (OID 1184) type parser to
// return Postgres's own raw text representation instead avoids that
// lossy round trip entirely — the exact string used to compute the hash
// at append time is the exact string read back later, byte for byte.
// See append()/verifyChainIntegrity() in postgres-audit-ledger.ts.
const TIMESTAMPTZ_OID = 1184;
types.setTypeParser(TIMESTAMPTZ_OID, (value: string) => value);

export interface AuditLedgerDbConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  max?: number; // pool size, default 10
  connectionTimeoutMillis?: number; // default 5000
}

const DEFAULT_POOL_SIZE = 10;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;

let singleton: Pool | undefined;

/** Creates a brand-new Pool from an explicit config. Does not memoize —
 *  use `getPool()` for the process-wide singleton. Mainly useful for
 *  tests and the migration CLI that want a pool bound to a specific
 *  config without touching the module-level singleton. Every pool this
 *  package creates pins the session timezone to UTC so the raw-text
 *  TIMESTAMPTZ round trip above is deterministic across restarts/hosts,
 *  not dependent on the server's local `timezone` GUC. */
export function createPool(config: AuditLedgerDbConfig): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max ?? DEFAULT_POOL_SIZE,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    options: "-c TimeZone=UTC"
  };
  return new Pool(poolConfig);
}

function readConfigFromEnv(): AuditLedgerDbConfig {
  const connectionString = process.env.SENTINEL_AUDIT_LEDGER_DATABASE_URL;
  if (!connectionString) {
    throw new AuditLedgerUnavailableError("Missing required env var: SENTINEL_AUDIT_LEDGER_DATABASE_URL must be set.");
  }
  return { connectionString };
}

/** Reads SENTINEL_AUDIT_LEDGER_DATABASE_URL, memoized singleton across
 *  the process. */
export function getPool(): Pool {
  if (singleton) {
    return singleton;
  }
  singleton = createPool(readConfigFromEnv());
  return singleton;
}

export async function closePool(): Promise<void> {
  if (singleton) {
    await singleton.end();
    singleton = undefined;
  }
}

/** Throws AuditLedgerUnavailableError if the pool cannot reach the
 *  database. Intended to be called once at process startup so
 *  connectivity failures fail fast with a clear error. */
export async function verifyConnectivity(pool?: Pool): Promise<void> {
  const target = pool ?? getPool();
  try {
    const client = await target.connect();
    client.release();
  } catch (error) {
    throw new AuditLedgerUnavailableError("Unable to connect to Postgres — connectivity check failed.", { cause: error });
  }
}
