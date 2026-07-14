// Spec 15 §10 Test Plan / §11 Task 12 — ci/health-endpoints.integration.test.ts
// (this exact path/name is the spec's own worked example). Boots the real
// apps/orchestrator HTTP server (src/server/http-server.ts, unmodified)
// against REAL neo4j:5-community / postgres:16 containers (via
// Testcontainers — see §4.1b's architecture-correction note: this repo
// uses Testcontainers everywhere for integration tests, not static CI
// service containers), and asserts:
//   - GET /healthz returns 200 immediately (before verifying either
//     container is even reachable — FR-33: liveness never touches a
//     dependency).
//   - GET /readyz returns 200 once both containers are healthy.
//   - GET /readyz returns 503 if the Neo4j container is stopped mid-test
//     (simulating an outage), per this spec's own Test Plan wording.
// apps/web-console's GET /api/health handler (app/api/health/route.ts) is
// exercised too, by importing and calling it directly (a Next.js Route
// Handler is just an async function — no need to boot a full `next dev`/
// `next start` process for this) with ORCHESTRATOR_BASE_URL pointed at
// the same real orchestrator server above, proving the two apps'
// contracts compose end to end, not just each in isolation.
//
// ***** Sandbox limitation — this file could not be executed in the
// ***** environment it was authored in (same documented gap as
// ***** packages/graph-db's assistant-templates.integration.test.ts and
// ***** this repo's docker-compose.yml/Dockerfile): no `docker` binary
// ***** and no Docker socket were available here (confirmed: `which
// ***** docker` -> not found). @testcontainers/neo4j and
// ***** @testcontainers/postgresql are real devDependencies (root
// ***** package.json, added alongside this file), and this test follows
// ***** the exact same harness pattern already working elsewhere in this
// ***** repo — but it has NOT been run against live containers as part
// ***** of this task, and could not be. Whoever next has Docker
// ***** available should run `pnpm test:ci-health-endpoints` and treat a
// ***** failure here as a real bug, not a flake.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const CONTAINER_STARTUP_TIMEOUT_MS = 180_000;

describe("ci/health-endpoints.integration — apps/orchestrator + apps/web-console", () => {
  let neo4jContainer: StartedNeo4jContainer;
  let postgresContainer: StartedPostgreSqlContainer;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    neo4jContainer = await new Neo4jContainer("neo4j:5.23-community").withPassword("sentinel-test-pw").start();
    postgresContainer = await new PostgreSqlContainer("postgres:16-alpine").start();

    process.env.SENTINEL_NEO4J_URI = neo4jContainer.getBoltUri();
    process.env.SENTINEL_NEO4J_USER = neo4jContainer.getUsername();
    process.env.SENTINEL_NEO4J_PASSWORD = neo4jContainer.getPassword();
    process.env.SENTINEL_NEO4J_DATABASE = "neo4j";
    process.env.SENTINEL_AUDIT_LEDGER_DATABASE_URL = postgresContainer.getConnectionUri();
    process.env.HEALTH_CHECK_TIMEOUT_MS = "5000";

    // Imported dynamically, AFTER the env vars above are set — both
    // @sentinel-act/graph-db's and @sentinel-act/audit-ledger's
    // getDriver()/getPool() singletons read process.env exactly once, at
    // first call, so a static top-of-file import would race the env
    // assignment above.
    const { createHttpServer } = await import("../apps/orchestrator/src/server/http-server.js");
    server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    server?.close();
    await postgresContainer?.stop();
    await neo4jContainer?.stop();
  });

  it("GET /healthz returns 200 (liveness only, FR-33)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("orchestrator");
    expect(body.checks).toBeUndefined();
  });

  it("GET /readyz returns 200 once both containers are healthy (FR-34)", async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.neo4j.status).toBe("ok");
    expect(body.checks.postgres.status).toBe("ok");
  });

  it("apps/web-console's GET /api/health reports ok when the real orchestrator is reachable (FR-35)", async () => {
    process.env.ORCHESTRATOR_BASE_URL = baseUrl;
    const { GET } = await import("../apps/web-console/app/api/health/route.js");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks.orchestrator.status).toBe("ok");
  });

  it("GET /readyz returns 503 if the Neo4j container is stopped mid-test (§10's exact worked example)", async () => {
    await neo4jContainer.stop();
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("down");
    expect(body.checks.neo4j.status).toBe("down");
  }, 15_000);
});
