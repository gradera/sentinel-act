// Second, distinct Neo4j driver singleton for the Conversational Assistant
// (Spec 12 §4.5, FR-23, NFR-3). This is deliberately isolated from
// getDriver()'s singleton in ./driver.ts — its own module-level variable,
// its own credential, and (when a scoped Neo4j role can be provisioned) a
// database-level role that physically cannot CREATE/MERGE/SET/DELETE or
// run admin procedures. This is defense-in-depth beyond Spec 10's
// app-level-only enforcement: this unit's query *parameters* (never raw
// Cypher text, per FR-7) are ultimately influenced by LLM output, so a
// third enforcement layer below the application (FR-21/FR-22) is
// warranted here specifically (NFR-3). Nothing in this file imports from
// or writes to driver.ts's `singleton` variable.
import type { Driver } from "neo4j-driver";
import { createDriver, type GraphDbConfig } from "./driver.js";
import { GraphDbUnavailableError } from "./errors.js";

const DEFAULT_DATABASE = "neo4j";

/** Explicit, documented opt-in for local/hackathon environments where a
 *  scoped read-only Neo4j role cannot be provisioned before the deadline
 *  (§13 Open Question 3). Missing assistant credentials fail fast
 *  UNLESS this flag is set to exactly "true" — the fallback this flag
 *  unlocks is always logged loudly (see logSharedCredentialFallback),
 *  never silent, and app-level enforcement (FR-21/FR-22/FR-7) still
 *  applies regardless. */
export const ALLOW_SHARED_CREDENTIAL_FALLBACK_ENV = "ASSISTANT_ALLOW_SHARED_CREDENTIAL_FALLBACK";

/** Structured log code emitted every time the shared read/write
 *  credential fallback is actually used, so the gap in the read-only
 *  enforcement layer is never silent (§13 Open Question 3). */
export const ASSISTANT_READONLY_DB_ROLE_NOT_CONFIGURED = "ASSISTANT_READONLY_DB_ROLE_NOT_CONFIGURED";

let singleton: Driver | undefined;
let singletonDatabase: string = DEFAULT_DATABASE;

function isSharedCredentialFallbackAllowed(): boolean {
  return process.env[ALLOW_SHARED_CREDENTIAL_FALLBACK_ENV] === "true";
}

/** Logs the shared-credential fallback at `error` level, every time it is
 *  used — never silently. This is a deliberate degradation from three
 *  enforcement layers to two (app-level only), not a total loss of
 *  read-only enforcement: FR-21 (executeRead-only), FR-22 (import
 *  boundary), and FR-7 (parameterized Cypher) all still hold. */
function logSharedCredentialFallback(): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      code: ASSISTANT_READONLY_DB_ROLE_NOT_CONFIGURED,
      message:
        "Falling back to the shared read/write Neo4j credential for the assistant read-only driver — " +
        "the database-level read-only enforcement layer (NFR-3) is NOT active for this process. " +
        "Relying on app-level enforcement only (FR-21 session.executeRead, FR-22 import-boundary ESLint rule, FR-7 parameterized Cypher)."
    })
  );
}

function readConfigFromEnv(): GraphDbConfig {
  const uri = process.env.SENTINEL_NEO4J_ASSISTANT_URI ?? process.env.SENTINEL_NEO4J_URI;
  const database =
    process.env.SENTINEL_NEO4J_ASSISTANT_DATABASE ?? process.env.SENTINEL_NEO4J_DATABASE ?? DEFAULT_DATABASE;

  if (!uri) {
    throw new GraphDbUnavailableError(
      "Missing required env var for the assistant read-only driver: SENTINEL_NEO4J_ASSISTANT_URI " +
        "(or SENTINEL_NEO4J_URI as a fallback) must be set."
    );
  }

  const assistantUser = process.env.SENTINEL_NEO4J_ASSISTANT_USER;
  const assistantPassword = process.env.SENTINEL_NEO4J_ASSISTANT_PASSWORD;

  if (assistantUser !== undefined && assistantPassword !== undefined) {
    return { uri, username: assistantUser, password: assistantPassword, database };
  }

  // FR-23: this driver MUST NEVER silently fall back to the app's
  // read/write credential. The only way to reach the fallback below is
  // the explicit, documented opt-in flag — and even then it is logged
  // loudly, every time, never silently (§13 Open Question 3).
  if (isSharedCredentialFallbackAllowed()) {
    const sharedUser = process.env.SENTINEL_NEO4J_USER;
    const sharedPassword = process.env.SENTINEL_NEO4J_PASSWORD;
    if (sharedUser === undefined || sharedPassword === undefined) {
      throw new GraphDbUnavailableError(
        `${ALLOW_SHARED_CREDENTIAL_FALLBACK_ENV} is set but the shared SENTINEL_NEO4J_USER/SENTINEL_NEO4J_PASSWORD ` +
          "credentials are also missing — cannot fall back."
      );
    }
    logSharedCredentialFallback();
    return { uri, username: sharedUser, password: sharedPassword, database };
  }

  throw new GraphDbUnavailableError(
    "Missing required env vars for the assistant read-only driver: SENTINEL_NEO4J_ASSISTANT_USER and " +
      "SENTINEL_NEO4J_ASSISTANT_PASSWORD must both be set. This driver never falls back to the app's " +
      "read/write credential (FR-23). If a scoped read-only Neo4j role cannot be provisioned before the " +
      `deadline, set ${ALLOW_SHARED_CREDENTIAL_FALLBACK_ENV}=true as an explicit, logged exception ` +
      "(§13 Open Question 3) — never a silent one."
  );
}

/** Distinct, memoized driver singleton for the Conversational Assistant
 *  (Spec 12 §4.5). Reads SENTINEL_NEO4J_ASSISTANT_URI (falls back to
 *  SENTINEL_NEO4J_URI if unset) and SENTINEL_NEO4J_ASSISTANT_USER /
 *  SENTINEL_NEO4J_ASSISTANT_PASSWORD (no fallback for these two — see
 *  readConfigFromEnv). Never touches or reuses getDriver()'s singleton
 *  from ./driver.ts. */
export function getAssistantReadOnlyDriver(): Driver {
  if (singleton) {
    return singleton;
  }
  const config = readConfigFromEnv();
  singletonDatabase = config.database ?? DEFAULT_DATABASE;
  singleton = createDriver(config);
  return singleton;
}

/** The database name the getAssistantReadOnlyDriver() singleton was
 *  configured with. AssistantQueryService and the vector-retrieval path
 *  use this when opening sessions off the assistant driver. */
export function getAssistantSingletonDatabase(): string {
  return singletonDatabase;
}

export async function closeAssistantReadOnlyDriver(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = undefined;
    singletonDatabase = DEFAULT_DATABASE;
  }
}
