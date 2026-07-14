// Spec 15 §5.3/FR-33/FR-34 — GET /healthz and GET /readyz. Both excluded
// from any auth middleware (FR-36; enforced in http-server.ts's dispatch,
// which checks these two paths before assertServiceAuth is ever called on
// any other route).
//
// /healthz: liveness only, per FR-33 — MUST NOT touch Neo4j, Postgres, the
// model provider, Slack, or GRC. A process that can answer this at all is
// "alive"; this file's handleHealthz never imports @sentinel-act/graph-db
// or @sentinel-act/audit-ledger's driver/pool getters for that reason.
//
// /readyz: FR-34 — actively pings Neo4j (`RETURN 1`) and Postgres
// (`SELECT 1`) with a bounded timeout, 200 if both succeed, 503 if either
// fails/times out. Both dependency getters (`getDriver()`/`getPool()`)
// throw synchronously if their required env vars are missing (see each
// package's driver.ts) rather than returning a rejected promise — caught
// below so a missing-env-var misconfiguration reports as `status: "down"`
// on this endpoint (the whole point of /readyz) rather than crashing the
// request handler.
import { getDriver, getSingletonDatabase } from "@sentinel-act/graph-db";
import { getPool } from "@sentinel-act/audit-ledger";
import { resolveVersion, timedCheck, type HealthCheckResponse } from "./health-types.js";

// resolveVersion()'s default already assumes this app's permanently
// "0.0.0" package.json version (FR-39) — see health-types.ts's doc
// comment for why this deliberately does not read package.json off disk.
const VERSION = resolveVersion();

export function buildHealthzResponse(): HealthCheckResponse {
  return {
    status: "ok",
    service: "orchestrator",
    version: VERSION,
    timestamp: new Date().toISOString()
  };
}

async function checkNeo4j(): Promise<void> {
  const driver = getDriver();
  const session = driver.session({ database: getSingletonDatabase() });
  try {
    await session.run("RETURN 1");
  } finally {
    await session.close();
  }
}

async function checkPostgres(): Promise<void> {
  const pool = getPool();
  await pool.query("SELECT 1");
}

/** Returns both the response body and the HTTP status http-server.ts
 *  should send (200 if both dependencies are up, 503 otherwise) — kept
 *  as one function so the route handler can't accidentally send 200
 *  with a `status: "down"` body or vice versa. */
export async function buildReadyzResult(): Promise<{ httpStatus: 200 | 503; body: HealthCheckResponse }> {
  const [neo4j, postgres] = await Promise.all([
    timedCheck("neo4j", checkNeo4j),
    timedCheck("postgres", checkPostgres)
  ]);
  const checks = { neo4j, postgres };
  const allOk = neo4j.status === "ok" && postgres.status === "ok";
  return {
    httpStatus: allOk ? 200 : 503,
    body: {
      status: allOk ? "ok" : "down",
      service: "orchestrator",
      version: VERSION,
      timestamp: new Date().toISOString(),
      checks
    }
  };
}
