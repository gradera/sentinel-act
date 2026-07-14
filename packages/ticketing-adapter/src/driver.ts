// Postgres pool singleton + env config, mirroring
// packages/audit-ledger/src/driver.ts's pattern exactly. Spec 13 §3
// recommends sharing Spec 07's Postgres instance rather than standing up
// a third datastore for a hackathon-scoped build — SENTINEL_TICKETING_
// DATABASE_URL is read first; if unset, this falls back to Spec 07's own
// SENTINEL_AUDIT_LEDGER_DATABASE_URL (documented explicitly here, not a
// silent default, per this package's implementation brief).
import { Pool, type PoolConfig } from "pg";
import { TicketingUnavailableError } from "./errors.js";

export interface TicketingDbConfig {
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
 *  config without touching the module-level singleton. */
export function createPool(config: TicketingDbConfig): Pool {
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

/** SENTINEL_TICKETING_DATABASE_URL first; explicit, documented fallback to
 *  SENTINEL_AUDIT_LEDGER_DATABASE_URL (Spec 13 §3's "same Postgres
 *  instance Spec 07 already requires" recommendation) — never silent: a
 *  structured log line records which env var was actually used. */
function readConfigFromEnv(): TicketingDbConfig {
  const primary = process.env.SENTINEL_TICKETING_DATABASE_URL;
  if (primary) {
    return { connectionString: primary };
  }
  const fallback = process.env.SENTINEL_AUDIT_LEDGER_DATABASE_URL;
  if (fallback) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        operation: "ticketing-driver-config",
        message: "SENTINEL_TICKETING_DATABASE_URL not set — falling back to SENTINEL_AUDIT_LEDGER_DATABASE_URL (Spec 13 §3's shared-Postgres-instance recommendation)."
      })
    );
    return { connectionString: fallback };
  }
  throw new TicketingUnavailableError(
    "Missing required env var: set SENTINEL_TICKETING_DATABASE_URL, or SENTINEL_AUDIT_LEDGER_DATABASE_URL as a documented fallback."
  );
}

/** Reads SENTINEL_TICKETING_DATABASE_URL (falling back to
 *  SENTINEL_AUDIT_LEDGER_DATABASE_URL), memoized singleton across the
 *  process. */
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

/** Throws TicketingUnavailableError if the pool cannot reach the
 *  database. Intended to be called once at process startup so
 *  connectivity failures fail fast with a clear error. */
export async function verifyConnectivity(pool?: Pool): Promise<void> {
  const target = pool ?? getPool();
  try {
    const client = await target.connect();
    client.release();
  } catch (error) {
    throw new TicketingUnavailableError("Unable to connect to Postgres — connectivity check failed.", { cause: error });
  }
}
