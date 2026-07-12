// Neo4j driver singleton + env config (§5.2). Repositories MUST NOT open
// their own Driver — they all take a Driver (or Session/ManagedTransaction)
// injected from here (NFR-2).
import neo4j, { type Driver } from "neo4j-driver";
import { GraphDbUnavailableError } from "./errors.js";

export interface GraphDbConfig {
  uri: string; // e.g. neo4j+s://<id>.databases.neo4j.io (Aura) or bolt://localhost:7687 (local)
  username: string;
  password: string;
  database?: string; // default "neo4j"
  maxConnectionPoolSize?: number; // default 50
  connectionTimeoutMs?: number; // default 5000
}

const DEFAULT_DATABASE = "neo4j";
const DEFAULT_MAX_CONNECTION_POOL_SIZE = 50;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;

let singleton: Driver | undefined;
let singletonDatabase: string = DEFAULT_DATABASE;

/** Creates a brand-new Driver from an explicit config. Does not memoize —
 *  use `getDriver()` for the process-wide singleton. Mainly useful for
 *  tests and the seed/migration CLIs that want a driver bound to a
 *  specific config without touching the module-level singleton. */
export function createDriver(config: GraphDbConfig): Driver {
  return neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
    maxConnectionPoolSize: config.maxConnectionPoolSize ?? DEFAULT_MAX_CONNECTION_POOL_SIZE,
    connectionTimeout: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS
  });
}

function readConfigFromEnv(): GraphDbConfig {
  const uri = process.env.SENTINEL_NEO4J_URI;
  const username = process.env.SENTINEL_NEO4J_USER;
  const password = process.env.SENTINEL_NEO4J_PASSWORD;
  const database = process.env.SENTINEL_NEO4J_DATABASE ?? DEFAULT_DATABASE;

  if (!uri || !username || password === undefined) {
    throw new GraphDbUnavailableError(
      "Missing required env vars: SENTINEL_NEO4J_URI, SENTINEL_NEO4J_USER, SENTINEL_NEO4J_PASSWORD must all be set."
    );
  }

  return { uri, username, password, database };
}

/** Reads SENTINEL_NEO4J_URI / _USER / _PASSWORD / _DATABASE env vars,
 *  memoized singleton across the process. */
export function getDriver(): Driver {
  if (singleton) {
    return singleton;
  }
  const config = readConfigFromEnv();
  singletonDatabase = config.database ?? DEFAULT_DATABASE;
  singleton = createDriver(config);
  return singleton;
}

/** The default database name the `getDriver()` singleton was configured
 *  with (from SENTINEL_NEO4J_DATABASE). Repositories use this when
 *  opening sessions off the singleton driver. */
export function getSingletonDatabase(): string {
  return singletonDatabase;
}

export async function closeDriver(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = undefined;
    singletonDatabase = DEFAULT_DATABASE;
  }
}

/** Throws GraphDbUnavailableError if the driver cannot reach the
 *  database. Intended to be called once at process startup so
 *  connectivity failures fail fast with a clear error. */
export async function verifyConnectivity(driver?: Driver): Promise<void> {
  const target = driver ?? getDriver();
  try {
    await target.verifyConnectivity();
  } catch (error) {
    throw new GraphDbUnavailableError("Unable to connect to Neo4j — verifyConnectivity failed.", {
      cause: error
    });
  }
}
